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
