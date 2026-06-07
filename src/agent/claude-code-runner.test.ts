// src/agent/claude-code-runner.test.ts
import { describe, it, expect, vi } from 'vitest';

// Configurable SDK mock: each test sets `mockImpl` to the message stream query() yields.
let mockImpl: () => AsyncGenerator<unknown>;
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => mockImpl() }));

import { ClaudeCodeRunner, isOverloadError, withOverloadRetry, OverloadError } from './claude-code-runner';

const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const errorResult = (msg: string) => ({ type: 'result', subtype: 'success', is_error: true, result: msg });

describe('isOverloadError', () => {
  it('detects 529 / overloaded API errors only', () => {
    expect(isOverloadError('API Error: 529 {"error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe(true);
    expect(isOverloadError('overloaded')).toBe(true);
    expect(isOverloadError('some unrelated failure')).toBe(false);
  });
});

describe('withOverloadRetry', () => {
  const noSleep = async () => {};
  it('retries on OverloadError, then succeeds', async () => {
    let n = 0;
    const r = await withOverloadRetry(async () => { n++; if (n < 3) throw new OverloadError('529'); return 'ok'; }, { attempts: 3, sleep: noSleep });
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });
  it('gives up after `attempts` overloads', async () => {
    let n = 0;
    await expect(withOverloadRetry(async () => { n++; throw new OverloadError('529'); }, { attempts: 3, sleep: noSleep })).rejects.toBeInstanceOf(OverloadError);
    expect(n).toBe(3);
  });
  it('does not retry a non-overload error', async () => {
    let n = 0;
    await expect(withOverloadRetry(async () => { n++; throw new Error('boom'); }, { attempts: 3, sleep: noSleep })).rejects.toThrow('boom');
    expect(n).toBe(1);
  });
});

describe('ClaudeCodeRunner.complete', () => {
  it('concatenates assistant text blocks', async () => {
    mockImpl = async function* () { yield assistant('추가'); yield assistant('했어요'); };
    const runner = new ClaudeCodeRunner({ cwd: '/tmp' });
    expect(await runner.complete('prompt')).toBe('추가했어요');
  });

  it('surfaces an overloaded API error as OverloadError', async () => {
    mockImpl = async function* () { yield errorResult('API Error: 529 "overloaded_error" "Overloaded"'); };
    const runner = new ClaudeCodeRunner({ cwd: '/tmp', retryAttempts: 1, sleep: async () => {} });
    await expect(runner.complete('prompt')).rejects.toBeInstanceOf(OverloadError);
  });
});
