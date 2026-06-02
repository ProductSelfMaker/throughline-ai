// src/server/session.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentRunner, ChatEvent, Message } from '../domain/types';
import { SpecStore } from '../core/spec-store';
import { ConversationStore } from './conversation-store';
import { Debouncer } from './debouncer';
import { Broadcaster } from './broadcaster';
import { buildFlowPrompt } from '../domain/flow-prompt';
import { buildSyncPrompt } from '../domain/sync-prompt';
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

export interface SessionDeps {
  store: SpecStore;
  runner: AgentRunner;
  conversation: ConversationStore;
  cwd: string;
  debounceMs?: number;
  gitDiff?: (cwd: string) => Promise<string>;
}

/** The chat workspace: hosts the conversation over the user's Claude Code and keeps the spec live. */
export class Session {
  readonly broadcaster = new Broadcaster();
  readonly transcript: Message[] = [];

  private store: SpecStore;
  private runner: AgentRunner;
  private conversation: ConversationStore;
  private cwd: string;
  private debouncer: Debouncer;
  private gitDiff: (cwd: string) => Promise<string>;

  constructor(deps: SessionDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.conversation = deps.conversation;
    this.cwd = deps.cwd;
    this.debouncer = new Debouncer(deps.debounceMs ?? 8000);
    this.gitDiff = deps.gitDiff ?? defaultGitDiff;
  }

  /** Restore the persisted conversation into memory. */
  async init(): Promise<void> {
    const prev = await this.conversation.load();
    this.transcript.push(...prev);
  }

  getTranscript(): Message[] {
    return this.transcript;
  }

  readSpec(): Promise<string> {
    return this.store.read();
  }

  async generateFlow(signal?: AbortSignal): Promise<string> {
    const spec = await this.readSpec();
    return this.runner.complete(buildFlowPrompt(spec), signal);
  }

  /** Append a user message, stream the assistant reply, persist both, then debounce a sync. */
  async sendUserMessage(
    content: string,
    onEvent: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const userMsg: Message = { role: 'user', content };
    this.transcript.push(userMsg);
    await this.conversation.append(userMsg);

    const reply = await this.runner.converse(this.transcript, onEvent, signal);

    const assistantMsg: Message = { role: 'assistant', content: reply };
    this.transcript.push(assistantMsg);
    await this.conversation.append(assistantMsg);

    this.debouncer.schedule(() => { void this.sync(); });
    return reply;
  }

  private async sync(): Promise<void> {
    try {
      const current = await this.store.read();
      const transcriptText = this.transcript
        .map((m) => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content}`)
        .join('\n');
      const diff = await this.gitDiff(this.cwd);
      const raw = await this.runner.complete(buildSyncPrompt(current, transcriptText, diff));
      const applied = await applySpecUpdate(this.store, raw, current);
      if (applied.ok) this.broadcaster.broadcast('spec-updated', applied.result);
    } catch {
      // sync is best-effort; keep the last good spec
    }
  }

  /** Run any pending sync immediately (tests / shutdown). */
  flush(): void {
    this.debouncer.flush();
  }

  stop(): void {
    this.debouncer.cancel();
  }
}
