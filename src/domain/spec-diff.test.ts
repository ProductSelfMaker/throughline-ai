// src/domain/spec-diff.test.ts
import { describe, it, expect } from 'vitest';
import { changedLineNumbers } from './spec-diff';

describe('changedLineNumbers', () => {
  it('flags a single changed line (0-based, in the new text)', () => {
    expect(changedLineNumbers('a\nb\nc\n', 'a\nB\nc\n')).toEqual([1]);
  });

  it('flags all lines when starting from empty', () => {
    expect(changedLineNumbers('', 'x\ny\n')).toEqual([0, 1]);
  });

  it('returns empty when unchanged', () => {
    expect(changedLineNumbers('a\nb\n', 'a\nb\n')).toEqual([]);
  });
});
