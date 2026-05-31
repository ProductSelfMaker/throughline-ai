// src/agent/fake-runner.ts
import { AgentRunner, Message } from '../domain/types';

type ScribeReply = string | ((cur: string, transcript: Message[]) => string);

export class FakeAgentRunner implements AgentRunner {
  constructor(
    private opts: { converseReply?: string; scribeReply?: ScribeReply } = {},
  ) {}

  async converse(
    _transcript: Message[],
    onToken: (t: string) => void,
  ): Promise<string> {
    const reply = this.opts.converseReply ?? 'ok';
    for (const ch of reply) onToken(ch);
    return reply;
  }

  async scribe(cur: string, transcript: Message[]): Promise<string> {
    const r = this.opts.scribeReply ?? cur;
    return typeof r === 'function' ? r(cur, transcript) : r;
  }
}
