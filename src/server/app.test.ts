// src/server/app.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from '../core/spec-store';
import { FakeAgentRunner } from '../agent/fake-runner';
import { Session } from './session';
import { createApp } from './app';

let dir: string;
let session: Session;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'throughline-'));
});
afterEach(async () => {
  session?.close();
  await rm(dir, { recursive: true, force: true });
});

const VALID = `## 🎯 요약
앱

## ✅ 핵심 기능
- [ ] 소셜 로그인

## 🟡 미정 / 열린 질문
- 결제?
`;

describe('createApp POST /api/chat', () => {
  it('streams the converse reply and triggers a scribe that updates the store', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    const runner = new FakeAgentRunner({ converseReply: 'hi there', scribeReply: VALID });
    session = new Session({ store, runner, debounceMs: 1000 });
    const app = createApp(session);

    const updated = new Promise<void>((resolve) =>
      session.engine.once('updated', () => resolve()),
    );

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '로그인 소셜만' }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hi there');

    session.flush();
    await updated;
    expect(await store.read()).toContain('## ✅ 핵심 기능');
  });
});

describe('createApp GET /api/flow', () => {
  it('returns { mermaid } from the session', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    await store.write('## ✅ 핵심 기능\n- [ ] 소셜 로그인\n');
    const runner = new FakeAgentRunner({ completeReply: 'flowchart TD\n  A-->B' });
    session = new Session({ store, runner });
    const app = createApp(session);

    const res = await app.request('/api/flow');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mermaid: 'flowchart TD\n  A-->B' });
  });

  it('returns { error } with 500 when generation throws', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    const runner = {
      converse: async () => '',
      scribe: async () => '',
      complete: async () => {
        throw new Error('model down');
      },
    };
    session = new Session({ store, runner });
    const app = createApp(session);

    const res = await app.request('/api/flow');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'model down' });
  });
});
