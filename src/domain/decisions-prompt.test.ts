// src/domain/decisions-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildDecisionsPrompt } from './decisions-prompt';

describe('buildDecisionsPrompt', () => {
  it('embeds the activity and asks for what/why/alternatives markdown only', () => {
    const p = buildDecisionsPrompt('사용자: 옵저버로 피봇');
    expect(p).toContain('옵저버로 피봇'); // activity embedded verbatim (user's language)
    expect(p).toContain('what');
    expect(p).toContain('why');
    expect(p).toContain('alternatives');
    expect(p).toContain('markdown');
  });
});
