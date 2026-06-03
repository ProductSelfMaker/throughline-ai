// src/domain/spec-doc.test.ts
import { describe, it, expect } from 'vitest';
import { getHeadings, parseOpenQuestions, parseSpec } from './spec-doc';

// English spine, with feature section names + prose in the user's language.
const SPEC = `---
title: Demo
---

## Overview
로그인 중심 서비스.

## 로그인
**무엇** 이메일·비밀번호 인증.
**요소** 이메일 입력, 비밀번호, 로그인 버튼.

## Open Questions
- 결제 수단은?
- 무료 한도는?
`;

describe('getHeadings', () => {
  it('returns every ## heading, trimmed', () => {
    expect(getHeadings(SPEC)).toEqual(['## Overview', '## 로그인', '## Open Questions']);
  });
});

describe('parseOpenQuestions', () => {
  it('parses the Open Questions bullets', () => {
    expect(parseOpenQuestions(SPEC)).toEqual(['결제 수단은?', '무료 한도는?']);
  });
});

describe('parseSpec', () => {
  it('returns open questions and headings together', () => {
    const parsed = parseSpec(SPEC);
    expect(parsed.headings).toEqual(['## Overview', '## 로그인', '## Open Questions']);
    expect(parsed.openQuestions).toEqual(['결제 수단은?', '무료 한도는?']);
  });
});
