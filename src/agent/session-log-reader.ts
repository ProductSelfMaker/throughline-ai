// src/agent/session-log-reader.ts
import { readdir, stat, open } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import chokidar from 'chokidar';
import { ActivityBatch, ActivityReader, Analytics, SessionSummary } from '../domain/types';

function dayKey(ts: string | undefined, fallbackMs: number): string {
  const d = ts ? new Date(ts) : new Date(fallbackMs);
  const ms = d.getTime();
  return new Date(Number.isNaN(ms) ? fallbackMs : ms).toISOString().slice(0, 10);
}

// Bounds — a long-lived project's session dir can be hundreds of MB across many
// files; never read it all. Read at most a tail window per file per tick, and
// cap the excerpt fed to the scribe.
const DEFAULT_MAX_READ_BYTES = 512 * 1024;
const DEFAULT_MAX_EXCERPT_CHARS = 12_000;

/** Claude Code stores per-project sessions under ~/.claude/projects/<dashed cwd>/. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function toolTarget(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const v = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.url;
    if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
  }
  return '';
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

/** Render a window of JSONL lines into a scribe-friendly excerpt. */
export function extractActivity(lines: string[]): string {
  const out: string[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let o: { type?: string; message?: { role?: string; content?: unknown } };
    try { o = JSON.parse(t); } catch { continue; }
    const role = o.message?.role;
    if (o.type === 'user' && role === 'user') {
      const text = textFromContent(o.message?.content).trim();
      if (text) out.push('사용자: ' + text);
    } else if (o.type === 'assistant' && role === 'assistant') {
      const content = o.message?.content;
      const text = textFromContent(content).trim();
      if (text) out.push('AI: ' + text);
      if (Array.isArray(content)) {
        for (const b of content as Array<{ type?: string; name?: string; input?: unknown }>) {
          if (b && b.type === 'tool_use') out.push(`[도구] ${b.name ?? ''} ${toolTarget(b.input)}`.trim());
        }
      }
    }
  }
  return out.join('\n');
}

export class SessionLogReader implements ActivityReader {
  private dir: string;
  private maxReadBytes: number;
  private maxExcerptChars: number;
  constructor(opts: { cwd: string; home?: string; maxReadBytes?: number; maxExcerptChars?: number }) {
    this.dir = join(opts.home ?? homedir(), '.claude', 'projects', encodeProjectDir(opts.cwd));
    this.maxReadBytes = opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxExcerptChars = opts.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  }

  private async sessionFiles(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    const names = await readdir(this.dir);
    return names
      .filter((n) => n.endsWith('.jsonl') && !n.startsWith('agent-'))
      .map((n) => join(this.dir, n));
  }

  /** Current byte size of every session file — used to "observe from now" on first run. */
  async currentOffsets(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const f of await this.sessionFiles()) {
      try { out[f] = (await stat(f)).size; } catch { /* skip */ }
    }
    return out;
  }

  /** Read only the new tail of each session file (bounded), advancing offsets. */
  async readNew(checkpoint: Record<string, number>): Promise<ActivityBatch> {
    const parts: string[] = [];
    const advanced: Record<string, number> = {};
    for (const file of await this.sessionFiles()) {
      let size: number;
      try { size = (await stat(file)).size; } catch { continue; }
      const from = checkpoint[file] ?? 0;
      if (size <= from) continue;

      const readStart = Math.max(from, size - this.maxReadBytes);
      const len = size - readStart;
      const fh = await open(file, 'r');
      try {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, readStart);
        let chunk = buf.toString('utf8');
        // if we skipped ahead past unread history, drop the partial first line
        if (readStart > from) {
          const nl = chunk.indexOf('\n');
          chunk = nl >= 0 ? chunk.slice(nl + 1) : '';
        }
        const lastNl = chunk.lastIndexOf('\n');
        if (lastNl === -1) {
          // no complete line in the window: skip ahead only if the window is full
          // (a pathologically long line); otherwise wait for the line to finish.
          if (len >= this.maxReadBytes) advanced[file] = size;
          continue;
        }
        const complete = chunk.slice(0, lastNl);
        const trailing = Buffer.byteLength(chunk.slice(lastNl + 1), 'utf8');
        const text = extractActivity(complete.split('\n'));
        if (text) parts.push(text);
        advanced[file] = size - trailing; // preserve a partial trailing line for next tick
      } finally {
        await fh.close();
      }
    }
    let excerpt = parts.join('\n');
    if (excerpt.length > this.maxExcerptChars) excerpt = excerpt.slice(excerpt.length - this.maxExcerptChars);
    return { excerpt, advanced };
  }

  /** Read the bounded tail of a single file as activity text (for rebuilds). */
  private async readTailActivity(file: string, size: number): Promise<string> {
    const readStart = Math.max(0, size - this.maxReadBytes);
    const len = size - readStart;
    if (len <= 0) return '';
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, readStart);
      let chunk = buf.toString('utf8');
      if (readStart > 0) {
        const nl = chunk.indexOf('\n');
        chunk = nl >= 0 ? chunk.slice(nl + 1) : '';
      }
      return extractActivity(chunk.split('\n'));
    } finally {
      await fh.close();
    }
  }

  /** Recent activity (files modified within `days`, newest first), capped to `maxChars`.
   *  Used by a full rebuild — bounded so it never loads the whole history. */
  async readRecent(days: number, maxChars: number): Promise<string> {
    const cutoff = Date.now() - days * 86_400_000;
    const recent: { file: string; size: number; mtime: number }[] = [];
    for (const file of await this.sessionFiles()) {
      try {
        const s = await stat(file);
        if (s.mtimeMs >= cutoff) recent.push({ file, size: s.size, mtime: s.mtimeMs });
      } catch { /* skip */ }
    }
    recent.sort((a, b) => b.mtime - a.mtime); // newest first
    const parts: string[] = [];
    let used = 0;
    for (const { file, size } of recent) {
      if (used >= maxChars) break;
      const text = await this.readTailActivity(file, size);
      if (text) { parts.push(text); used += text.length; }
    }
    let excerpt = parts.reverse().join('\n'); // roughly chronological
    if (excerpt.length > maxChars) excerpt = excerpt.slice(excerpt.length - maxChars);
    return excerpt;
  }

  /** Derived analytics (per-session history + aggregate token usage) over recent
   *  files, streamed line-by-line and byte-budgeted so it never blows up memory. */
  async analyze(days: number, maxBytes: number): Promise<Analytics> {
    const cutoff = Date.now() - days * 86_400_000;
    const recent: { file: string; size: number; mtime: number }[] = [];
    for (const file of await this.sessionFiles()) {
      try {
        const s = await stat(file);
        if (s.mtimeMs >= cutoff) recent.push({ file, size: s.size, mtime: s.mtimeMs });
      } catch { /* skip */ }
    }
    recent.sort((a, b) => b.mtime - a.mtime);

    const tok = { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0, tools: 0 };
    const perDay = new Map<string, number>();
    const history: SessionSummary[] = [];
    let bytes = 0;
    let approx = false;

    for (const { file, size, mtime } of recent) {
      if (bytes > 0 && bytes + size > maxBytes) { approx = true; break; }
      bytes += size;
      let messages = 0, tools = 0, tokens = 0, title = '';
      const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          const t = line.trim();
          if (!t) continue;
          let o: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown; usage?: Record<string, number> } };
          try { o = JSON.parse(t); } catch { continue; }
          const role = o.message?.role;
          if (o.type === 'user' && role === 'user') {
            messages++;
            if (!title) {
              const txt = textFromContent(o.message?.content).trim();
              if (txt) title = txt.length > 50 ? txt.slice(0, 50) + '…' : txt;
            }
          } else if (o.type === 'assistant' && role === 'assistant') {
            messages++;
            const u = o.message?.usage;
            if (u) {
              const inp = u.input_tokens || 0, out = u.output_tokens || 0;
              const cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
              tok.input += inp; tok.output += out; tok.cacheRead += cr; tok.cacheCreate += cc; tok.turns++;
              const tt = inp + out + cr + cc; tokens += tt; tok.total += tt;
              perDay.set(dayKey(o.timestamp, mtime), (perDay.get(dayKey(o.timestamp, mtime)) || 0) + tt);
            }
            if (Array.isArray(o.message?.content)) {
              for (const b of o.message.content as Array<{ type?: string }>) if (b?.type === 'tool_use') { tools++; tok.tools++; }
            }
          }
        }
      } finally {
        rl.close();
      }
      history.push({
        id: basename(file).replace(/\.jsonl$/, '').slice(0, 8),
        title: title || '(제목 없음)',
        time: mtime,
        messages,
        tools,
        tokens,
      });
    }

    const perDayArr = [...perDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 14)
      .map(([date, total]) => ({ date, total }));
    return { tokens: { ...tok, perDay: perDayArr }, history, approx };
  }

  watch(onActivity: () => void): () => void {
    const w = chokidar.watch(this.dir, { ignoreInitial: true, depth: 0 });
    w.on('add', onActivity).on('change', onActivity);
    return () => void w.close();
  }
}
