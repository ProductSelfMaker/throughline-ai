// src/core/activity-reader.ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encodeProjectDir, parseEntries, TranscriptEntry } from './transcript';

const execFileP = promisify(execFile);

export interface ActivityState {
  sessionFile: string | null;
  byteOffset: number;
  lastDiff?: string;
}

export interface ActivityResult {
  entries: TranscriptEntry[];
  transcriptText: string;
  gitDiff: string;
  hasNew: boolean;
  newState: ActivityState;
}

export interface ActivityReaderDeps {
  home?: string;
  runGitDiff?: (cwd: string) => Promise<string>;
}

const MAX_DIFF = 8000;

async function defaultGitDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['diff', 'HEAD'], { cwd, maxBuffer: 1024 * 1024 });
    return stdout.length > MAX_DIFF ? stdout.slice(0, MAX_DIFF) + '\n…(truncated)' : stdout;
  } catch {
    return '';
  }
}

/** A git diff counts as "new" only if it changed from the last read (not the initial snapshot). */
function diffIsNew(gitDiff: string, lastDiff: string | undefined): boolean {
  return lastDiff !== undefined && gitDiff !== lastDiff && gitDiff.trim().length > 0;
}

export class ActivityReader {
  readonly projectDir: string;
  private runGitDiff: (cwd: string) => Promise<string>;

  constructor(private cwd: string, deps: ActivityReaderDeps = {}) {
    const home = deps.home ?? homedir();
    this.projectDir = join(home, '.claude', 'projects', encodeProjectDir(cwd));
    this.runGitDiff = deps.runGitDiff ?? defaultGitDiff;
  }

  private async activeSession(): Promise<string | null> {
    if (!existsSync(this.projectDir)) return null;
    const names = (await readdir(this.projectDir)).filter(
      (n) => n.endsWith('.jsonl') && !n.startsWith('agent-'),
    );
    let newest: { path: string; mtime: number } | null = null;
    for (const n of names) {
      const p = join(this.projectDir, n);
      const m = (await stat(p)).mtimeMs;
      if (!newest || m > newest.mtime) newest = { path: p, mtime: m };
    }
    return newest?.path ?? null;
  }

  async readActivity(state: ActivityState): Promise<ActivityResult> {
    const sessionFile = await this.activeSession();
    const gitDiff = await this.runGitDiff(this.cwd);

    if (!sessionFile) {
      return {
        entries: [],
        transcriptText: '',
        gitDiff,
        hasNew: diffIsNew(gitDiff, state.lastDiff),
        newState: { sessionFile: null, byteOffset: 0, lastDiff: gitDiff },
      };
    }

    const full = await readFile(sessionFile, 'utf8');
    const startOffset = state.sessionFile === sessionFile ? state.byteOffset : 0;
    const lastNl = full.lastIndexOf('\n');
    const consumedEnd = lastNl === -1 ? startOffset : lastNl + 1;
    const delta = consumedEnd > startOffset ? full.slice(startOffset, consumedEnd) : '';
    const entries = parseEntries(delta);
    const transcriptText = entries
      .map((e) => `${e.role === 'user' ? '사용자' : 'AI'}: ${e.text}`)
      .join('\n');

    const hasNew = entries.length > 0 || diffIsNew(gitDiff, state.lastDiff);
    return {
      entries,
      transcriptText,
      gitDiff,
      hasNew,
      newState: { sessionFile, byteOffset: consumedEnd, lastDiff: gitDiff },
    };
  }

  /** Full parsed transcript of the active session (for the read-only viewer). */
  async readFullTranscript(): Promise<TranscriptEntry[]> {
    const sessionFile = await this.activeSession();
    if (!sessionFile) return [];
    return parseEntries(await readFile(sessionFile, 'utf8'));
  }
}
