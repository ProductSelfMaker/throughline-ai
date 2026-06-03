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

  it('rebuild builds the doc from a code scan (map → reduce) when source is present', async () => {
    const store = new SpecStore(join(dir, '.throughline', 'doc.md'));
    await store.write('## 개요\n옛 내용\n');
    const ingest = new IngestStore(dir);
    const reader = new FakeReader({ excerpt: '', advanced: {} }, { '/x/s1.jsonl': 5 }, '사용자: 최근 작업');

    // prompt-aware runner: distinguishes map vs final synthesis
    const calls: string[] = [];
    const runner = {
      complete: async (prompt: string) => {
        if (prompt.includes('제품 분석가다')) { calls.push('map'); return '- 저장 버튼: 클릭 시 문서를 저장한다'; }
        if (prompt.includes('제품 문서')) { calls.push('reduce'); return DOC; }
        calls.push('other'); return DOC; // decisions etc.
      },
    };
    session = new Session({
      store, runner, reader, ingest, cwd: dir, gitDiff: async () => '',
      projectCode: async () => ({ files: [{ path: 'src/App.tsx', content: '<button>저장</button>' }], truncated: false }),
    });
    const updated = new Promise<ScribeResult>((res) =>
      session!.broadcaster.subscribe((ev, d) => { if (ev === 'spec-updated') res(d as ScribeResult); }));

    await session.rebuild();
    await updated;
    expect(calls).toContain('map');               // per-chunk extraction ran
    expect(calls).toContain('reduce');             // final synthesis ran
    expect(await store.read()).toContain('## 로그인'); // code-grounded doc written
    expect(await store.read()).not.toContain('옛 내용');
    expect(await ingest.load()).toEqual({ '/x/s1.jsonl': 5 }); // checkpoint reset to "now"
  });

  it('rebuild falls back to activity-based regeneration when there is no source', async () => {
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
  });

  it('refreshDecisionsIfStale: background-regenerates on change, serves cache when unchanged', async () => {
    const store = new SpecStore(join(dir, '.throughline', 'doc.md'));
    let offsets: Record<string, number> = { '/x/s1.jsonl': 10 };
    const reader = new FakeReader({ excerpt: '', advanced: {} }, {}, '사용자: 로그인 결정');
    reader.currentOffsets = async () => offsets; // mutable for the test
    let calls = 0;
    const runner = { complete: async () => { calls += 1; return `## 의사결정 ${calls}`; } };
    session = new Session({
      store, runner, reader, ingest: new IngestStore(dir), cwd: dir, gitDiff: async () => '',
      decisionsCooldownMs: 0, // pure mark-based staleness for the test
    });
    const nextUpdate = () => new Promise<string>((res) => {
      const off = session!.broadcaster.subscribe((ev, d) => { if (ev === 'decisions-updated') { off?.(); res((d as { md: string }).md); } });
    });

    // first open: no cache → background refresh kicked off, result broadcast
    let upd = nextUpdate();
    expect(await session.refreshDecisionsIfStale()).toBe(true);
    expect(await upd).toBe('## 의사결정 1');
    expect(await session.readDecisions()).toBe('## 의사결정 1');
    expect(calls).toBe(1);

    // same offsets → not stale → serves cache, no LLM
    expect(await session.refreshDecisionsIfStale()).toBe(false);
    expect(calls).toBe(1);

    // new activity → background refresh again
    offsets = { '/x/s1.jsonl': 99 };
    upd = nextUpdate();
    expect(await session.refreshDecisionsIfStale()).toBe(true);
    expect(await upd).toBe('## 의사결정 2');
    expect(calls).toBe(2);
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

  it('generateMockup embeds the real CSS verbatim and wraps the LLM body fragment', async () => {
    const store = new SpecStore(join(dir, '.throughline', 'doc.md'));
    await store.write('## 개요\n앱\n');
    const fragment = '<div class="mock-canvas"><div class="mock-art">mock</div></div>';
    const css = '.tl{color:rebeccapurple}';
    session = new Session({
      store,
      runner: completer(fragment),
      reader: new FakeReader({ excerpt: '', advanced: {} }),
      ingest: new IngestStore(dir),
      cwd: dir,
      gitDiff: async () => '',
      uiSource: async () => ({ css, components: '// App.tsx', headLinks: '<link rel="stylesheet" href="https://x/y.css" />' }),
    });
    const out = await session.generateMockup();
    expect(out).toContain(fragment);          // LLM body fragment is included
    expect(out).toContain(css);               // real stylesheet embedded verbatim
    expect(out).toContain('https://x/y.css'); // app's own font/style links carried over
    expect(out.startsWith('<!doctype html')).toBe(true);
    expect(await session.readMockup()).toBe(out);
  });
});
