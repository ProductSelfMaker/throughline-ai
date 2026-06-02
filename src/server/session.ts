// src/server/session.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ActivityReader, Analytics, DEFAULT_SPEC } from '../domain/types';
import { SpecStore } from '../core/spec-store';
import { IngestStore } from '../core/ingest-store';
import { Debouncer } from './debouncer';
import { Broadcaster } from './broadcaster';
import { buildFlowPrompt } from '../domain/flow-prompt';
import { buildSyncPrompt } from '../domain/sync-prompt';
import { buildCuratePrompt } from '../domain/curate-prompt';
import { buildDecisionsPrompt } from '../domain/decisions-prompt';
import { applySpecUpdate } from '../core/apply-spec-update';

const execFileP = promisify(execFile);

// Bounds for a full rebuild — re-scan recent activity only (never the whole history).
const REBUILD_DAYS = 14;
const REBUILD_MAX_CHARS = 40_000;

// Bounds for the (live) history/tokens analytics scan.
const ANALYTICS_DAYS = 30;
const ANALYTICS_MAX_BYTES = 64 * 1024 * 1024;

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
  private decisionsPath: string;
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
    this.decisionsPath = join(deps.cwd, '.throughline', 'decisions.md');
  }

  /** The latest generated decisions doc ('' if none yet). */
  async readDecisions(): Promise<string> {
    try { return existsSync(this.decisionsPath) ? await readFile(this.decisionsPath, 'utf8') : ''; }
    catch { return ''; }
  }

  private async writeDecisions(md: string): Promise<void> {
    await mkdir(dirname(this.decisionsPath), { recursive: true });
    await writeFile(this.decisionsPath, md, 'utf8');
  }

  /** Load the checkpoint; on first run observe from "now" (a long-lived project's
   *  history is far too large to ingest at once); otherwise catch up. Then watch. */
  async init(): Promise<void> {
    this.checkpoint = await this.ingest.load();
    if (Object.keys(this.checkpoint).length === 0) {
      this.checkpoint = await this.reader.currentOffsets();
      await this.ingest.save(this.checkpoint);
    } else {
      await this.ingestNow();
    }
    this.unwatch = this.reader.watch(() => this.debouncer.schedule(() => { void this.ingestNow(); }));
  }

  readSpec(): Promise<string> {
    return this.store.read();
  }

  /** Live history + token analytics over recent session logs. */
  analytics(): Promise<Analytics> {
    return this.reader.analyze(ANALYTICS_DAYS, ANALYTICS_MAX_BYTES);
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

  /** Reset & re-organize: discard the current PRD and rebuild it from a bounded
   *  window of recent activity. Then resume incremental ingest from "now". */
  async rebuild(): Promise<void> {
    const excerpt = await this.reader.readRecent(REBUILD_DAYS, REBUILD_MAX_CHARS).catch(() => '');
    const diff = excerpt.trim() ? await this.gitDiff(this.cwd) : '';

    // product doc — reset to a clean skeleton, then rebuild from recent activity
    let nextDoc = DEFAULT_SPEC;
    try {
      if (excerpt.trim()) {
        const raw = await this.runner.complete(buildSyncPrompt(DEFAULT_SPEC, excerpt, diff));
        if (raw.trim()) nextDoc = raw;
      }
    } catch {
      nextDoc = DEFAULT_SPEC;
    }
    const previous = await this.store.read();
    const applied = await applySpecUpdate(this.store, nextDoc, previous);

    // decisions — regenerate from the same recent activity (best-effort)
    try {
      if (excerpt.trim()) {
        const dec = await this.runner.complete(buildDecisionsPrompt(excerpt));
        if (dec.trim()) await this.writeDecisions(dec);
      }
    } catch {
      // keep the previous decisions doc
    }

    this.checkpoint = await this.reader.currentOffsets();
    await this.ingest.save(this.checkpoint);
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
