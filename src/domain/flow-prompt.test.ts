// src/domain/flow-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildFlowPrompt } from './flow-prompt';

describe('buildFlowPrompt', () => {
  it('embeds the spec and demands mermaid-only flowchart output', () => {
    const prompt = buildFlowPrompt('## ✅ 핵심 기능\n- [ ] 소셜 로그인');
    expect(prompt).toContain('## ✅ 핵심 기능');
    expect(prompt).toContain('소셜 로그인');
    expect(prompt).toContain('flowchart TD');
    expect(prompt).toContain('mermaid');
    expect(prompt).toContain('코드만');
  });
});
