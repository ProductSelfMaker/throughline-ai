// src/agent/session-log-reader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLogReader, encodeProjectDir, extractActivity } from './session-log-reader';

const CWD = '/Users/x/proj';

function line(obj: unknown): string { return JSON.stringify(obj) + '\n'; }
const userLine = (t: string) => line({ type: 'user', message: { role: 'user', content: t } });
const asstLine = (t: string, tool?: { name: string; input: unknown }) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [
    ...(t ? [{ type: 'text', text: t }] : []),
    ...(tool ? [{ type: 'tool_use', name: tool.name, input: tool.input }] : []),
  ] } });

let home: string;
let sessionDir: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tl-home-'));
  sessionDir = join(home, '.claude', 'projects', encodeProjectDir(CWD));
  await mkdir(sessionDir, { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('encodeProjectDir', () => {
  it("maps a cwd to Claude Code's dashed project dir name", () => {
    expect(encodeProjectDir('/Users/x/proj')).toBe('-Users-x-proj');
  });
});

describe('extractActivity', () => {
  it('renders user/assistant text and tool_use, skips other line types', () => {
    const lines = [
      JSON.stringify({ type: 'mode', mode: 'x' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '로그인 만들어' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: '했어요' },
        { type: 'tool_use', name: 'Write', input: { file_path: 'src/Login.tsx' } },
      ] } }),
    ];
    expect(extractActivity(lines)).toBe('사용자: 로그인 만들어\nAI: 했어요\n[도구] Write src/Login.tsx');
  });
});

describe('SessionLogReader.readNew', () => {
  it('reads new lines, advances offsets, and excludes agent-* subagent logs', async () => {
    await writeFile(join(sessionDir, 's1.jsonl'), userLine('안녕') + asstLine('네'));
    await writeFile(join(sessionDir, 'agent-abc.jsonl'), userLine('서브에이전트'));
    const reader = new SessionLogReader({ cwd: CWD, home });

    const first = await reader.readNew({});
    expect(first.excerpt).toContain('사용자: 안녕');
    expect(first.excerpt).toContain('AI: 네');
    expect(first.excerpt).not.toContain('서브에이전트');
    expect(first.advanced[join(sessionDir, 's1.jsonl')]).toBeGreaterThan(0);

    const second = await reader.readNew(first.advanced);
    expect(second.excerpt).toBe('');
  });

  it('does not consume a partial trailing line (no newline yet)', async () => {
    const f = join(sessionDir, 's2.jsonl');
    await writeFile(f, userLine('완성된 줄') + '{"type":"user","message":{"role":"user","content":"미완성');
    const reader = new SessionLogReader({ cwd: CWD, home });
    const out = await reader.readNew({});
    expect(out.excerpt).toBe('사용자: 완성된 줄');
    await writeFile(f, userLine('완성된 줄') + userLine('미완성→완성'));
    const out2 = await reader.readNew(out.advanced);
    expect(out2.excerpt).toBe('사용자: 미완성→완성');
  });

  it('bounds the read to a tail window (never loads the whole history)', async () => {
    const f = join(sessionDir, 'big.jsonl');
    let body = '';
    for (let i = 0; i < 60; i++) body += userLine(`msg-${String(i).padStart(2, '0')}`);
    await writeFile(f, body); // well over the tiny cap below
    const reader = new SessionLogReader({ cwd: CWD, home, maxReadBytes: 200, maxExcerptChars: 120 });
    const out = await reader.readNew({});
    expect(out.excerpt.length).toBeLessThanOrEqual(120);     // excerpt capped
    expect(out.excerpt).not.toContain('msg-00');             // earliest history skipped
    expect(out.excerpt).toContain('msg-59');                 // latest activity kept
    expect(out.advanced[f]).toBe(body.length);               // advanced to EOF (no re-read of the gap)
  });
});

describe('SessionLogReader.readRecent', () => {
  it('returns recent activity, excluding agent-* subagent logs', async () => {
    await writeFile(join(sessionDir, 'r1.jsonl'), userLine('최근 작업') + asstLine('완료'));
    await writeFile(join(sessionDir, 'agent-z.jsonl'), userLine('서브'));
    const out = await new SessionLogReader({ cwd: CWD, home }).readRecent(30, 1000);
    expect(out).toContain('사용자: 최근 작업');
    expect(out).toContain('AI: 완료');
    expect(out).not.toContain('서브');
  });

  it('caps to maxChars', async () => {
    let body = '';
    for (let i = 0; i < 40; i++) body += userLine(`m-${String(i).padStart(2, '0')}`);
    await writeFile(join(sessionDir, 'r2.jsonl'), body);
    const out = await new SessionLogReader({ cwd: CWD, home }).readRecent(30, 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });
});

describe('SessionLogReader.analyze', () => {
  it('aggregates tokens + per-session history, excluding agent-*', async () => {
    const asst = (text: string, usage: object, tool?: { name: string; input: unknown }) =>
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-02T00:00:00.000Z', message: { role: 'assistant', usage, content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...(tool ? [{ type: 'tool_use', name: tool.name, input: tool.input }] : []),
      ] } }) + '\n';
    await writeFile(join(sessionDir, 's1.jsonl'),
      userLine('로그인 만들어') +
      asst('했어요', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }, { name: 'Write', input: { file_path: 'a.tsx' } }));
    await writeFile(join(sessionDir, 'agent-z.jsonl'), userLine('서브'));

    const a = await new SessionLogReader({ cwd: CWD, home }).analyze(365, 64 * 1024 * 1024);
    expect(a.tokens.total).toBe(127);
    expect(a.tokens.input).toBe(100);
    expect(a.tokens.turns).toBe(1);
    expect(a.tokens.tools).toBe(1);
    expect(a.history).toHaveLength(1); // agent-* excluded
    expect(a.history[0]).toMatchObject({ title: '로그인 만들어', messages: 2, tools: 1, tokens: 127 });
  });
});

describe('SessionLogReader.currentOffsets', () => {
  it('returns byte sizes for session files, excluding agent-*', async () => {
    const s = join(sessionDir, 's1.jsonl');
    await writeFile(s, userLine('안녕'));
    await writeFile(join(sessionDir, 'agent-x.jsonl'), userLine('sub'));
    const offs = await new SessionLogReader({ cwd: CWD, home }).currentOffsets();
    expect(offs[s]).toBeGreaterThan(0);
    expect(Object.keys(offs)).toEqual([s]);
  });
});

describe('listWorkItems / readWorkItem', () => {
  const u = (t: string, ts: string) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: t } });
  const toolResultUser = () => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });

  it('splits a session into genuine user turns (newest first) with byte ranges', async () => {
    const reader = new SessionLogReader({ cwd: CWD, home });
    const content =
      u('첫 번째 작업', '2026-06-01T00:00:00Z') +
      asstLine('네 했어요', { name: 'Write', input: { file_path: 'a.ts' } }) +
      toolResultUser() +            // tool_result "user" entry — NOT a new turn
      asstLine('계속') +
      u('두 번째 작업', '2026-06-02T00:00:00Z') +
      asstLine('두 번째 응답', { name: 'Edit', input: { file_path: 'b.ts' } });
    await writeFile(join(sessionDir, 's1.jsonl'), content, 'utf8');

    const items = await reader.listWorkItems(100);
    expect(items.length).toBe(2);
    expect(items[0].title).toBe('두 번째 작업');     // newest first
    expect(items[1].title).toBe('첫 번째 작업');
    expect(items.every((i) => i.end > i.start)).toBe(true);
    expect(items[1].tools).toBe(1);                  // the Write in turn 1
  });

  it('reads one work item: conversation + tools + files touched', async () => {
    const reader = new SessionLogReader({ cwd: CWD, home });
    const content =
      u('첫 번째 작업', '2026-06-01T00:00:00Z') +
      asstLine('네 했어요', { name: 'Write', input: { file_path: 'a.ts' } }) +
      toolResultUser() +
      asstLine('계속') +
      u('두 번째 작업', '2026-06-02T00:00:00Z') +
      asstLine('두 번째 응답', { name: 'Edit', input: { file_path: 'b.ts' } });
    await writeFile(join(sessionDir, 's1.jsonl'), content, 'utf8');

    const items = await reader.listWorkItems(100);
    const first = items.find((i) => i.title === '첫 번째 작업')!;
    const detail = await reader.readWorkItem(first.file, first.start, first.end);
    expect(detail).not.toBeNull();
    expect(detail!.title).toBe('첫 번째 작업');
    expect(detail!.filesTouched).toContain('a.ts');
    expect(detail!.filesTouched).not.toContain('b.ts');  // that's the next turn
    expect(detail!.messages.some((m) => m.role === 'user' && m.text === '첫 번째 작업')).toBe(true);
    expect(detail!.messages.some((m) => m.role === 'assistant' && m.tools.some((t) => t.name === 'Write'))).toBe(true);
  });

  it('rejects path traversal in readWorkItem', async () => {
    const reader = new SessionLogReader({ cwd: CWD, home });
    expect(await reader.readWorkItem('../../etc/passwd', 0, 10)).toBeNull();
  });
});
