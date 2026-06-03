// src/agent/session-log-reader.ts
import { readdir, stat, open } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import chokidar from 'chokidar';
import { ActivityBatch, ActivityReader, Analytics, SessionSummary, WorkItem, WorkItemDetail, WorkMessage } from '../domain/types';

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

// Work-item (history card) bounds.
const WORKITEM_TAIL_BYTES = 16 * 1024 * 1024; // tail window per file when listing turns
const WORKITEM_MAX_FILES = 40;
const WORKITEM_DETAIL_MAX = 4 * 1024 * 1024;  // cap a single turn's detail read

interface LogEntry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown; usage?: Record<string, number>; name?: string };
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);
const tsMs = (ts: string | undefined, fallback: number): number => {
  const ms = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(ms) ? fallback : ms;
};
function usageTotal(u: Record<string, number> | undefined): number {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}
// Harness-injected "user" lines that aren't real prompts.
const NOISE_PROMPT = /^(\[Request interrupted|Caveat:|<command-name>|<command-message>|<local-command-stdout>|<system-reminder>)/;

/** The genuine human prompt text of a line, or null (tool_result / empty / noise). */
function promptText(o: LogEntry): string | null {
  if (o.type !== 'user' || o.message?.role !== 'user') return null;
  const c = o.message?.content;
  let text: string;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if ((c as Array<{ type?: string }>).some((b) => b?.type === 'tool_result')) return null;
    text = textFromContent(c);
  } else return null;
  text = text.trim();
  if (!text || NOISE_PROMPT.test(text)) return null;
  return text;
}

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

  /** Recent work items (one per genuine user turn), newest first. Reads only a
   *  tail window per file so a giant session can't blow up the scan. */
  async listWorkItems(limit: number): Promise<WorkItem[]> {
    const stats: { file: string; size: number; mtime: number }[] = [];
    for (const f of await this.sessionFiles()) {
      try { const s = await stat(f); stats.push({ file: f, size: s.size, mtime: s.mtimeMs }); } catch { /* skip */ }
    }
    stats.sort((a, b) => b.mtime - a.mtime);

    const items: WorkItem[] = [];
    for (const { file, size, mtime } of stats.slice(0, WORKITEM_MAX_FILES)) {
      if (items.length >= limit) break;
      items.push(...await this.turnsInFile(file, size, mtime));
    }
    items.sort((a, b) => b.time - a.time);
    return items.slice(0, limit);
  }

  /** Segment one session file's tail window into work items (user turns). */
  private async turnsInFile(file: string, size: number, mtime: number): Promise<WorkItem[]> {
    const from = Math.max(0, size - WORKITEM_TAIL_BYTES);
    const len = size - from;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    const fd = await open(file, 'r');
    try { await fd.read(buf, 0, len, from); } finally { await fd.close(); }

    // if we started mid-file, drop the leading partial line
    let base = from;
    let body = buf;
    if (from > 0) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return [];
      base = from + nl + 1;
      body = buf.subarray(nl + 1);
    }
    const fbase = basename(file).replace(/\.jsonl$/, '');
    const turns: WorkItem[] = [];
    let cur: WorkItem | null = null;
    let pos = 0;
    while (pos < body.length) {
      const nl = body.indexOf(0x0a, pos);
      const lineEnd = nl === -1 ? body.length : nl;
      const offset = base + pos;
      const raw = body.subarray(pos, lineEnd).toString('utf8').trim();
      pos = nl === -1 ? body.length : nl + 1;
      if (!raw) continue;
      let o: LogEntry;
      try { o = JSON.parse(raw); } catch { continue; }
      const prompt = promptText(o);
      if (prompt) {
        if (cur) { cur.end = offset; turns.push(cur); }
        cur = { id: '', file: fbase, start: offset, end: size, title: clip(prompt, 90), time: tsMs(o.timestamp, mtime), tools: 0, tokens: 0 };
      } else if (cur && o.type === 'assistant' && o.message?.role === 'assistant') {
        cur.tokens += usageTotal(o.message?.usage);
        if (Array.isArray(o.message?.content)) {
          for (const b of o.message.content as Array<{ type?: string }>) if (b?.type === 'tool_use') cur.tools++;
        }
      }
    }
    if (cur) { cur.end = size; turns.push(cur); }
    for (const t of turns) t.id = `${t.file}:${t.start}-${t.end}`;
    return turns;
  }

  /** Read one work item's byte range and render its conversation + work. */
  async readWorkItem(file: string, start: number, end: number): Promise<WorkItemDetail | null> {
    if (!/^[A-Za-z0-9._-]+$/.test(file)) return null; // no path traversal
    const full = join(this.dir, file + '.jsonl');
    if (!existsSync(full)) return null;
    let size: number;
    try { size = (await stat(full)).size; } catch { return null; }
    const from = Math.max(0, Math.min(start, size));
    const to = Math.min(Math.max(end, from), size, from + WORKITEM_DETAIL_MAX);
    if (to <= from) return null;
    const buf = Buffer.alloc(to - from);
    const fd = await open(full, 'r');
    try { await fd.read(buf, 0, to - from, from); } finally { await fd.close(); }

    const messages: WorkMessage[] = [];
    const filesTouched = new Set<string>();
    let tokens = 0;
    let title = '';
    let time = 0;
    for (const raw of buf.toString('utf8').split('\n')) {
      const t = raw.trim();
      if (!t) continue;
      let o: LogEntry;
      try { o = JSON.parse(t); } catch { continue; }
      const role = o.message?.role;
      if (o.type === 'user' && role === 'user') {
        const text = textFromContent(o.message?.content).trim();
        if (!text) continue; // skip tool_result-only "user" entries
        messages.push({ role: 'user', text, tools: [] });
        if (!title) title = clip(text, 90);
        if (!time) time = tsMs(o.timestamp, 0);
      } else if (o.type === 'assistant' && role === 'assistant') {
        const text = textFromContent(o.message?.content).trim();
        const tools: { name: string; target: string }[] = [];
        if (Array.isArray(o.message?.content)) {
          for (const b of o.message.content as Array<{ type?: string; name?: string; input?: unknown }>) {
            if (b?.type === 'tool_use') {
              const name = b.name || 'tool';
              const target = toolTarget(b.input);
              tools.push({ name, target });
              if (/edit|write|notebook/i.test(name) && target) filesTouched.add(target);
            }
          }
        }
        tokens += usageTotal(o.message?.usage);
        if (text || tools.length) messages.push({ role: 'assistant', text, tools });
      }
    }
    if (!messages.length) return null;
    return { title: title || '(빈 메시지)', time, tokens, filesTouched: [...filesTouched], messages };
  }

  watch(onActivity: () => void): () => void {
    const w = chokidar.watch(this.dir, { ignoreInitial: true, depth: 0 });
    w.on('add', onActivity).on('change', onActivity);
    return () => void w.close();
  }
}
