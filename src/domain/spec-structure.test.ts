// src/domain/spec-structure.test.ts
import { describe, it, expect } from 'vitest';
import { validateSpec, ensureSpine } from './spec-structure';
import { DEFAULT_SPEC, SPINE_HEADINGS } from './types';

describe('validateSpec', () => {
  it('accepts a doc containing all spine headings', () => {
    expect(validateSpec(DEFAULT_SPEC)).toEqual({ ok: true, errors: [] });
  });

  it('reports each missing spine heading', () => {
    const result = validateSpec('## Overview\n\nhello\n');
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['missing spine heading: ## Open Questions']);
  });
});

describe('ensureSpine', () => {
  it('leaves a complete doc unchanged', () => {
    expect(ensureSpine(DEFAULT_SPEC)).toBe(DEFAULT_SPEC);
  });

  it('appends missing spine headings while preserving existing content', () => {
    const healed = ensureSpine('## Overview\n앱 설명\n');
    for (const h of SPINE_HEADINGS) expect(healed).toContain(h);
    expect(healed).toContain('앱 설명');
  });
});
