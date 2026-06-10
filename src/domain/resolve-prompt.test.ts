import { describe, it, expect } from 'vitest';
import { buildResolvePrompt } from './resolve-prompt';

describe('buildResolvePrompt', () => {
  it('embeds the current doc, the conflict question, and the user answer; demands full output', () => {
    const p = buildResolvePrompt('## Overview\n현재 문서', 'A says X, B says Y — which?', '저장은 자동으로');
    expect(p).toContain('현재 문서');
    expect(p).toContain('A says X, B says Y — which?');
    expect(p).toContain('저장은 자동으로');
    expect(p).toContain('## Overview');     // keep the spine
    expect(p).toContain('FULL');             // full updated doc
  });
});
