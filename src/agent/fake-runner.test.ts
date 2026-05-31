// src/agent/fake-runner.test.ts
import { describe, it, expect } from 'vitest';
import { FakeAgentRunner } from './fake-runner';

describe('FakeAgentRunner', () => {
  it('streams the scripted converse reply char by char and returns the whole thing', async () => {
    const runner = new FakeAgentRunner({ converseReply: 'hi' });
    const tokens: string[] = [];
    const full = await runner.converse([], (t) => tokens.push(t));
    expect(tokens).toEqual(['h', 'i']);
    expect(full).toBe('hi');
  });

  it('returns a scripted scribe reply, supporting a function form', async () => {
    const runner = new FakeAgentRunner({
      scribeReply: (cur) => cur + '\n## ✅ 핵심 기능\n- [ ] 새 기능',
    });
    expect(await runner.scribe('## 🎯 요약', [])).toBe(
      '## 🎯 요약\n## ✅ 핵심 기능\n- [ ] 새 기능',
    );
  });
});
