// src/core/spec-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from './spec-store';
import { DEFAULT_SPEC } from '../domain/types';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'throughline-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SpecStore', () => {
  it('returns DEFAULT_SPEC when the file does not exist', async () => {
    const store = new SpecStore(join(dir, 'nope', 'spec.md'));
    expect(await store.read()).toBe(DEFAULT_SPEC);
  });

  it('writes (creating parent dirs) then reads back the same content', async () => {
    const store = new SpecStore(join(dir, 'nested', 'spec.md'));
    await store.write('## 🎯 요약\nhello\n');
    expect(await store.read()).toBe('## 🎯 요약\nhello\n');
  });
});
