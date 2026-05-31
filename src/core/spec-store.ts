// src/core/spec-store.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { DEFAULT_SPEC } from '../domain/types';

export class SpecStore {
  constructor(private filePath: string) {}

  async read(): Promise<string> {
    if (!existsSync(this.filePath)) return DEFAULT_SPEC;
    return readFile(this.filePath, 'utf8');
  }

  async write(md: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, md, 'utf8');
  }

  /** Calls onChange(newContent) when the file is modified externally. Returns an unsubscribe fn. */
  watch(onChange: (md: string) => void): () => void {
    const w: FSWatcher = chokidar.watch(this.filePath, { ignoreInitial: true });
    w.on('change', async () => onChange(await this.read()));
    return () => void w.close();
  }
}
