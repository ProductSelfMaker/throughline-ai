// src/server/session.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from '../core/spec-store';
import { FakeAgentRunner } from '../agent/fake-runner';
import { Session } from './session';

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

describe('Session', () => {
  it('streams converse tokens, records the transcript, and on flush scribes + broadcasts', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    const runner = new FakeAgentRunner({ converseReply: 'hello', scribeReply: VALID });
    session = new Session({ store, runner, debounceMs: 1000 });

    const events: { event: string; data: unknown }[] = [];
    session.broadcaster.subscribe((event, data) => events.push({ event, data }));

    const updated = new Promise<void>((resolve) =>
      session.engine.once('updated', () => resolve()),
    );

    const tokens: string[] = [];
    const reply = await session.sendUserMessage('hi', (t) => tokens.push(t));

    expect(reply).toBe('hello');
    expect(tokens.join('')).toBe('hello');
    expect(session.transcript).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);

    session.flush();
    await updated;

    expect(await store.read()).toContain('- [ ] 소셜 로그인 <!-- id: feat-');
    expect(events.some((e) => e.event === 'spec-updated')).toBe(true);
  });
});
