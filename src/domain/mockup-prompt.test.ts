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
});
