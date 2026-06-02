// src/agent/claude-code-runner.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: 'src/Login.tsx' } },
            { type: 'text', text: '추가' },
            { type: 'text', text: '했어요' },
          ],
        },
      };
    })(),
}));

import { ClaudeCodeRunner } from './claude-code-runner';

describe('ClaudeCodeRunner.converse', () => {
  it('emits tool + text events and returns the full text', async () => {
    const runner = new ClaudeCodeRunner({ cwd: '/tmp' });
    const events: any[] = [];
    const reply = await runner.converse([{ role: 'user', content: 'hi' }], (e) => events.push(e));
    expect(events).toEqual([
      { type: 'tool', name: 'Edit', target: 'src/Login.tsx' },
      { type: 'text', text: '추가' },
      { type: 'text', text: '했어요' },
    ]);
    expect(reply).toBe('추가했어요');
  });
});
