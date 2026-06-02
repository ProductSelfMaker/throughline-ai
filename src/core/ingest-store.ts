// src/core/ingest-store.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface State { version: 1; sessions: Record<string, number>; }

/** Durable ingestion checkpoint at <cwd>/.throughline/ingest-state.json. */
export class IngestStore {
  private file: string;
  constructor(cwd: string) { this.file = join(cwd, '.throughline', 'ingest-state.json'); }

  async load(): Promise<Record<string, number>> {
    if (!existsSync(this.file)) return {};
    try {
      const s = JSON.parse(await readFile(this.file, 'utf8')) as State;
      return s && typeof s === 'object' && s.sessions ? s.sessions : {};
    } catch {
      return {};
    }
  }

  async save(sessions: Record<string, number>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const state: State = { version: 1, sessions };
    await writeFile(this.file, JSON.stringify(state, null, 2), 'utf8');
  }
}
