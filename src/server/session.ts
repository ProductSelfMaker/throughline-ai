// src/server/session.ts
import chokidar, { type FSWatcher } from 'chokidar';
import { AgentRunner, ScribeResult } from '../domain/types';
import { SpecStore } from '../core/spec-store';
import { ActivityReader } from '../core/activity-reader';
import { SyncEngine } from '../core/sync-engine';
import { Debouncer } from './debouncer';
import { Broadcaster } from './broadcaster';
import { buildFlowPrompt } from '../domain/flow-prompt';
import { TranscriptEntry } from '../core/transcript';

export interface SessionDeps {
  store: SpecStore;
  runner: AgentRunner;
  reader: ActivityReader;
  cwd: string;
  debounceMs?: number;
}

/** The workspace: watches the user's real activity and keeps the living spec current. */
export class Session {
  readonly broadcaster = new Broadcaster();
  readonly engine: SyncEngine;

  private store: SpecStore;
  private runner: AgentRunner;
  private reader: ActivityReader;
  private cwd: string;
  private debouncer: Debouncer;
  private watcher: FSWatcher | null = null;

  constructor(deps: SessionDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.reader = deps.reader;
    this.cwd = deps.cwd;
    this.engine = new SyncEngine(deps.store, deps.runner, deps.reader);
    this.debouncer = new Debouncer(deps.debounceMs ?? 10_000);

    this.engine.on('updated', (r: ScribeResult) => {
      this.broadcaster.broadcast('spec-updated', r);
    });
  }

  readSpec(): Promise<string> {
    return this.store.read();
  }

  readTranscript(): Promise<TranscriptEntry[]> {
    return this.reader.readFullTranscript();
  }

  async generateFlow(signal?: AbortSignal): Promise<string> {
    const spec = await this.readSpec();
    return this.runner.complete(buildFlowPrompt(spec), signal);
  }

  /** Begin watching the repo + Claude Code transcript; debounce → sync. */
  start(): void {
    if (this.watcher) return;
    // Watch both the repo (code changes) and the Claude Code transcript dir
    // (pure conversation, no file save) so either kind of activity triggers a sync.
    this.watcher = chokidar.watch([this.cwd, this.reader.projectDir], {
      ignoreInitial: true,
      ignored: (p: string) =>
        /(^|\/)(\.git|node_modules|dist|docs|\.superpowers)(\/|$)/.test(p) || p.endsWith('/spec.md'),
    });
    const trigger = () => this.debouncer.schedule(() => this.syncAndBroadcastTranscript());
    this.watcher.on('all', trigger);
  }

  private async syncAndBroadcastTranscript(): Promise<void> {
    await this.engine.syncNow();
    this.broadcaster.broadcast('transcript-updated', await this.readTranscript());
  }

  stop(): void {
    this.debouncer.cancel();
    void this.watcher?.close();
    this.watcher = null;
  }
}
