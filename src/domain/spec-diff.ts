// src/domain/spec-diff.ts
import { diffLines } from 'diff';

/** Returns 0-based indices of added/changed lines in `newMd`. */
export function changedLineNumbers(oldMd: string, newMd: string): number[] {
  const changed: number[] = [];
  let lineIdx = 0;
  for (const part of diffLines(oldMd, newMd)) {
    const count = part.count ?? part.value.split('\n').length;
    if (part.added) {
      for (let i = 0; i < count; i++) changed.push(lineIdx + i);
      lineIdx += count;
    } else if (part.removed) {
      // removed lines do not exist in the new text — don't advance
    } else {
      lineIdx += count;
    }
  }
  return changed;
}
