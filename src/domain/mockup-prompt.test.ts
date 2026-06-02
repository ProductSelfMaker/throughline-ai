// src/domain/mockup-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildMockupPrompt } from './mockup-prompt';

describe('buildMockupPrompt', () => {
  it('embeds the product doc and asks for a self-contained HTML mockup', () => {
    const p = buildMockupPrompt('## 개요\n로그인 서비스');
    expect(p).toContain('로그인 서비스');
    expect(p).toContain('HTML');
    expect(p).toContain('아트보드');
  });

  it('instructs reading the real UI source for pixel-faithful, all-state output', () => {
    const p = buildMockupPrompt('## 개요');
    expect(p).toContain('실제 코드');
    expect(p).toContain('100%');
    // interactive / interrupt states must be covered
    expect(p).toContain('모달');
  });
});
