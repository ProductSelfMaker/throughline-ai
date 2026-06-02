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
    const chatRes = await createApp(session).request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
    await chatRes.text();
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
