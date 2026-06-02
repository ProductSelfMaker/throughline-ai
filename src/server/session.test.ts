// src/server/session.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from '../core/spec-store';
import { IngestStore } from '../core/ingest-store';
import { Session } from './session';
import { ActivityBatch, ActivityReader, ScribeResult } from '../domain/types';

const DOC = `## 개요\n로그인 중심 서비스.\n\n## 로그인\n**무엇** 이메일·비밀번호 인증.\n\n## 열린 질문\n- 결제?\n`;

class FakeReader implements ActivityReader {
  constructor(
    private batch: ActivityBatch,
    private offsets: Record<string, number> = {},
    private recent: string = '',
  ) {}
  async readNew(): Promise<ActivityBatch> { return this.batch; }
  async currentOffsets(): Promise<Record<string, number>> { return this.offsets; }
  async readRecent(): Promise<string> { return this.recent; }
  async analyze() {
    return { tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0, tools: 0, perDay: [] }, history: [], approx: false };
  }
  watch(): () => void { return () => {}; }
}
const completer = (reply: string) => ({ complete: async () => reply });

let dir: string;
let session: Session | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tl-')); });
afterEach(async () => { session?.stop(); await rm(dir, { recursive: true, force: true }); });

describe('Session (observer)', () => {
  it('first run observes from "now": seeds the checkpoint from current offsets, does not ingest history', async () => {
    const store = new SpecStore(join(dir, '.throughline', 'doc.md'));
    const ingest = new IngestStore(dir);
    const reader = new FakeReader({ excerpt: '사용자: 옛 활동', advanced: { '/x/s1.jsonl': 999 } }, { '/x/s1.jsonl': 500 });
    session = new Session({ store, runner: completer(DOC), reader, ingest, cwd: dir, gitDiff: async () => '' });
    let broadcasts = 0;
    session.broadcaster.subscribe(() => { broadcasts += 1; });

    await session.init();
    expect(await ingest.load()).toEqual({ '/x/s1.jsonl': 500 });
    expect(broadcasts).toBe(0);
  });

  it('with an existing checkpoint, init folds new activity into the doc and broadcasts', async () => {
    const store = new SpecStore(join(dir, '.throughline', 'doc.md'));
    const ingest = new IngestStore(dir);
    await ingest.save({ '/x/s1.jsonl': 1 });
    const reader = new FakeReader({ excerpt: '사용자: 로그인 만들어', advanced: { '/x/s1.jsonl': 42 } });
    session = new Session({ store, runner: completer(DOC), reader, ingest, cwd: dir, gitDiff: async () => 'diff' });

    const updated = new Promise<ScribeResult>((res) =>
      session!.broadcaster.subscribe((ev, d) => { if (ev === 'spec-updated') res(d as ScribeResult); }));

    await session.init();
    await updated;
    expect(await store.read()).toContain('## 로그인');
    expect(await ingest.load()).toEqual({ '/x/s1.jsonl': 42 });
  });

  it('rebuild resets the doc from recent activity, advances the checkpoint, and broadcasts', async () => {
    const store = new SpecStore(join(dir, '.throughline', 'doc.md'));
    await store.write('## 개요\n옛 내용\n');
    const ingest = new IngestStore(dir);
    const reader = new FakeReader({ excerpt: '', advanced: {} }, { '/x/s1.jsonl': 77 }, '사용자: 최근 작업');
    session = new Session({ store, runner: completer(DOC), reader, ingest, cwd: dir, gitDiff: async () => '' });
    const updated = new Promise<ScribeResult>((res) =>
      session!.broadcaster.subscribe((ev, d) => { if (ev === 'spec-updated') res(d as ScribeResult); }));
    await session.rebuild();
    await updated;
    expect(await store.read()).toContain('## 로그인');
    expect(await store.read()).not.toContain('옛 내용');
    expect(await ingest.load()).toEqual({ '/x/s1.jsonl': 77 });
    expect((await session.readDecisions()).trim().length).toBeGreaterThan(0); // decisions regenerated too
  });

  it('curate applies an instruction and broadcasts', async () => {
    const store = new SpecStore(join(dir, '.throughline', 'doc.md'));
    const reader = new FakeReader({ excerpt: '', advanced: {} });
    session = new Session({ store, runner: completer(DOC), reader, ingest: new IngestStore(dir), cwd: dir, gitDiff: async () => '' });
    await session.init();
    const updated = new Promise<ScribeResult>((res) =>
      session!.broadcaster.subscribe((ev, d) => { if (ev === 'spec-updated') res(d as ScribeResult); }));
    await session.curate('리스크 섹션 추가');
    await updated;
    expect(await store.read()).toContain('## 개요');
  });

  it('generateMockup stores and returns the generated HTML', async () => {
    const store = new SpecStore(join(dir, '.throughline', 'doc.md'));
    await store.write('## 개요\n앱\n');
    const html = '<!doctype html><html><body>mock</body></html>';
    session = new Session({ store, runner: completer(html), reader: new FakeReader({ excerpt: '', advanced: {} }), ingest: new IngestStore(dir), cwd: dir, gitDiff: async () => '' });
    expect(await session.generateMockup()).toBe(html);
    expect(await session.readMockup()).toBe(html);
  });
});
