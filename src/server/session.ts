// src/server/session.ts
import { Message, AgentRunner, ScribeResult } from '../domain/types';
import { buildFlowPrompt } from '../domain/flow-prompt';
import { SpecStore } from '../core/spec-store';
import { ScribeEngine } from '../core/scribe-engine';
import { Debouncer } from './debouncer';
import { Broadcaster } from './broadcaster';

export interface SessionDeps {
  store: SpecStore;
  runner: AgentRunner;
  debounceMs?: number;
}

/**
 * The in-memory state of one Throughline editing session: the conversation,
 * the scribe engine, the debounced live loop, and the broadcaster that fans
 * spec updates out to connected browsers.
 */
export class Session {
  readonly transcript: Message[] = [];
  readonly engine: ScribeEngine;
  readonly broadcaster = new Broadcaster();

  private store: SpecStore;
  private runner: AgentRunner;
  private debouncer: Debouncer;
  private unwatch: () => void;
  private lastMd: string | null = null;

  constructor(deps: SessionDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.engine = new ScribeEngine(deps.store, deps.runner);
    this.debouncer = new Debouncer(deps.debounceMs ?? 1500);

    this.engine.on('updated', (r: ScribeResult) => {
      this.lastMd = r.md;
      this.broadcaster.broadcast('spec-updated', r);
    });

    // Reflect EXTERNAL edits (user editing spec.md in their own editor).
    // Skip the echo of our own scribe writes by comparing against lastMd.
    this.unwatch = this.store.watch((md) => {
      if (md === this.lastMd) return;
      this.broadcaster.broadcast('spec-updated', { md, changedLines: [] });
    });
  }

  readSpec(): Promise<string> {
    return this.store.read();
  }

  /** Generate a fresh mermaid user-flow from the current spec (one-shot AI call). */
  async generateFlow(signal?: AbortSignal): Promise<string> {
    const spec = await this.readSpec();
    return this.runner.complete(buildFlowPrompt(spec), signal);
  }

  /** Append a user turn, stream the assistant reply, then schedule a debounced scribe. */
  async sendUserMessage(content: string, onToken: (t: string) => void): Promise<string> {
    this.transcript.push({ role: 'user', content });
    const reply = await this.runner.converse(this.transcript, onToken);
    this.transcript.push({ role: 'assistant', content: reply });
    this.debouncer.schedule(() => void this.engine.runNow(this.transcript));
    return reply;
  }

  /** Run any pending scribe immediately (used at shutdown and in tests). */
  flush(): void {
    this.debouncer.flush();
  }

  close(): void {
    this.debouncer.cancel();
    this.unwatch();
  }
}
