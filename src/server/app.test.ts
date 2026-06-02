// src/server/app.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from '../core/spec-store';
import { IngestStore } from '../core/ingest-store';
import { Session } from './session';
import { createApp } from './app';
import { ActivityReader } from '../domain/types';

const idleReader: ActivityReader = {
  async readNew() { return { excerpt: '', advanced: {} }; },
  async currentOffsets() { return {}; },
  async readRecent() { return ''; },
  async analyze() {
    return { tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0, tools: 0, perDay: [] }, history: [], approx: false };
  },
  watch() { return () => {}; },
};

let dir: string;
let session: Session | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tl-')); });
afterEach(async () => { session?.stop(); await rm(dir, { recursive: true, force: true }); });

function mk(reply = '') {
  return new Session({
    store: new SpecStore(join(dir, '.throughline', 'prd.md')),
    runner: { complete: async () => reply },
    reader: idleReader,
    ingest: new IngestStore(dir),
    cwd: dir,
    gitDiff: async () => '',
  });
}

describe('POST /api/curate', () => {
  it('400s on empty instruction', async () => {
    session = mk();
    const res = await createApp(session).request('/api/curate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: '  ' }),
    });
    expect(res.status).toBe(400);
  });

  it('applies a curation instruction', async () => {
    const PRD = `## 📌 개요\nX\n\n## 🎯 목표\n- a\n\n## ✅ 기능 요구사항\n- [ ] b\n\n## ❓ 미해결 질문\n- c\n`;
    session = mk(PRD);
    const res = await createApp(session).request('/api/curate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: '리스크 추가' }),
    });
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('POST /api/rebuild', () => {
  it('rebuilds and returns ok', async () => {
    const PRD = `## 📌 개요\nX\n\n## 🎯 목표\n- a\n\n## ✅ 기능 요구사항\n- [ ] b\n\n## ❓ 미해결 질문\n- c\n`;
    session = mk(PRD);
    const res = await createApp(session).request('/api/rebuild', { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('/api/mockup', () => {
  it('GET returns "" when none; POST generates and returns the html', async () => {
    session = mk('<html>m</html>');
    const app = createApp(session);
    expect(await (await app.request('/api/mockup')).json()).toEqual({ html: '' });
    const post = await app.request('/api/mockup', { method: 'POST' });
    expect(await post.json()).toEqual({ html: '<html>m</html>' });
  });
});

describe('GET /api/decisions', () => {
  it('returns the decisions doc ("" when none yet)', async () => {
    session = mk();
    const res = await createApp(session).request('/api/decisions');
    expect(await res.json()).toEqual({ md: '' });
  });
});

describe('GET /api/analytics', () => {
  it('returns tokens + history', async () => {
    session = mk();
    const res = await createApp(session).request('/api/analytics');
    expect(await res.json()).toEqual({
      tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0, tools: 0, perDay: [] },
      history: [],
      approx: false,
    });
  });
});

describe('GET /api/flow', () => {
  it('returns { mermaid }', async () => {
    session = mk('flowchart TD\n A-->B');
    const res = await createApp(session).request('/api/flow');
    expect(await res.json()).toEqual({ mermaid: 'flowchart TD\n A-->B' });
  });
});
