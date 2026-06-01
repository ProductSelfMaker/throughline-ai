// src/agent/claude-code-runner.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentRunner, Message } from '../domain/types';
import { buildScribePrompt } from '../domain/scribe-prompt';

function transcriptToPrompt(transcript: Message[]): string {
  return transcript
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
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

async function collectAssistantText(
  prompt: string,
  cwd: string | undefined,
  onToken: ((t: string) => void) | undefined,
  signal?: AbortSignal,
): Promise<string> {
  let full = '';
  // Options.cwd and Options.abortController are both present in the 0.1.77 types.
  // SDKAssistantMessage has: { type: 'assistant', message: BetaMessage }
  // BetaMessage.content is BetaContentBlock[], where text blocks are { type: 'text', text: string }.
  for await (const msg of query({
    prompt,
    options: { cwd, abortController: abortControllerFor(signal) },
  })) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          full += block.text;
          onToken?.(block.text);
        }
      }
    }
  }
  return full;
}

export class ClaudeCodeRunner implements AgentRunner {
  constructor(private options: { cwd?: string } = {}) {}

  converse(
    transcript: Message[],
    onToken: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    return collectAssistantText(
      transcriptToPrompt(transcript),
      this.options.cwd,
      onToken,
      signal,
    );
  }

  async scribe(
    currentSpecMarkdown: string,
    transcript: Message[],
    signal?: AbortSignal,
  ): Promise<string> {
    const text = await collectAssistantText(
      buildScribePrompt(currentSpecMarkdown, transcript),
      this.options.cwd,
      undefined,
      signal,
    );
    return stripCodeFence(text);
  }

  async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    const text = await collectAssistantText(prompt, this.options.cwd, undefined, signal);
    return stripCodeFence(text);
  }
}
