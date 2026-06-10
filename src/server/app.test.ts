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
  async listWorkItems() { return []; },
  async readWorkItem() { return null; },
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

/** Wrap a single Session as the app host (a default workspace) for endpoint tests. */
const DEF = { id: 'default', name: 'Default', isDefault: true };
function host(s: Session) {
  return {
    active: () => s,
    broadcaster: s.broadcaster,
    list: () => [DEF],
    activeInfo: () => DEF,
    create: async (name: string) => ({ id: 'ws1', name, isDefault: false }),
    select: async () => true,
    remove: async (id: string) => id !== 'default',
    mergeAll: async () => ({ md: '## Overview\nMERGED', conflicts: [{ id: 'c1', question: 'A vs B?' }] }),
    resolveConflict: async (_id: string, _answer: string) => ({ md: '## Overview\nRESOLVED', conflicts: [] }),
    readUnified: async () => ({ md: '', conflicts: [] }),
  };
}

describe('POST /api/curate', () => {
  it('400s on empty instruction', async () => {
    session = mk();
    const res = await createApp(host(session)).request('/api/curate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: '  ' }),
    });
    expect(res.status).toBe(400);
  });

  it('applies a curation instruction', async () => {
    const PRD = `## 📌 개요\nX\n\n## 🎯 목표\n- a\n\n## ✅ 기능 요구사항\n- [ ] b\n\n## ❓ 미해결 질문\n- c\n`;
    session = mk(PRD);
    const res = await createApp(host(session)).request('/api/curate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: '리스크 추가' }),
    });
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('POST /api/jobs/:kind', () => {
  it('starts a job, reports it running, then clears it on completion', async () => {
    const PRD = `## 📌 개요\nX\n\n## 🎯 목표\n- a\n\n## ✅ 기능 요구사항\n- [ ] b\n\n## ❓ 미해결 질문\n- c\n`;
    session = mk(PRD);
    const app = createApp(host(session));
    const done = new Promise<void>((res) =>
      session!.broadcaster.subscribe((ev, d) => { if (ev === 'job-updated' && (d as { status: string }).status === 'done') res(); }));
    const res = await app.request('/api/jobs/doc', { method: 'POST' });
    const body = (await res.json()) as { started: boolean; running: string[] };
    expect(body.started).toBe(true);
    expect(body.running).toContain('doc');
    await done;
    expect(session.runningJobs()).toEqual([]);
  });

  it('400s on an unknown job kind', async () => {
    session = mk();
    const res = await createApp(host(session)).request('/api/jobs/bogus', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('/api/mockup', () => {
  it('GET returns "" when none; the mockup job generates the assembled html', async () => {
    session = mk('<div class="mock-canvas">m</div>');
    const app = createApp(host(session));
    expect(await (await app.request('/api/mockup')).json()).toEqual({ html: '' });

    const done = new Promise<void>((res) =>
      session!.broadcaster.subscribe((ev, d) => { if (ev === 'job-updated' && (d as { status: string }).status === 'done') res(); }));
    const post = await app.request('/api/jobs/mockup', { method: 'POST' });
    expect(((await post.json()) as { started: boolean }).started).toBe(true);
    await done;

    const { html } = (await (await app.request('/api/mockup')).json()) as { html: string };
    expect(html.startsWith('<!doctype html')).toBe(true);
    expect(html).toContain('<div class="mock-canvas">m</div>'); // fragment wrapped into a full doc
  });
});

describe('/api/history', () => {
  it('lists work items and validates the detail request', async () => {
    session = mk();
    const app = createApp(host(session));
    expect(await (await app.request('/api/history')).json()).toEqual({ items: [] });
    expect((await app.request('/api/history/item')).status).toBe(400);          // missing params
    expect((await app.request('/api/history/item?file=s1&start=0&end=10')).status).toBe(404); // none
  });
});

describe('GET /api/info', () => {
  it('reports the observed project directory', async () => {
    session = mk();
    const res = await createApp(host(session)).request('/api/info');
    const data = (await res.json()) as { cwd: string; display: string };
    expect(data.cwd).toBe(dir);
    expect(typeof data.display).toBe('string');
    expect(data.display.length).toBeGreaterThan(0);
  });
});

describe('GET /api/decisions', () => {
  it('returns the cached decisions ledger + refreshing flag ([] / false when none yet)', async () => {
    session = mk();
    const res = await createApp(host(session)).request('/api/decisions');
    expect(await res.json()).toEqual({ items: [], refreshing: false });
  });
});

describe('GET /api/architecture', () => {
  it('returns the architecture doc + freshness ("" / null when none yet)', async () => {
    session = mk();
    const res = await createApp(host(session)).request('/api/architecture');
    expect(await res.json()).toEqual({ md: '', freshness: null });
  });
});

describe('GET /api/doc-freshness', () => {
  it('returns null before any doc Rebuild', async () => {
    session = mk();
    const res = await createApp(host(session)).request('/api/doc-freshness');
    expect(await res.json()).toBeNull();
  });
});

describe('GET /api/analytics', () => {
  it('returns project analytics + self (null when no self-reader is wired)', async () => {
    session = mk();
    const res = await createApp(host(session)).request('/api/analytics');
    expect(await res.json()).toEqual({
      project: {
        tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0, tools: 0, perDay: [] },
        history: [],
        approx: false,
      },
      self: null,
    });
  });
});

describe('GET /api/flow', () => {
  it('returns { mermaid }', async () => {
    session = mk('flowchart TD\n A-->B');
    const res = await createApp(host(session)).request('/api/flow');
    expect(await res.json()).toEqual({ mermaid: 'flowchart TD\n A-->B' });
  });
});

describe('/api/workspaces', () => {
  it('lists, creates, and selects workspaces', async () => {
    session = mk();
    const app = createApp(host(session));
    expect(await (await app.request('/api/workspaces')).json()).toEqual({ active: 'default', workspaces: [DEF] });
    const created = await (await app.request('/api/workspaces', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Beta' }),
    })).json();
    expect(created).toEqual({ id: 'ws1', name: 'Beta', isDefault: false });
    const sel = await app.request('/api/workspaces/ws1/select', { method: 'POST' });
    expect(await sel.json()).toEqual({ ok: true, active: DEF });
  });

  it('deletes a non-default workspace (400 for default)', async () => {
    session = mk();
    const app = createApp(host(session));
    expect((await app.request('/api/workspaces/default/delete', { method: 'POST' })).status).toBe(400);
    expect(await (await app.request('/api/workspaces/ws1/delete', { method: 'POST' })).json()).toEqual({ ok: true });
  });
});

describe('/api/unified', () => {
  it('merges and resolves conflicts', async () => {
    session = mk();
    const app = createApp(host(session));
    const merged = await (await app.request('/api/unified/merge', { method: 'POST' })).json();
    expect(merged).toEqual({ md: '## Overview\nMERGED', conflicts: [{ id: 'c1', question: 'A vs B?' }] });
    expect((await app.request('/api/unified/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'c1' }) })).status).toBe(400); // answer required
    const resolved = await (await app.request('/api/unified/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'c1', answer: '자동' }),
    })).json();
    expect(resolved).toEqual({ md: '## Overview\nRESOLVED', conflicts: [] });
  });
});
