// src/core/ingest-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IngestStore } from './ingest-store';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tl-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('IngestStore', () => {
  it('returns {} when no state file exists', async () => {
    expect(await new IngestStore(dir).load()).toEqual({});
  });

  it('saves and loads the per-session offsets (creating .throughline)', async () => {
    const s = new IngestStore(dir);
    await s.save({ '/a/s1.jsonl': 120, '/a/s2.jsonl': 5 });
    expect(await new IngestStore(dir).load()).toEqual({ '/a/s1.jsonl': 120, '/a/s2.jsonl': 5 });
  });

  it('returns {} on corrupt state', async () => {
    await mkdir(join(dir, '.throughline'), { recursive: true });
    await writeFile(join(dir, '.throughline', 'ingest-state.json'), 'not json');
    expect(await new IngestStore(dir).load()).toEqual({});
  });
});
