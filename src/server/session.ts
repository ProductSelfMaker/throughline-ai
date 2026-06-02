// src/server/session.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ActivityReader } from '../domain/types';
import { SpecStore } from '../core/spec-store';
import { IngestStore } from '../core/ingest-store';
import { Debouncer } from './debouncer';
import { Broadcaster } from './broadcaster';
import { buildFlowPrompt } from '../domain/flow-prompt';
import { buildSyncPrompt } from '../domain/sync-prompt';
import { buildCuratePrompt } from '../domain/curate-prompt';
import { applySpecUpdate } from '../core/apply-spec-update';

const execFileP = promisify(execFile);

async function defaultGitDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['diff', 'HEAD'], { cwd, maxBuffer: 1024 * 1024 });
    return stdout.length > 8000 ? stdout.slice(0, 8000) + '\n…(truncated)' : stdout;
  } catch {
    return '';
  }
}

// Minimal runner surface this engine needs (one-shot completion only).
interface Completer {
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
}

export interface SessionDeps {
  store: SpecStore;
  runner: Completer;
  reader: ActivityReader;
  ingest: IngestStore;
  cwd: string;
  debounceMs?: number;
  gitDiff?: (cwd: string) => Promise<string>;
}

/** Observer: reads the user's agent session logs and keeps the PRD live. */
export class Session {
  readonly broadcaster = new Broadcaster();

  private store: SpecStore;
  private runner: Completer;
  private reader: ActivityReader;
  private ingest: IngestStore;
  private cwd: string;
  private debouncer: Debouncer;
  private gitDiff: (cwd: string) => Promise<string>;
  private checkpoint: Record<string, number> = {};
  private unwatch?: () => void;

  constructor(deps: SessionDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.reader = deps.reader;
    this.ingest = deps.ingest;
    this.cwd = deps.cwd;
    this.debouncer = new Debouncer(deps.debounceMs ?? 8000);
    this.gitDiff = deps.gitDiff ?? defaultGitDiff;
  }

  /** Load the checkpoint, catch up on any unprocessed activity, then watch. */
  async init(): Promise<void> {
    this.checkpoint = await this.ingest.load();
    await this.ingestNow();
    this.unwatch = this.reader.watch(() => this.debouncer.schedule(() => { void this.ingestNow(); }));
  }

  readSpec(): Promise<string> {
    return this.store.read();
  }

  async generateFlow(signal?: AbortSignal): Promise<string> {
    const spec = await this.readSpec();
    return this.runner.complete(buildFlowPrompt(spec), signal);
  }

  /** Fold new agent activity into the PRD. Advances the checkpoint only on success. */
  private async ingestNow(): Promise<void> {
    try {
      const batch = await this.reader.readNew(this.checkpoint);
      if (!batch.excerpt.trim()) return;
      const current = await this.store.read();
      const diff = await this.gitDiff(this.cwd);
      const raw = await this.runner.complete(buildSyncPrompt(current, batch.excerpt, diff));
      const applied = await applySpecUpdate(this.store, raw, current);
      if (applied.ok) {
        this.checkpoint = { ...this.checkpoint, ...batch.advanced };
        await this.ingest.save(this.checkpoint);
        this.broadcaster.broadcast('spec-updated', applied.result);
      }
    } catch {
      // best-effort; keep the last good PRD and retry the activity next time
    }
  }

  /** Apply a user curation instruction to the PRD immediately. */
  async curate(instruction: string): Promise<void> {
    const text = instruction.trim();
    if (!text) return;
    const current = await this.store.read();
    const diff = await this.gitDiff(this.cwd);
    const raw = await this.runner.complete(buildCuratePrompt(current, text, diff));
    const applied = await applySpecUpdate(this.store, raw, current);
    if (applied.ok) this.broadcaster.broadcast('spec-updated', applied.result);
  }

  /** Run any pending ingest immediately (tests / shutdown). */
  flush(): void {
    this.debouncer.flush();
  }

  stop(): void {
    this.debouncer.cancel();
    this.unwatch?.();
  }
}
