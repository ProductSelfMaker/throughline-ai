// src/domain/product-doc-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildCodeMapPrompt, buildReduceMergePrompt, buildProductDocPrompt } from './product-doc-prompt';

describe('buildCodeMapPrompt', () => {
  it('embeds the code and asks for user-facing behavior, not code internals', () => {
    const p = buildCodeMapPrompt('src/App.tsx', '<button>저장</button>');
    expect(p).toContain('<button>저장</button>');
    expect(p).toContain('user-visible');     // product perspective
    expect(p).toContain('implementation');   // explicitly excludes implementation
  });
});

describe('buildReduceMergePrompt', () => {
  it('merges summaries without losing detail', () => {
    const p = buildReduceMergePrompt('- 기능 A\n- 기능 B');
    expect(p).toContain('- 기능 A');
    expect(p).toContain('detail');
  });
});

describe('buildProductDocPrompt', () => {
  it('synthesizes the house structure from the feature summary + context', () => {
    const p = buildProductDocPrompt('- 저장 버튼: 클릭 시 저장', {
      manifest: '{"name":"demo"}',
      readme: '# Demo',
      decisions: '- 옵저버 모델',
      activity: '사용자: 저장 추가',
      truncated: true,
    });
    expect(p).toContain('- 저장 버튼: 클릭 시 저장'); // feature summary embedded verbatim
    expect(p).toContain('## Overview');
    expect(p).toContain('## Open Questions');
    expect(p).toContain('very, very detailed');        // detail demand
    expect(p).toContain('cut off by size limits');     // truncation note included
    expect(p).toContain('# Demo');                     // README context
    expect(p).toContain('옵저버 모델');                // decisions context (user's language preserved)
  });
});
