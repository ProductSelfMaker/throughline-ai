// src/agent/claude-code-runner.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentRunner, Message } from '../domain/types';
import { buildScribePrompt } from '../domain/scribe-prompt';

/** A transient, retryable provider error (HTTP 529 / "overloaded"). */
export class OverloadError extends Error {}

/** Is this API error message a transient overload we should retry? */
export function isOverloadError(text: string): boolean {
  return /\b529\b|overloaded/i.test(text);
}

/** Run `fn`, retrying with exponential backoff only on OverloadError (transient overload). */
export async function withOverloadRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i < attempts - 1 && e instanceof OverloadError) {
        await sleep(800 * 2 ** i); // 0.8s, 1.6s, …
        continue;
      }
      throw e;
    }
  }
}

function abortControllerFor(signal?: AbortSignal): AbortController | undefined {
  if (!signal) return undefined;
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

/** Strips a single ```...``` fence if the model wrapped the whole answer in one. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return fence ? fence[1] : trimmed;
}

/** Turn an API error string into the right error type (overload = retryable). */
function classify(text: string): Error {
  return isOverloadError(text) ? new OverloadError(text) : new Error(text);
}

async function collect(prompt: string, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  let full = '';
  let resultErr = '';
  try {
    for await (const msg of query({ prompt, options: { cwd, abortController: abortControllerFor(signal) } })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') full += block.text;
        }
      } else if (msg.type === 'result' && (msg as { is_error?: boolean }).is_error) {
        // the SDK reports API errors (e.g. 529 overloaded) in the result message
        resultErr = String((msg as { result?: unknown }).result ?? 'unknown agent error');
      }
    }
  } catch (e) {
    // the process often exits non-zero AFTER emitting the error result — prefer that detail
    if (resultErr) throw classify(resultErr);
    throw e;
  }
  if (resultErr) throw classify(resultErr);
  return full;
}

export class ClaudeCodeRunner implements AgentRunner {
  constructor(private options: { cwd?: string; retryAttempts?: number; sleep?: (ms: number) => Promise<void> } = {}) {}

  private run(prompt: string, signal?: AbortSignal): Promise<string> {
    return withOverloadRetry(
      () => collect(prompt, this.options.cwd, signal).then(stripCodeFence),
      { attempts: this.options.retryAttempts ?? 3, sleep: this.options.sleep },
    );
  }

  async scribe(currentSpecMarkdown: string, transcript: Message[], signal?: AbortSignal): Promise<string> {
    return this.run(buildScribePrompt(currentSpecMarkdown, transcript), signal);
  }

  async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    return this.run(prompt, signal);
  }
}
