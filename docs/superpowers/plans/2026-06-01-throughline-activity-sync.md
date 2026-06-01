# Throughline — Activity-Based Sync Agent (SP-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Throughline keep `spec.md` (and the flow view) live from the user's REAL work — their Claude Code session transcript (`~/.claude/projects/.../*.jsonl`) + `git diff` — instead of a Throughline-hosted chat.

**Architecture:** A new `ActivityReader` reads the Claude Code JSONL transcript delta + `git diff`; a `SyncEngine` watches those, debounces (~10s), and runs a reverse-scribe (`runner.complete(buildSyncPrompt(...))`) through a shared `applySpecUpdate` helper. The left chat is replaced by a read-only `TranscriptView`; the `converse`/`/api/chat` path is retired.

**Tech Stack:** Existing engine (spec parse/validate/diff, SpecStore, Broadcaster, ClaudeCodeRunner, Hono/Vite/React) + Node `fs`/`child_process` for JSONL + git.

**Builds on:** `docs/superpowers/specs/2026-06-01-throughline-activity-sync-design.md`. See memory `throughline-core-model`.

---

## File Structure

```
src/
  core/
    apply-spec-update.ts      # NEW: shared validate→ids→diff→write helper
    apply-spec-update.test.ts # NEW
    scribe-engine.ts          # MODIFY: use applySpecUpdate (keeps tests green)
    transcript.ts             # NEW: pure JSONL parsing (encode dir, parse entries)
    transcript.test.ts        # NEW
    activity-reader.ts        # NEW: find session, tail delta, git diff
    activity-reader.test.ts   # NEW
    sync-engine.ts            # NEW: watch + debounce + reverse-scribe
    sync-engine.test.ts       # NEW
  domain/
    sync-prompt.ts            # NEW: buildSyncPrompt
    sync-prompt.test.ts       # NEW
  server/
    session.ts                # MODIFY (full rewrite): workspace around SyncEngine; drop converse
    session.test.ts           # MODIFY: drop sendUserMessage test; add readTranscript test
    app.ts                    # MODIFY: remove /api/chat; add /api/transcript
    app.test.ts               # MODIFY: replace chat test with transcript test
    server.ts                 # MODIFY: start the sync engine
  web/
    api.ts                    # MODIFY: drop sendChat; add fetchTranscript
    TranscriptView.tsx        # NEW (replaces ChatPane)
    ChatPane.tsx              # DELETE
    App.tsx                   # MODIFY: use TranscriptView
```

---

## Task 1: Extract `applySpecUpdate` (DRY refactor)

**Files:**
- Create: `src/core/apply-spec-update.ts`, `src/core/apply-spec-update.test.ts`
- Modify: `src/core/scribe-engine.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/apply-spec-update.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from './spec-store';
import { applySpecUpdate } from './apply-spec-update';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'throughline-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const VALID = `## 🎯 요약
앱

## ✅ 핵심 기능
- [ ] 소셜 로그인

## 🟡 미정 / 열린 질문
- 결제?
`;

describe('applySpecUpdate', () => {
  it('writes valid markdown with feature ids and returns the change set', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    const out = await applySpecUpdate(store, VALID, '');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.changedLines.length).toBeGreaterThan(0);
    const onDisk = await store.read();
    expect(onDisk).toContain('- [ ] 소셜 로그인 <!-- id: feat-');
    expect(onDisk).toBe(out.result.md);
  });

  it('rejects invalid markdown without writing', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    await store.write('## 🎯 요약\n원본\n');
    const out = await applySpecUpdate(store, '깨진 문서', '## 🎯 요약\n원본\n');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.length).toBeGreaterThan(0);
    expect(await store.read()).toBe('## 🎯 요약\n원본\n');
  });
});
```

- [ ] **Step 2: Run and confirm FAIL** — `npx vitest run src/core/apply-spec-update.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/core/apply-spec-update.ts
import { SpecStore } from './spec-store';
import { validateSpec } from '../domain/spec-structure';
import { ensureFeatureIds } from '../domain/spec-doc';
import { changedLineNumbers } from '../domain/spec-diff';
import { ScribeResult } from '../domain/types';

export type ApplyResult =
  | { ok: true; result: ScribeResult }
  | { ok: false; errors: string[] };

/** Validate raw agent markdown, add feature ids, diff vs previous, write to disk. */
export async function applySpecUpdate(
  store: SpecStore,
  rawMd: string,
  previousMd: string,
): Promise<ApplyResult> {
  const validation = validateSpec(rawMd);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const md = ensureFeatureIds(rawMd);
  const changedLines = changedLineNumbers(previousMd, md);
  await store.write(md);
  return { ok: true, result: { md, changedLines } };
}
```

- [ ] **Step 4: Refactor `ScribeEngine` to use it** — replace the body of `runNow` in `src/core/scribe-engine.ts` (keep the imports of `EventEmitter`, `AgentRunner`, `Message`, `ScribeResult`, `SpecStore`; replace the `validateSpec`/`ensureFeatureIds`/`changedLineNumbers` imports with the `applySpecUpdate` import). The class becomes:

```ts
// src/core/scribe-engine.ts
import { EventEmitter } from 'node:events';
import { AgentRunner, Message, ScribeResult } from '../domain/types';
import { SpecStore } from './spec-store';
import { applySpecUpdate } from './apply-spec-update';

/**
 * Emits 'updated' (ScribeResult) on success, 'rejected' (string[]) when the agent
 * output is invalid OR the runner throws. runNow never throws — it returns null on
 * any failure, keeping the existing spec.md untouched.
 */
export class ScribeEngine extends EventEmitter {
  constructor(
    private store: SpecStore,
    private runner: AgentRunner,
  ) {
    super();
  }

  async runNow(transcript: Message[], signal?: AbortSignal): Promise<ScribeResult | null> {
    const current = await this.store.read();

    let raw: string;
    try {
      raw = await this.runner.scribe(current, transcript, signal);
    } catch (err) {
      this.emit('rejected', [(err as Error)?.message ?? String(err)]);
      return null;
    }

    const applied = await applySpecUpdate(this.store, raw, current);
    if (!applied.ok) {
      this.emit('rejected', applied.errors);
      return null;
    }
    this.emit('updated', applied.result);
    return applied.result;
  }
}
```

- [ ] **Step 5: Run and verify** — `npx vitest run` (full suite still green, incl. existing `scribe-engine.test.ts`) and `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/apply-spec-update.ts src/core/apply-spec-update.test.ts src/core/scribe-engine.ts
git commit -m "refactor: extract applySpecUpdate shared helper"
```

---

## Task 2: Transcript parsing (pure)

**Files:**
- Create: `src/core/transcript.ts`, `src/core/transcript.test.ts`

Grounded in the real Claude Code JSONL: `type:"user"` with string `message.content` = a real prompt; `type:"assistant"` with array `message.content` (keep `text` blocks); skip `isSidechain` and all other types; `type:"user"` with array content = tool results (skip).

- [ ] **Step 1: Write the failing test**

```ts
// src/core/transcript.test.ts
import { describe, it, expect } from 'vitest';
import { encodeProjectDir, parseEntries } from './transcript';

describe('encodeProjectDir', () => {
  it('replaces every non-alphanumeric char in the cwd with a dash', () => {
    expect(encodeProjectDir('/Users/u/Developer/Thorughline')).toBe(
      '-Users-u-Developer-Thorughline',
    );
  });
});

describe('parseEntries', () => {
  it('keeps user string prompts and assistant text blocks, skips noise', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '로그인 만들어줘' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '...' },
            { type: 'text', text: '로그인 컴포넌트 추가했어요' },
            { type: 'tool_use', name: 'Edit', input: {} },
          ],
        },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '서브에이전트' }] } }),
      JSON.stringify({ type: 'system', subtype: 'hook' }),
      'not json',
    ].join('\n');

    expect(parseEntries(lines)).toEqual([
      { role: 'user', text: '로그인 만들어줘' },
      { role: 'assistant', text: '로그인 컴포넌트 추가했어요' },
    ]);
  });
});
```

- [ ] **Step 2: Run and confirm FAIL** — `npx vitest run src/core/transcript.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/core/transcript.ts
export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

/** Claude Code stores a project's sessions under ~/.claude/projects/<encoded cwd>/. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Parse a chunk of JSONL lines into clean user/assistant turns, skipping noise. */
export function parseEntries(jsonlText: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // tolerate partial/corrupt lines
    }
    if (obj?.isSidechain) continue;
    const msg = obj?.message;
    if (obj?.type === 'user' && typeof msg?.content === 'string') {
      const text = msg.content.trim();
      if (text) entries.push({ role: 'user', text });
    } else if (obj?.type === 'assistant' && Array.isArray(msg?.content)) {
      const text = msg.content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('')
        .trim();
      if (text) entries.push({ role: 'assistant', text });
    }
  }
  return entries;
}
```

- [ ] **Step 4: Run and confirm PASS** — `npx vitest run src/core/transcript.test.ts`; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/transcript.ts src/core/transcript.test.ts
git commit -m "feat: Claude Code JSONL transcript parsing"
```

---

## Task 3: Activity Reader (session selection + delta + git)

**Files:**
- Create: `src/core/activity-reader.ts`, `src/core/activity-reader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/activity-reader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityReader } from './activity-reader';

let home: string;
let projectDir: string;
const CWD = '/Users/u/Developer/Demo'; // → -Users-u-Developer-Demo

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tl-home-'));
  projectDir = join(home, '.claude', 'projects', '-Users-u-Developer-Demo');
  await mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function line(role: 'user' | 'assistant', text: string): string {
  return role === 'user'
    ? JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
    : JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

describe('ActivityReader', () => {
  it('reads the newest non-agent session delta and the git diff', async () => {
    await writeFile(join(projectDir, 'agent-aaa.jsonl'), line('user', '서브에이전트') + '\n');
    const sess = join(projectDir, 'sess-1.jsonl');
    await writeFile(sess, line('user', '로그인 만들어줘') + '\n');

    const reader = new ActivityReader(CWD, { home, runGitDiff: async () => 'diff --git a/login.tsx b/login.tsx' });

    const first = await reader.readActivity({ sessionFile: null, byteOffset: 0 });
    expect(first.hasNew).toBe(true);
    expect(first.entries).toEqual([{ role: 'user', text: '로그인 만들어줘' }]);
    expect(first.gitDiff).toContain('login.tsx');

    // No new content → hasNew false
    const second = await reader.readActivity(first.newState);
    expect(second.hasNew).toBe(false);

    // Append a new line → only the delta is read
    await writeFile(sess, line('user', '로그인 만들어줘') + '\n' + line('assistant', '추가했어요') + '\n');
    const third = await reader.readActivity(second.newState);
    expect(third.hasNew).toBe(true);
    expect(third.entries).toEqual([{ role: 'assistant', text: '추가했어요' }]);
  });

  it('reports no session when the project dir is empty', async () => {
    const reader = new ActivityReader(CWD, { home, runGitDiff: async () => '' });
    const out = await reader.readActivity({ sessionFile: null, byteOffset: 0 });
    expect(out.hasNew).toBe(false);
    expect(out.entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm FAIL** — `npx vitest run src/core/activity-reader.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/core/activity-reader.ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encodeProjectDir, parseEntries, TranscriptEntry } from './transcript';

const execFileP = promisify(execFile);

export interface ActivityState {
  sessionFile: string | null;
  byteOffset: number;
}

export interface ActivityResult {
  entries: TranscriptEntry[];
  transcriptText: string;
  gitDiff: string;
  hasNew: boolean;
  newState: ActivityState;
}

export interface ActivityReaderDeps {
  home?: string;
  /** Injectable for tests; defaults to `git diff HEAD` in the cwd (truncated). */
  runGitDiff?: (cwd: string) => Promise<string>;
}

const MAX_DIFF = 8000;

async function defaultGitDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['diff', 'HEAD'], { cwd, maxBuffer: 1024 * 1024 });
    return stdout.length > MAX_DIFF ? stdout.slice(0, MAX_DIFF) + '\n…(truncated)' : stdout;
  } catch {
    return ''; // not a git repo, or git error
  }
}

export class ActivityReader {
  private projectDir: string;
  private runGitDiff: (cwd: string) => Promise<string>;

  constructor(private cwd: string, deps: ActivityReaderDeps = {}) {
    const home = deps.home ?? homedir();
    this.projectDir = join(home, '.claude', 'projects', encodeProjectDir(cwd));
    this.runGitDiff = deps.runGitDiff ?? defaultGitDiff;
  }

  private async activeSession(): Promise<string | null> {
    if (!existsSync(this.projectDir)) return null;
    const names = (await readdir(this.projectDir)).filter(
      (n) => n.endsWith('.jsonl') && !n.startsWith('agent-'),
    );
    let newest: { path: string; mtime: number } | null = null;
    for (const n of names) {
      const p = join(this.projectDir, n);
      const m = (await stat(p)).mtimeMs;
      if (!newest || m > newest.mtime) newest = { path: p, mtime: m };
    }
    return newest?.path ?? null;
  }

  async readActivity(state: ActivityState): Promise<ActivityResult> {
    const sessionFile = await this.activeSession();
    const gitDiff = await this.runGitDiff(this.cwd);

    if (!sessionFile) {
      return { entries: [], transcriptText: '', gitDiff, hasNew: gitDiff.trim().length > 0, newState: { sessionFile: null, byteOffset: 0 } };
    }

    const full = await readFile(sessionFile, 'utf8');
    // Reset offset if the active session changed.
    const startOffset = state.sessionFile === sessionFile ? state.byteOffset : 0;
    // Only consume up to the last complete line.
    const lastNl = full.lastIndexOf('\n');
    const consumedEnd = lastNl === -1 ? startOffset : lastNl + 1;
    const delta = consumedEnd > startOffset ? full.slice(startOffset, consumedEnd) : '';
    const entries = parseEntries(delta);
    const transcriptText = entries.map((e) => `${e.role === 'user' ? '사용자' : 'AI'}: ${e.text}`).join('\n');

    const hasNew = entries.length > 0 || gitDiff.trim().length > 0;
    return {
      entries,
      transcriptText,
      gitDiff,
      hasNew,
      newState: { sessionFile, byteOffset: consumedEnd },
    };
  }

  /** Full parsed transcript of the active session (for the read-only viewer). */
  async readFullTranscript(): Promise<TranscriptEntry[]> {
    const sessionFile = await this.activeSession();
    if (!sessionFile) return [];
    return parseEntries(await readFile(sessionFile, 'utf8'));
  }
}
```

- [ ] **Step 4: Run and confirm PASS** — `npx vitest run src/core/activity-reader.test.ts`; `npx tsc --noEmit` clean.

> Note: `git diff HEAD` runs on every read, so `hasNew` is `true` while there are uncommitted changes even without new transcript lines — the watcher's debounce and the engine's `previousMd` diff keep this from thrashing (an unchanged spec produces an empty change set). This is acceptable for SP-A.

- [ ] **Step 5: Commit**

```bash
git add src/core/activity-reader.ts src/core/activity-reader.test.ts
git commit -m "feat: ActivityReader — session delta + git diff"
```

---

## Task 4: Sync prompt

**Files:**
- Create: `src/domain/sync-prompt.ts`, `src/domain/sync-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/sync-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildSyncPrompt } from './sync-prompt';
import { SPINE_HEADINGS } from './types';

describe('buildSyncPrompt', () => {
  it('embeds spec, transcript, and diff, and asks to reconcile reality', () => {
    const prompt = buildSyncPrompt('## ✅ 핵심 기능\n- [ ] 소셜 로그인', '사용자: 로그인 만들어줘', 'diff --git a/login.tsx');
    for (const h of SPINE_HEADINGS) expect(prompt).toContain(h);
    expect(prompt).toContain('소셜 로그인');
    expect(prompt).toContain('로그인 만들어줘');
    expect(prompt).toContain('login.tsx');
    expect(prompt).toContain('[x]');
    expect(prompt).toContain('전체');
  });
});
```

- [ ] **Step 2: Run and confirm FAIL** — `npx vitest run src/domain/sync-prompt.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/domain/sync-prompt.ts
import { SPINE_HEADINGS } from './types';

export function buildSyncPrompt(
  currentSpecMarkdown: string,
  transcriptExcerpt: string,
  gitDiff: string,
): string {
  return [
    '너는 사용자가 "실제로 만든 것"을 따라 살아있는 기획서(spec.md)를 최신화하는 스크라이브다.',
    '사용자는 자기 터미널에서 직접 코딩 중이고, 아래는 최근 AI 대화 발췌와 코드 변경(git diff)이다.',
    '규칙:',
    `1) 세 고정 섹션은 항상 유지: ${SPINE_HEADINGS.join(' , ')}`,
    '2) 코드/대화로 구현이 확인된 기능은 "## ✅ 핵심 기능"에서 - [x] 로 체크한다.',
    '3) 새로 만들어진 동작은 기능 목록·해당 섹션에 추가한다.',
    '4) 기존 줄의 <!-- id: ... --> 주석은 절대 바꾸지 말고 그대로 보존한다.',
    '5) 코드로 해결된 항목은 "## 🟡 미정 / 열린 질문"에서 뺀다.',
    '6) 추측으로 없는 기능을 지어내지 말고, 대화·diff에 근거한 것만 반영한다.',
    '',
    '현재 기획서:',
    '"""',
    currentSpecMarkdown,
    '"""',
    '',
    '최근 대화 발췌:',
    '"""',
    transcriptExcerpt || '(없음)',
    '"""',
    '',
    '코드 변경(git diff):',
    '"""',
    gitDiff || '(없음)',
    '"""',
    '',
    '갱신된 기획서 마크다운 "전체"만 출력하라. 설명·코드펜스(```) 없이.',
  ].join('\n');
}
```

- [ ] **Step 4: Run and confirm PASS**; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/sync-prompt.ts src/domain/sync-prompt.test.ts
git commit -m "feat: reverse-scribe sync prompt"
```

---

## Task 5: Sync Engine

**Files:**
- Create: `src/core/sync-engine.ts`, `src/core/sync-engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/sync-engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from './spec-store';
import { FakeAgentRunner } from '../agent/fake-runner';
import { SyncEngine } from './sync-engine';
import type { ActivityResult, ActivityState } from './activity-reader';
import { ScribeResult } from '../domain/types';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'throughline-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const VALID = `## 🎯 요약
앱

## ✅ 핵심 기능
- [x] 소셜 로그인

## 🟡 미정 / 열린 질문
- 결제?
`;

// Minimal fake reader: yields one activity burst, then nothing new.
function fakeReader(bursts: ActivityResult[]) {
  let i = 0;
  return {
    readActivity: async (_s: ActivityState): Promise<ActivityResult> =>
      bursts[i++] ?? { entries: [], transcriptText: '', gitDiff: '', hasNew: false, newState: { sessionFile: null, byteOffset: 0 } },
  };
}

describe('SyncEngine.syncNow', () => {
  it('reverse-scribes the activity into spec.md and emits updated', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    const runner = new FakeAgentRunner({ completeReply: VALID });
    const reader = fakeReader([
      { entries: [{ role: 'user', text: '로그인 구현' }], transcriptText: '사용자: 로그인 구현', gitDiff: 'diff', hasNew: true, newState: { sessionFile: 's', byteOffset: 10 } },
    ]);
    const engine = new SyncEngine(store, runner, reader as any);

    let emitted: ScribeResult | undefined;
    engine.on('updated', (r: ScribeResult) => (emitted = r));

    const out = await engine.syncNow();
    expect(out).not.toBeNull();
    expect(await store.read()).toContain('- [x] 소셜 로그인 <!-- id: feat-');
    expect(emitted).toEqual(out);
  });

  it('does nothing when there is no new activity', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    const runner = new FakeAgentRunner({ completeReply: VALID });
    const reader = fakeReader([
      { entries: [], transcriptText: '', gitDiff: '', hasNew: false, newState: { sessionFile: null, byteOffset: 0 } },
    ]);
    const engine = new SyncEngine(store, runner, reader as any);
    expect(await engine.syncNow()).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm FAIL** — `npx vitest run src/core/sync-engine.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/core/sync-engine.ts
import { EventEmitter } from 'node:events';
import { AgentRunner, ScribeResult } from '../domain/types';
import { SpecStore } from './spec-store';
import { applySpecUpdate } from './apply-spec-update';
import { buildSyncPrompt } from '../domain/sync-prompt';
import type { ActivityReader, ActivityState } from './activity-reader';

/** Reverse-scribe: turns real coding activity into spec.md updates. Emits 'updated' / 'rejected'. */
export class SyncEngine extends EventEmitter {
  private state: ActivityState = { sessionFile: null, byteOffset: 0 };

  constructor(
    private store: SpecStore,
    private runner: AgentRunner,
    private reader: Pick<ActivityReader, 'readActivity'>,
  ) {
    super();
  }

  /** Read the latest activity and reconcile spec.md. Returns null if nothing to do / on failure. */
  async syncNow(signal?: AbortSignal): Promise<ScribeResult | null> {
    const activity = await this.reader.readActivity(this.state);
    this.state = activity.newState;
    if (!activity.hasNew) return null;

    const current = await this.store.read();
    let raw: string;
    try {
      raw = await this.runner.complete(
        buildSyncPrompt(current, activity.transcriptText, activity.gitDiff),
        signal,
      );
    } catch (err) {
      this.emit('rejected', [(err as Error)?.message ?? String(err)]);
      return null;
    }

    const applied = await applySpecUpdate(this.store, raw, current);
    if (!applied.ok) {
      this.emit('rejected', applied.errors);
      return null;
    }
    this.emit('updated', applied.result);
    return applied.result;
  }
}
```

- [ ] **Step 4: Run and confirm PASS**; `npx tsc --noEmit` clean; `npm test` (full suite green).

- [ ] **Step 5: Commit**

```bash
git add src/core/sync-engine.ts src/core/sync-engine.test.ts
git commit -m "feat: SyncEngine reverse-scribes activity into spec.md"
```

---

## Task 6: Workspace refactor (Session) — drop converse, add sync

**Files:**
- Modify (full rewrite): `src/server/session.ts`
- Modify: `src/server/session.test.ts`

The watcher + debounce live here: `start()` watches the repo (for code changes) and polls/reacts via the ActivityReader, debounced. To stay testable and avoid filesystem-watch flakiness in unit tests, the debounced loop is driven by `SpecStore`-style chokidar on the repo root plus a coalescing `Debouncer` (already exists). Tests cover `generateFlow`/`readTranscript`; the live watch is exercised in the manual smoke.

- [ ] **Step 1: Replace `src/server/session.ts` with:**

```ts
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
  private lastMd: string | null = null;

  constructor(deps: SessionDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.reader = deps.reader;
    this.cwd = deps.cwd;
    this.engine = new SyncEngine(deps.store, deps.runner, deps.reader);
    this.debouncer = new Debouncer(deps.debounceMs ?? 10_000);

    this.engine.on('updated', (r: ScribeResult) => {
      this.lastMd = r.md;
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
    this.watcher = chokidar.watch(this.cwd, {
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
```

> Note: `ScribeEngine`, `sendUserMessage`/`converse`, and the conversation transcript are gone. `ScribeEngine`/`scribe`/`buildScribePrompt`/`converse` remain in the codebase as still-unit-tested but now-unused modules; removing them is deferred (out of scope) to keep this change focused.

- [ ] **Step 2: Replace `src/server/session.test.ts` with:**

```ts
// src/server/session.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from '../core/spec-store';
import { ActivityReader } from '../core/activity-reader';
import { FakeAgentRunner } from '../agent/fake-runner';
import { Session } from './session';

let dir: string;
let home: string;
let session: Session | undefined;
const CWD = '/Users/u/Developer/Demo';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tl-'));
  home = await mkdtemp(join(tmpdir(), 'tl-home-'));
  await mkdir(join(home, '.claude', 'projects', '-Users-u-Developer-Demo'), { recursive: true });
});
afterEach(async () => {
  session?.stop();
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('Session', () => {
  it('readTranscript returns the parsed active session', async () => {
    const sess = join(home, '.claude', 'projects', '-Users-u-Developer-Demo', 's.jsonl');
    await writeFile(sess, JSON.stringify({ type: 'user', message: { role: 'user', content: '안녕' } }) + '\n');
    const reader = new ActivityReader(CWD, { home, runGitDiff: async () => '' });
    session = new Session({ store: new SpecStore(join(dir, 'spec.md')), runner: new FakeAgentRunner(), reader, cwd: dir });
    expect(await session.readTranscript()).toEqual([{ role: 'user', text: '안녕' }]);
  });

  it('generateFlow delegates to the runner with the flow prompt', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    await store.write('## ✅ 핵심 기능\n- [ ] 소셜 로그인\n');
    const runner = new FakeAgentRunner({ completeReply: (p) => (p.includes('소셜 로그인') ? 'flowchart TD\n A-->B' : 'X') });
    const reader = new ActivityReader(CWD, { home, runGitDiff: async () => '' });
    session = new Session({ store, runner, reader, cwd: dir });
    expect(await session.generateFlow()).toBe('flowchart TD\n A-->B');
  });
});
```

- [ ] **Step 3: Run and confirm** — `npx vitest run src/server/session.test.ts` passes (2 tests); `npx tsc --noEmit` clean. (The OLD session test about `sendUserMessage` is replaced by this file.)

- [ ] **Step 4: Commit**

```bash
git add src/server/session.ts src/server/session.test.ts
git commit -m "refactor: Session becomes activity-sync workspace (drop converse)"
```

---

## Task 7: Server routes — remove /api/chat, add /api/transcript

**Files:**
- Modify: `src/server/app.ts`, `src/server/app.test.ts`

- [ ] **Step 1: Update `src/server/app.ts`** — remove the `streamText` import and the `app.post('/api/chat', ...)` block; add a transcript route. The new file:

```ts
// src/server/app.ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Session } from './session';

export function createApp(session: Session): Hono {
  const app = new Hono();

  app.get('/api/transcript', async (c) => {
    return c.json({ entries: await session.readTranscript() });
  });

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      const current = await session.readSpec();
      await stream.writeSSE({ event: 'spec-updated', data: JSON.stringify({ md: current, changedLines: [] }) });

      const unsub = session.broadcaster.subscribe((event, data) => {
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      });
      stream.onAbort(() => unsub());
      if (stream.aborted) {
        unsub();
        return;
      }

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

- [ ] **Step 2: Update `src/server/app.test.ts`** — replace the `POST /api/chat` describe block with a transcript test (keep the `/api/flow` describe block; update imports to construct the new `Session`). The full file:

```ts
// src/server/app.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from '../core/spec-store';
import { ActivityReader } from '../core/activity-reader';
import { FakeAgentRunner } from '../agent/fake-runner';
import { Session } from './session';
import { createApp } from './app';

let dir: string;
let home: string;
let session: Session | undefined;
const CWD = '/Users/u/Developer/Demo';
const projDir = '-Users-u-Developer-Demo';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tl-'));
  home = await mkdtemp(join(tmpdir(), 'tl-home-'));
  await mkdir(join(home, '.claude', 'projects', projDir), { recursive: true });
});
afterEach(async () => {
  session?.stop();
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function mkSession(runner = new FakeAgentRunner()): Session {
  const reader = new ActivityReader(CWD, { home, runGitDiff: async () => '' });
  return new Session({ store: new SpecStore(join(dir, 'spec.md')), runner, reader, cwd: dir });
}

describe('GET /api/transcript', () => {
  it('returns the parsed transcript entries', async () => {
    await writeFile(
      join(home, '.claude', 'projects', projDir, 's.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '안녕' } }) + '\n',
    );
    session = mkSession();
    const res = await createApp(session).request('/api/transcript');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [{ role: 'user', text: '안녕' }] });
  });
});

describe('GET /api/flow', () => {
  it('returns { mermaid } from the session', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    await store.write('## ✅ 핵심 기능\n- [ ] 소셜 로그인\n');
    const reader = new ActivityReader(CWD, { home, runGitDiff: async () => '' });
    session = new Session({ store, runner: new FakeAgentRunner({ completeReply: 'flowchart TD\n A-->B' }), reader, cwd: dir });
    const res = await createApp(session).request('/api/flow');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mermaid: 'flowchart TD\n A-->B' });
  });

  it('returns { error } 500 when generation throws', async () => {
    const reader = new ActivityReader(CWD, { home, runGitDiff: async () => '' });
    const runner = { converse: async () => '', scribe: async () => '', complete: async () => { throw new Error('model down'); } };
    session = new Session({ store: new SpecStore(join(dir, 'spec.md')), runner, reader, cwd: dir });
    const res = await createApp(session).request('/api/flow');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'model down' });
  });
});
```

- [ ] **Step 3: Run and confirm** — `npx vitest run src/server/app.test.ts` (3 tests pass); `npx tsc --noEmit` clean; `npm test` full suite green.

- [ ] **Step 4: Commit**

```bash
git add src/server/app.ts src/server/app.test.ts
git commit -m "feat: /api/transcript; remove /api/chat"
```

---

## Task 8: Server entrypoint — start the sync engine

**Files:**
- Modify: `src/server/server.ts`

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
import { ActivityReader } from '../core/activity-reader';
import { Session } from './session';
import { createApp } from './app';

const cwd = process.cwd();
const specPath = join(cwd, 'spec.md');

const session = new Session({
  store: new SpecStore(specPath),
  runner: new ClaudeCodeRunner({ cwd }),
  reader: new ActivityReader(cwd),
  cwd,
});
session.start();

const app = createApp(session);

if (existsSync(join(cwd, 'dist'))) {
  app.use('/*', serveStatic({ root: './dist' }));
}

const port = Number(process.env.PORT ?? 5174);
serve({ fetch: app.fetch, port }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`Throughline → ${url}  (watching ${cwd}, editing ${specPath})`);
  if (process.env.OPEN !== '0' && existsSync(join(cwd, 'dist'))) void open(url);
});

const shutdown = () => {
  session.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` clean. Do not start the real server.

- [ ] **Step 3: Commit**

```bash
git add src/server/server.ts
git commit -m "feat: start the activity sync engine on server boot"
```

---

## Task 9: Frontend — TranscriptView replaces ChatPane

**Files:**
- Modify: `src/web/api.ts`, `src/web/App.tsx`
- Create: `src/web/TranscriptView.tsx`
- Delete: `src/web/ChatPane.tsx`

- [ ] **Step 1: Update `src/web/api.ts`** — remove `sendChat`; add transcript helpers. Replace the file with:

```ts
// src/web/api.ts
export type SpecUpdate = { md: string; changedLines: number[] };
export type TranscriptEntry = { role: 'user' | 'assistant'; text: string };

/** Subscribe to live spec + transcript updates over SSE. Returns an unsubscribe fn. */
export function subscribeEvents(handlers: {
  onSpec?: (u: SpecUpdate) => void;
  onTranscript?: (entries: TranscriptEntry[]) => void;
}): () => void {
  const es = new EventSource('/api/events');
  if (handlers.onSpec)
    es.addEventListener('spec-updated', (e) => handlers.onSpec!(JSON.parse((e as MessageEvent).data)));
  if (handlers.onTranscript)
    es.addEventListener('transcript-updated', (e) => handlers.onTranscript!(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

export async function fetchTranscript(): Promise<TranscriptEntry[]> {
  const res = await fetch('/api/transcript');
  const data = (await res.json()) as { entries?: TranscriptEntry[] };
  return data.entries ?? [];
}

/** Fetch a freshly generated mermaid user-flow for the current spec. */
export async function fetchFlow(): Promise<string> {
  const res = await fetch('/api/flow');
  const data = (await res.json()) as { mermaid?: string; error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `flow request failed (${res.status})`);
  return data.mermaid ?? '';
}
```

- [ ] **Step 2: Create `src/web/TranscriptView.tsx`:**

```tsx
// src/web/TranscriptView.tsx
import { useEffect, useRef, useState } from 'react';
import { fetchTranscript, subscribeEvents, type TranscriptEntry } from './api';

export function TranscriptView() {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchTranscript().then(setEntries).catch(() => {});
    return subscribeEvents({ onTranscript: setEntries });
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries]);

  return (
    <section className="chat">
      <header className="transcript-head">🖥️ 내 터미널 (읽기 전용 미러)</header>
      <div className="chat-log">
        {entries.length === 0 ? (
          <p className="empty">터미널에서 Claude Code로 작업을 시작하면 여기에 비춰져요.</p>
        ) : (
          entries.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Update `src/web/App.tsx`** — swap `ChatPane` for `TranscriptView` and update the SSE subscription to the new `subscribeEvents`. Replace the file with:

```tsx
// src/web/App.tsx
import { useCallback, useEffect, useState } from 'react';
import { subscribeEvents } from './api';
import { TranscriptView } from './TranscriptView';
import { ViewToolbar, type ViewId } from './ViewToolbar';
import { ResizableDivider } from './ResizableDivider';
import { RightPane } from './RightPane';

const SPLIT_KEY = 'throughline.splitWidth';

function initialSplit(): number {
  const saved = Number(localStorage.getItem(SPLIT_KEY));
  return saved >= 20 && saved <= 80 ? saved : 50;
}

export function App() {
  const [md, setMd] = useState('');
  const [changedLines, setChangedLines] = useState<number[]>([]);
  const [specRevision, setSpecRevision] = useState(0);
  const [activeView, setActiveView] = useState<ViewId | null>(null);
  const [splitWidth, setSplitWidth] = useState(initialSplit);

  useEffect(
    () =>
      subscribeEvents({
        onSpec: (u) => {
          setMd(u.md);
          setChangedLines(u.changedLines);
          setSpecRevision((r) => r + 1);
        },
      }),
    [],
  );

  const toggle = useCallback((view: ViewId) => {
    setActiveView((cur) => (cur === view ? null : view));
  }, []);

  const onResize = useCallback((rightPercent: number) => {
    const clamped = Math.min(80, Math.max(20, rightPercent));
    setSplitWidth(clamped);
    localStorage.setItem(SPLIT_KEY, String(clamped));
  }, []);

  const open = activeView !== null;

  return (
    <div className="app">
      <div className="chat-col" style={open ? { flexBasis: `${100 - splitWidth}%` } : { flex: 1 }}>
        <TranscriptView />
      </div>
      {open ? (
        <>
          <ResizableDivider onResize={onResize} />
          <div className="view-col" style={{ flexBasis: `${splitWidth}%` }}>
            <RightPane activeView={activeView} md={md} changedLines={changedLines} specRevision={specRevision} />
          </div>
        </>
      ) : null}
      <ViewToolbar active={activeView} onToggle={toggle} />
    </div>
  );
}
```

- [ ] **Step 4: Delete the old chat + add a small style** — remove `ChatPane.tsx` and append a style for the transcript header:

```bash
git rm src/web/ChatPane.tsx
```
Append to `src/web/styles.css`:
```css
.transcript-head { padding: 10px 14px; padding-right: 230px; border-bottom: 1px solid #d8dee9; background: #f8fafc; font-size: 12px; color: #475569; }
```

- [ ] **Step 5: Verify** — `npx tsc --noEmit` clean; `npm run build:web` clean (a mermaid chunk warning is fine); `npm test` full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts src/web/TranscriptView.tsx src/web/App.tsx src/web/styles.css
git commit -m "feat: read-only TranscriptView replaces the chat composer"
```

---

## Task 10: End-to-end manual smoke

No new files. Verifies the real loop against the user's actual Claude Code.

- [ ] **Step 1: Automated gates** — `npm test` (all pass), `npx tsc --noEmit` (clean), `npm run build:web` (succeeds).

- [ ] **Step 2: Run the app**

```bash
npm run dev   # → http://localhost:5173
```

- [ ] **Step 3: Drive real work in a SEPARATE terminal** — in another terminal, in this project, run your own `claude` and make a small change (e.g., ask it to add a comment to a file, or edit a file yourself). Within ~10s of going quiet:
  - the **left pane** mirrors your Claude Code turns (read-only),
  - the **📄 문서** view's `spec.md` updates to reflect what you did (feature checked off / new note),
  - the **🔀 플로우** refreshes if open,
  - the **👁 프리뷰** still shows your dev server.

- [ ] **Step 4: Capture** the result (did spec update within ~10s? any console errors?). Report; do not commit over a failed manual step.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Activity Reader (JSONL transcript + git diff, encoded path, session selection, tail delta) → Tasks 2, 3 ✓
- Sync trigger debounced-on-activity → Session watcher + `Debouncer` (Task 6) ✓
- Sync prompt (reverse-scribe) → Task 4 ✓
- Sync engine (read → complete → applySpecUpdate → broadcast) → Task 5 ✓
- `applySpecUpdate` shared helper (DRY) → Task 1 ✓
- Left = read-only transcript viewer → Task 9 (`TranscriptView`) ✓
- Remove converse/`/api/chat`/ChatPane → Tasks 6, 7, 9 ✓
- Reuse spec engine/views/preview/broadcaster → unchanged, imported ✓
- Error handling (no JSONL, sync failure, invalid md, not-git, parse error, debounce) → Tasks 3, 5, 2, 6 ✓
- JSONL coupling isolated in Activity Reader → Tasks 2, 3 ✓

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `ActivityState {sessionFile, byteOffset}` and `ActivityResult {entries, transcriptText, gitDiff, hasNew, newState}` defined in Task 3, consumed by `SyncEngine` (Task 5) and `Session` (Task 6). `TranscriptEntry {role,text}` defined in `transcript.ts` (Task 2), re-declared in `web/api.ts` (Task 9, client copy). `applySpecUpdate` signature `(store, rawMd, previousMd)` used in Tasks 1, 5. `Session` deps `{store, runner, reader, cwd, debounceMs?}` consistent across Tasks 6, 7, 8. `subscribeEvents({onSpec,onTranscript})` defined in Task 9 api.ts, used in `App` and `TranscriptView`.

**Deferred (per spec §8):** SP-B embedded PTY terminal; removing the now-unused `ScribeEngine`/`converse`/`scribe` modules; multi-CLI transcript formats; autonomous-agent direction.
