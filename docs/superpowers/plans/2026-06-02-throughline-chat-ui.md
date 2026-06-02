# Throughline — Chat UI + Persistent Conversation (SP-C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw terminal with a Claude-style light-grayscale chat UI driven by the user's own Claude Code (Agent SDK), persist the conversation durably, and sync `spec.md` from the hosted conversation + `git diff`.

**Architecture:** `ClaudeCodeRunner.converse` streams text + tool-use events; a `ConversationStore` persists the transcript to `.throughline/conversation.jsonl`; `Session` seeds its transcript from the store, runs `converse` on each message, and debounces a sync (`buildSyncPrompt` + `applySpecUpdate`). A grayscale `ChatPane` renders it. The terminal stack and the JSONL activity reader are removed.

**Tech Stack:** existing engine + `react-markdown` (already installed), `hono/streaming`. Removes `node-pty`/`@hono/node-ws`/`@xterm`.

**Builds on:** `docs/superpowers/specs/2026-06-02-throughline-chat-ui-design.md`. Memory: `throughline-core-model`, `verify-dev-ui-in-browser`.

---

## File Structure
```
src/domain/types.ts              # MODIFY: ChatEvent; converse signature → onEvent
src/agent/claude-code-runner.ts  # MODIFY: converse emits text+tool events
src/agent/fake-runner.ts         # MODIFY: converse emits scripted ChatEvents
src/server/conversation-store.ts # NEW: persist transcript (.throughline/conversation.jsonl)
src/server/conversation-store.test.ts # NEW
src/server/session.ts            # REWRITE: chat workspace (transcript + sendUserMessage + sync)
src/server/session.test.ts       # REWRITE
src/server/app.ts                # MODIFY: + POST /api/chat (NDJSON stream) + GET /api/transcript
src/server/app.test.ts           # MODIFY
src/server/server.ts             # REWRITE: ConversationStore + init; remove terminal/activity
src/web/api.ts                   # MODIFY: + sendChat (NDJSON) + fetchTranscript
src/web/ChatPane.tsx             # NEW: grayscale Claude-style chat
src/web/App.tsx                  # MODIFY: Terminal → ChatPane
src/web/styles.css               # MODIFY: chat styles
# Cleanup (Task 8): delete terminal stack + activity reader + deps
```

---

## Task 1: `converse` streams text + tool events

**Files:** Modify `src/domain/types.ts`, `src/agent/claude-code-runner.ts`, `src/agent/fake-runner.ts`; Test via `fake-runner.test.ts` + a runner unit.

- [ ] **Step 1: Write the failing test** — append to `src/agent/fake-runner.test.ts` inside `describe('FakeAgentRunner', ...)`:
```ts
  it('converse emits scripted chat events and returns the text', async () => {
    const runner = new FakeAgentRunner({
      chatEvents: [
        { type: 'tool', name: 'Edit', target: 'src/Login.tsx' },
        { type: 'text', text: '로그인 추가했어요' },
      ],
    });
    const events: any[] = [];
    const reply = await runner.converse([{ role: 'user', content: '로그인' }], (e) => events.push(e));
    expect(events).toEqual([
      { type: 'tool', name: 'Edit', target: 'src/Login.tsx' },
      { type: 'text', text: '로그인 추가했어요' },
    ]);
    expect(reply).toBe('로그인 추가했어요');
  });
```

- [ ] **Step 2: Run and confirm FAIL** — `npx vitest run src/agent/fake-runner.test.ts`.

- [ ] **Step 3a: `src/domain/types.ts`** — add the event type and change the `converse` signature:
  - Add near the other exports:
```ts
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; target: string };
```
  - In `interface AgentRunner`, replace the `converse(...)` member with:
```ts
  /** Drives the user's Claude Code; streams text deltas and tool-use events; resolves with the full assistant text. */
  converse(
    transcript: Message[],
    onEvent: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<string>;
```

- [ ] **Step 3b: `src/agent/fake-runner.ts`** — replace the file with:
```ts
// src/agent/fake-runner.ts
import { AgentRunner, ChatEvent, Message } from '../domain/types';

type ScribeReply = string | ((cur: string, transcript: Message[]) => string);
type CompleteReply = string | ((prompt: string) => string);

export class FakeAgentRunner implements AgentRunner {
  constructor(
    private opts: {
      chatEvents?: ChatEvent[];
      converseReply?: string;
      scribeReply?: ScribeReply;
      completeReply?: CompleteReply;
    } = {},
  ) {}

  async converse(_transcript: Message[], onEvent: (e: ChatEvent) => void): Promise<string> {
    const events = this.opts.chatEvents ?? [];
    for (const e of events) onEvent(e);
    if (this.opts.converseReply !== undefined) return this.opts.converseReply;
    return events
      .filter((e): e is { type: 'text'; text: string } => e.type === 'text')
      .map((e) => e.text)
      .join('');
  }

  async scribe(cur: string, transcript: Message[]): Promise<string> {
    const r = this.opts.scribeReply ?? cur;
    return typeof r === 'function' ? r(cur, transcript) : r;
  }

  async complete(prompt: string): Promise<string> {
    const r = this.opts.completeReply ?? '';
    return typeof r === 'function' ? r(prompt) : r;
  }
}
```

- [ ] **Step 3c: `src/agent/claude-code-runner.ts`** — change `converse` to stream events. Add a `toolTarget` helper and a `streamChat` function, and rewrite `converse`. Replace the `collectAssistantText` usage in `converse` (keep it for `scribe`/`complete`). Concretely:
  - Add after `stripCodeFence`:
```ts
function toolTarget(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const v = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.url;
    if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
  }
  return '';
}

async function streamChat(
  prompt: string,
  cwd: string | undefined,
  onEvent: (e: import('../domain/types').ChatEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  let full = '';
  for await (const msg of query({
    prompt,
    options: { cwd, abortController: abortControllerFor(signal) },
  })) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          full += block.text;
          onEvent({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          onEvent({ type: 'tool', name: block.name, target: toolTarget(block.input) });
        }
      }
    }
  }
  return full;
}
```
  - Replace the `converse(...)` method with:
```ts
  converse(
    transcript: Message[],
    onEvent: (e: import('../domain/types').ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    return streamChat(transcriptToPrompt(transcript), this.options.cwd, onEvent, signal);
  }
```
  - Update the top import to include `ChatEvent`: change `import { AgentRunner, Message } from '../domain/types';` → `import { AgentRunner, ChatEvent, Message } from '../domain/types';` and use `ChatEvent` directly (drop the inline `import('../domain/types')` forms): i.e. `onEvent: (e: ChatEvent) => void`.
  > Verify the SDK `tool_use` block fields (`name`, `input`) against the installed `@anthropic-ai/claude-agent-sdk` types; adjust `block.name`/`block.input` if needed.

- [ ] **Step 4: Run and verify** — `npx vitest run src/agent/fake-runner.test.ts` (passes); `npx vitest run` (full suite — any inline `converse: async () => ''` stubs still typecheck since fewer params is allowed); `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add src/domain/types.ts src/agent/fake-runner.ts src/agent/fake-runner.test.ts src/agent/claude-code-runner.ts
git commit -m "feat: converse streams text + tool-use events"
```

---

## Task 2: ConversationStore

**Files:** Create `src/server/conversation-store.ts`, `src/server/conversation-store.test.ts`.

- [ ] **Step 1: Write the failing test**
```ts
// src/server/conversation-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from './conversation-store';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tl-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('ConversationStore', () => {
  it('appends and loads messages (creating .throughline)', async () => {
    const s = new ConversationStore(dir);
    await s.append({ role: 'user', content: '안녕' });
    await s.append({ role: 'assistant', content: '네' });
    expect(await s.load()).toEqual([
      { role: 'user', content: '안녕' },
      { role: 'assistant', content: '네' },
    ]);
  });

  it('returns [] when nothing saved, and skips malformed lines', async () => {
    expect(await new ConversationStore(dir).load()).toEqual([]);
    await mkdir(join(dir, '.throughline'), { recursive: true });
    await writeFile(
      join(dir, '.throughline', 'conversation.jsonl'),
      '{"role":"user","content":"hi"}\nnot json\n{"role":"x"}\n',
    );
    expect(await new ConversationStore(dir).load()).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
```

- [ ] **Step 2: Run and confirm FAIL** — `npx vitest run src/server/conversation-store.test.ts`.

- [ ] **Step 3: Implement**
```ts
// src/server/conversation-store.ts
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Message } from '../domain/types';

/** Durable append-only conversation log at <cwd>/.throughline/conversation.jsonl (keep all). */
export class ConversationStore {
  private file: string;
  constructor(cwd: string) {
    this.file = join(cwd, '.throughline', 'conversation.jsonl');
  }

  async append(msg: Message): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(msg) + '\n', 'utf8');
  }

  async load(): Promise<Message[]> {
    if (!existsSync(this.file)) return [];
    const out: Message[] = [];
    for (const line of (await readFile(this.file, 'utf8')).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const m = JSON.parse(t);
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
          out.push({ role: m.role, content: m.content });
        }
      } catch {
        // skip malformed line
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run and confirm 2/2 PASS**; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add src/server/conversation-store.ts src/server/conversation-store.test.ts
git commit -m "feat: ConversationStore persists the transcript"
```

---

## Task 3: Session reshape (chat + persistent + sync)

**Files:** Rewrite `src/server/session.ts`, `src/server/session.test.ts`.

- [ ] **Step 1: Replace `src/server/session.ts` with:**
```ts
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
    const current = await this.store.read();
    const transcriptText = this.transcript
      .map((m) => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content}`)
      .join('\n');
    const diff = await this.gitDiff(this.cwd);
    let raw: string;
    try {
      raw = await this.runner.complete(buildSyncPrompt(current, transcriptText, diff));
    } catch {
      return; // keep last good spec
    }
    const applied = await applySpecUpdate(this.store, raw, current);
    if (applied.ok) this.broadcaster.broadcast('spec-updated', applied.result);
  }

  /** Run any pending sync immediately (tests / shutdown). */
  flush(): void {
    this.debouncer.flush();
  }

  stop(): void {
    this.debouncer.cancel();
  }
}
```

- [ ] **Step 2: Replace `src/server/session.test.ts` with:**
```ts
// src/server/session.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from '../core/spec-store';
import { ConversationStore } from './conversation-store';
import { FakeAgentRunner } from '../agent/fake-runner';
import { Session } from './session';
import { ScribeResult } from '../domain/types';

let dir: string;
let session: Session | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tl-')); });
afterEach(async () => { session?.stop(); await rm(dir, { recursive: true, force: true }); });

const VALID = `## 🎯 요약\n앱\n\n## ✅ 핵심 기능\n- [x] 소셜 로그인\n\n## 🟡 미정 / 열린 질문\n- 결제?\n`;

describe('Session', () => {
  it('init restores the persisted conversation', async () => {
    const conv = new ConversationStore(dir);
    await conv.append({ role: 'user', content: '이전 대화' });
    session = new Session({ store: new SpecStore(join(dir, 'spec.md')), runner: new FakeAgentRunner(), conversation: conv, cwd: dir });
    await session.init();
    expect(session.getTranscript()).toEqual([{ role: 'user', content: '이전 대화' }]);
  });

  it('sendUserMessage streams events, persists both turns, and a flushed sync updates the spec', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    const conv = new ConversationStore(dir);
    const runner = new FakeAgentRunner({
      chatEvents: [{ type: 'tool', name: 'Edit', target: 'a.tsx' }, { type: 'text', text: '했어요' }],
      completeReply: VALID,
    });
    session = new Session({ store, runner, conversation: conv, cwd: dir, gitDiff: async () => 'diff' });

    const updated = new Promise<ScribeResult>((res) => session!.broadcaster.subscribe((ev, d) => { if (ev === 'spec-updated') res(d as ScribeResult); }));

    const events: any[] = [];
    const reply = await session.sendUserMessage('로그인 만들어', (e) => events.push(e));

    expect(reply).toBe('했어요');
    expect(events).toEqual([{ type: 'tool', name: 'Edit', target: 'a.tsx' }, { type: 'text', text: '했어요' }]);
    expect(session.getTranscript()).toEqual([{ role: 'user', content: '로그인 만들어' }, { role: 'assistant', content: '했어요' }]);
    expect(await conv.load()).toEqual([{ role: 'user', content: '로그인 만들어' }, { role: 'assistant', content: '했어요' }]);

    session.flush();
    await updated;
    expect(await store.read()).toContain('- [x] 소셜 로그인 <!-- id: feat-');
  });
});
```

- [ ] **Step 3: Run and verify** — `npx vitest run src/server/session.test.ts` (2/2). Then `npx tsc --noEmit` — expect errors ONLY in `app.ts`/`app.test.ts`/`server.ts` (they still use the old Session deps/methods — fixed in Tasks 4–5). Confirm errors are confined to those.

- [ ] **Step 4: Commit**
```bash
git add src/server/session.ts src/server/session.test.ts
git commit -m "refactor: Session hosts the chat over Claude Code + persists + syncs"
```

---

## Task 4: /api/chat (NDJSON stream) + /api/transcript

**Files:** Modify `src/server/app.ts`, `src/server/app.test.ts`.

- [ ] **Step 1: Update `src/server/app.ts`** — add `streamText` import and two routes. The file becomes:
```ts
// src/server/app.ts
import { Hono } from 'hono';
import { streamText, streamSSE } from 'hono/streaming';
import { Session } from './session';

export function createApp(session: Session): Hono {
  const app = new Hono();

  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{ message?: string }>();
    return streamText(c, async (stream) => {
      await session.sendUserMessage(body.message ?? '', (e) => {
        void stream.write(JSON.stringify(e) + '\n');
      });
      await stream.write(JSON.stringify({ type: 'done' }) + '\n');
    });
  });

  app.get('/api/transcript', (c) => c.json({ transcript: session.getTranscript() }));

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      const current = await session.readSpec();
      await stream.writeSSE({ event: 'spec-updated', data: JSON.stringify({ md: current, changedLines: [] }) });
      const unsub = session.broadcaster.subscribe((event, data) => {
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      });
      stream.onAbort(() => unsub());
      if (stream.aborted) { unsub(); return; }
      while (!stream.aborted) {
        await stream.sleep(30_000);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
    });
  });

  app.get('/api/flow', async (c) => {
    try {
      const mermaid = await session.generateFlow(c.req.raw.signal);
      return c.json({ mermaid });
    } catch (err) {
      return c.json({ error: (err as Error)?.message ?? String(err) }, 500);
    }
  });

  return app;
}
```

- [ ] **Step 2: Replace `src/server/app.test.ts` with:**
```ts
// src/server/app.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from '../core/spec-store';
import { ConversationStore } from './conversation-store';
import { FakeAgentRunner } from '../agent/fake-runner';
import { Session } from './session';
import { createApp } from './app';

let dir: string;
let session: Session | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tl-')); });
afterEach(async () => { session?.stop(); await rm(dir, { recursive: true, force: true }); });

function mk(runner = new FakeAgentRunner()): Session {
  return new Session({ store: new SpecStore(join(dir, 'spec.md')), runner, conversation: new ConversationStore(dir), cwd: dir, gitDiff: async () => '' });
}

describe('POST /api/chat', () => {
  it('streams NDJSON events ending with done', async () => {
    session = mk(new FakeAgentRunner({ chatEvents: [{ type: 'tool', name: 'Edit', target: 'a.tsx' }, { type: 'text', text: 'ok' }] }));
    const res = await createApp(session).request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { type: 'tool', name: 'Edit', target: 'a.tsx' },
      { type: 'text', text: 'ok' },
      { type: 'done' },
    ]);
  });
});

describe('GET /api/transcript', () => {
  it('returns the in-memory transcript', async () => {
    session = mk(new FakeAgentRunner({ chatEvents: [{ type: 'text', text: 'ok' }] }));
    await createApp(session).request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
    const res = await createApp(session).request('/api/transcript');
    expect(await res.json()).toEqual({ transcript: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }] });
  });
});

describe('GET /api/flow', () => {
  it('returns { mermaid }', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    await store.write('## ✅ 핵심 기능\n- [ ] 소셜 로그인\n');
    session = new Session({ store, runner: new FakeAgentRunner({ completeReply: 'flowchart TD\n A-->B' }), conversation: new ConversationStore(dir), cwd: dir, gitDiff: async () => '' });
    const res = await createApp(session).request('/api/flow');
    expect(await res.json()).toEqual({ mermaid: 'flowchart TD\n A-->B' });
  });
});
```

- [ ] **Step 3: Run and verify** — `npx vitest run src/server/app.test.ts` (passes); `npx tsc --noEmit` — errors now confined to `server.ts` only (Task 5 fixes); `npm test` (vitest) green.

- [ ] **Step 4: Commit**
```bash
git add src/server/app.ts src/server/app.test.ts
git commit -m "feat: /api/chat (NDJSON stream) + /api/transcript"
```

---

## Task 5: server.ts reshape

**Files:** Rewrite `src/server/server.ts`.

- [ ] **Step 1: Replace `src/server/server.ts` with:**
```ts
// src/server/server.ts
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import open from 'open';
import { SpecStore } from '../core/spec-store';
import { ClaudeCodeRunner } from '../agent/claude-code-runner';
import { ConversationStore } from './conversation-store';
import { Session } from './session';
import { createApp } from './app';

const cwd = process.cwd();
const specPath = join(cwd, 'spec.md');

const session = new Session({
  store: new SpecStore(specPath),
  runner: new ClaudeCodeRunner({ cwd }),
  conversation: new ConversationStore(cwd),
  cwd,
});
await session.init();

const app = createApp(session);

if (existsSync(join(cwd, 'dist'))) {
  app.use('/*', serveStatic({ root: './dist' }));
}

const port = Number(process.env.PORT ?? 5174);
serve({ fetch: app.fetch, port }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`Throughline → ${url}  (chat over your Claude Code in ${cwd})`);
  if (process.env.OPEN !== '0' && existsSync(join(cwd, 'dist'))) void open(url);
});

const shutdown = () => {
  session.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```
(Top-level `await session.init()` is fine — the project is ESM and run via `tsx`.)

- [ ] **Step 2: Verify** — `npx tsc --noEmit` is now FULLY clean. `npm test` green.

- [ ] **Step 3: Commit**
```bash
git add src/server/server.ts
git commit -m "feat: server hosts the persistent chat session"
```

---

## Task 6: Browser API client

**Files:** Modify `src/web/api.ts`.

- [ ] **Step 1: Replace `src/web/api.ts` with:**
```ts
// src/web/api.ts
export type SpecUpdate = { md: string; changedLines: number[] };
export type Msg = { role: 'user' | 'assistant'; content: string };
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; target: string }
  | { type: 'done' };

/** Subscribe to live spec updates over SSE. */
export function subscribeSpec(onSpec: (u: SpecUpdate) => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('spec-updated', (e) => onSpec(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

export async function fetchTranscript(): Promise<Msg[]> {
  const res = await fetch('/api/transcript');
  const data = (await res.json()) as { transcript?: Msg[] };
  return data.transcript ?? [];
}

/** Send a chat message; receive streamed text/tool/done events (NDJSON). */
export async function sendChat(message: string, onEvent: (e: ChatEvent) => void): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try { onEvent(JSON.parse(line) as ChatEvent); } catch { /* ignore */ }
      }
    }
  }
}

/** Fetch a freshly generated mermaid user-flow for the current spec. */
export async function fetchFlow(): Promise<string> {
  const res = await fetch('/api/flow');
  const data = (await res.json()) as { mermaid?: string; error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `flow request failed (${res.status})`);
  return data.mermaid ?? '';
}
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean; `npm run build:web` succeeds.

- [ ] **Step 3: Commit**
```bash
git add src/web/api.ts
git commit -m "feat: browser chat client (NDJSON stream + transcript)"
```

---

## Task 7: ChatPane + App + styles

**Files:** Create `src/web/ChatPane.tsx`; Modify `src/web/App.tsx`, `src/web/styles.css`.

- [ ] **Step 1: Create `src/web/ChatPane.tsx`**
```tsx
// src/web/ChatPane.tsx
import { useEffect, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchTranscript, sendChat, type Msg } from './api';

type Tool = { name: string; target: string };
type Turn = { role: 'user' | 'assistant'; content: string; tools: Tool[] };

export function ChatPane() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchTranscript()
      .then((msgs: Msg[]) => setTurns(msgs.map((m) => ({ role: m.role, content: m.content, tools: [] }))))
      .catch(() => {});
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [turns]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setTurns((t) => [...t, { role: 'user', content: text, tools: [] }, { role: 'assistant', content: '', tools: [] }]);
    setBusy(true);
    try {
      await sendChat(text, (ev) => {
        setTurns((t) => {
          const copy = t.slice();
          const last = copy[copy.length - 1];
          if (ev.type === 'text') copy[copy.length - 1] = { ...last, content: last.content + ev.text };
          else if (ev.type === 'tool') copy[copy.length - 1] = { ...last, tools: [...last.tools, { name: ev.name, target: ev.target }] };
          return copy;
        });
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="chat">
      <header className="chat-head">💬 Claude Code</header>
      <div className="chat-log">
        {turns.length === 0 ? <p className="empty">무엇을 만들까요? 메시지를 입력해 시작하세요.</p> : null}
        {turns.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="msg-user">{m.content}</div>
          ) : (
            <div key={i} className="msg-asst">
              <div className="asst-label">✦ CLAUDE</div>
              {m.tools.map((t, j) => (
                <span key={j} className="tool-chip">🔧 <b>{t.name}</b>{t.target ? ` ${t.target}` : ''} <span className="chk">✓</span></span>
              ))}
              <div className="asst-md">
                {m.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown> : <span className="typing">작성 중…</span>}
              </div>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={submit}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="메시지를 입력하세요…" disabled={busy} />
        <button disabled={busy} aria-label="보내기">↑</button>
      </form>
    </section>
  );
}
```
> Verify `react-markdown` + `remark-gfm` import names against installed versions (they're already used by `FlowView`... actually FlowView used mermaid; `react-markdown` is used by `SpecPane` — confirm there).

- [ ] **Step 2: Wire into `src/web/App.tsx`** — change `import { Terminal } from './Terminal';` → `import { ChatPane } from './ChatPane';` and `<Terminal />` → `<ChatPane />`. Leave the rest unchanged.

- [ ] **Step 3: Replace the terminal CSS in `src/web/styles.css`** — remove the `.terminal-wrap`/`.terminal-host`/`.terminal-overlay` rules and add the chat rules:
```css
.chat { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; background: #fff; color: #111; }
.chat-head { padding: 9px 14px; padding-right: 230px; border-bottom: 1px solid #f0f0f0; background: #fafafa; font-size: 11px; color: #6b7280; }
.chat-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; font-size: 13px; }
.msg-user { align-self: flex-end; max-width: 82%; background: #f4f4f5; border-radius: 12px; padding: 8px 12px; line-height: 1.5; white-space: pre-wrap; }
.msg-asst { display: flex; flex-direction: column; gap: 7px; }
.asst-label { font-size: 10px; font-weight: 700; letter-spacing: .02em; color: #3f3f46; }
.tool-chip { align-self: flex-start; display: inline-flex; gap: 5px; align-items: center; background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 8px; padding: 2px 9px; font-size: 11px; color: #52525b; }
.tool-chip .chk { color: #71717a; }
.asst-md { line-height: 1.6; }
.asst-md p { margin: 0 0 6px; }
.asst-md code { background: #f4f4f5; border: 1px solid #ececec; border-radius: 4px; padding: 0 4px; font-size: 12px; }
.asst-md pre { background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 8px 10px; overflow: auto; }
.typing { color: #a1a1aa; }
.composer { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-top: 1px solid #f0f0f0; background: #fafafa; }
.composer input { flex: 1; padding: 8px 12px; border: 1px solid #d4d4d8; border-radius: 18px; font-size: 13px; }
.composer button { width: 32px; height: 32px; border: none; border-radius: 50%; background: #18181b; color: #fff; font-size: 15px; cursor: pointer; }
.composer button:disabled { opacity: 0.4; cursor: default; }
```

- [ ] **Step 4: Verify** — `npx tsc --noEmit` clean; `npm run build:web` succeeds; `npm test` green.

- [ ] **Step 5: Commit**
```bash
git add src/web/ChatPane.tsx src/web/App.tsx src/web/styles.css
git commit -m "feat: grayscale Claude-style ChatPane replaces the terminal"
```

---

## Task 8: Cleanup — remove the terminal stack + activity reader

**Files:** delete the SP-A/SP-B modules now unused; drop deps.

- [ ] **Step 1: Delete files**
```bash
git rm src/web/Terminal.tsx \
  src/server/terminal-session.ts src/server/terminal-session.test.ts \
  src/server/terminal-ws.ts src/server/terminal-ws.test.ts \
  src/server/node-pty-factory.ts \
  src/core/activity-reader.ts src/core/activity-reader.test.ts \
  src/core/transcript.ts src/core/transcript.test.ts \
  src/core/sync-engine.ts src/core/sync-engine.test.ts \
  scripts/fix-node-pty.mjs
```

- [ ] **Step 2: Drop deps + postinstall + .npmrc + ws proxy**
- In `package.json`: remove `node-pty`, `@hono/node-ws`, `@xterm/xterm`, `@xterm/addon-fit` from dependencies, and remove the `"postinstall"` script.
- Delete `.npmrc` (`git rm .npmrc`) — it was only for the @hono/node-ws peer range.
- In `vite.config.ts`, remove the `'/ws': { target: ..., ws: true }` proxy entry (keep `'^/api/'`).
- Run `npm install` to update the lockfile.

- [ ] **Step 3: Typecheck + tests** — `npx tsc --noEmit`. If it reports dangling references to any deleted module (e.g. a leftover `scribe-engine.ts` importing `sync-engine`, or `ScribeEngine` still referenced), resolve them: `scribe-engine.ts` + `scribe-engine.test.ts` are also now unused — `git rm` them if present and nothing imports them. Re-run until clean. Then `npm test` green and `npm run build:web` succeeds.

- [ ] **Step 4: Commit**
```bash
git add -A
git commit -m "chore: remove terminal stack + JSONL activity reader (superseded by chat)"
```

---

## Task 9: End-to-end browser smoke (controller-run)

> The real-Claude-Code turn + PTY-free chat needs the dev server; the CONTROLLER runs this (sandbox + real model). Subagents: run the automated gates and report; do not run the live model turn.

- [ ] **Step 1: Gates** — `npm test` (all green), `npx tsc --noEmit` (clean), `npm run build:web` (succeeds).
- [ ] **Step 2: Browser smoke (Playwright headless)** — with `npm run dev`, load `http://localhost:5173`: assert the chat composer renders; send a message; assert a streamed assistant bubble appears; **reload and assert the conversation persists** (history restored from `.throughline/conversation.jsonl`). Capture results.
- [ ] **Step 3: Cleanup** — `git status` clean; `.throughline/` present but gitignored; no stray processes.

---

## Self-Review (completed by plan author)

**Spec coverage:** chat UI style A grayscale → Task 7 ✓; engine = user's Claude Code via converse w/ tool events → Tasks 1,3 ✓; markdown + tool chips + streaming → Task 7 ✓; ConversationStore keep-all + load on start → Tasks 2,3,5 ✓; restart persistence (spec.md file + conversation store) → Tasks 2,3,5 ✓; catch-up via chat (AI reads cwd files) → inherent (converse runs in cwd), no code needed ✓; sync from hosted conversation + git diff → Task 3 ✓; remove terminal + activity reader → Task 8 ✓.

**Placeholder scan:** none — complete code in every step.

**Type consistency:** `ChatEvent` (Task 1) used in fake/real runner, Session, /api/chat, api.ts, ChatPane; `SessionDeps {store, runner, conversation, cwd, debounceMs?, gitDiff?}` consistent across Tasks 3,4,5; `ConversationStore(cwd)` with `append`/`load` (Tasks 2,3,5); `sendChat(message, onEvent)` (Task 6) consumed by ChatPane (Task 7); `Msg {role,content}` shared. `.throughline/` must be gitignored — already in `.gitignore`? if not, add it in Task 8.

**Deferred (per spec §6):** multi-CLI; conversation search/branching; retention trim; preview reverse-proxy; per-line highlight; autonomous-agent.
