// src/domain/sync-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildSyncPrompt } from './sync-prompt';
import { SPINE_HEADINGS } from './types';

describe('buildSyncPrompt', () => {
  it('embeds the doc, transcript, and diff, and demands full product-doc output', () => {
    const prompt = buildSyncPrompt('## 개요\n기존', '사용자: 로그인 만들어줘', 'diff --git a/login.tsx');
    for (const h of SPINE_HEADINGS) expect(prompt).toContain(h);
    expect(prompt).toContain('기존');
    expect(prompt).toContain('로그인 만들어줘');
    expect(prompt).toContain('login.tsx');
    expect(prompt).toContain('FULL');
  });
});
