// src/domain/curate-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildCuratePrompt } from './curate-prompt';
import { SPINE_HEADINGS } from './types';

describe('buildCuratePrompt', () => {
  it('embeds the instruction, current doc, spine, diff, and demands full output', () => {
    const p = buildCuratePrompt('## 개요\n기존', '리스크 섹션 추가해', 'diff --git a/x');
    expect(p).toContain('리스크 섹션 추가해');
    expect(p).toContain('기존');
    for (const h of SPINE_HEADINGS) expect(p).toContain(h);
    expect(p).toContain('x');
    expect(p).toContain('FULL');
  });
});
