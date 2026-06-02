// src/domain/decisions-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildDecisionsPrompt } from './decisions-prompt';

describe('buildDecisionsPrompt', () => {
  it('embeds the activity and asks for 무엇/왜/대안 markdown only', () => {
    const p = buildDecisionsPrompt('사용자: 옵저버로 피봇');
    expect(p).toContain('옵저버로 피봇');
    expect(p).toContain('무엇');
    expect(p).toContain('왜');
    expect(p).toContain('대안');
    expect(p).toContain('마크다운');
  });
});
