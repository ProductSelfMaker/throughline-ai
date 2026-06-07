// src/server/session.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ActivityReader, Analytics, DEFAULT_SPEC, WorkItem, WorkItemDetail, DecisionItem } from '../domain/types';
import { SpecStore } from '../core/spec-store';
import { IngestStore } from '../core/ingest-store';
import { Debouncer } from './debouncer';
import { Broadcaster } from './broadcaster';
import { buildFlowPrompt } from '../domain/flow-prompt';
import { buildSyncPrompt } from '../domain/sync-prompt';
import { buildCuratePrompt } from '../domain/curate-prompt';
import { buildDecisionsExtractPrompt, parseDecisions } from '../domain/decisions-prompt';
import { buildMockupPrompt } from '../domain/mockup-prompt';
import { assembleMockupHtml } from '../domain/mockup-html';
import { collectUiSource, UiSource } from '../agent/project-ui-source';
import { collectProjectFiles, chunkByBudget, ProjectCode } from '../agent/project-code';
import { buildCodeMapPrompt, buildReduceMergePrompt, buildProductDocPrompt, DocContext } from '../domain/product-doc-prompt';
import { buildArchMapPrompt, buildArchMergePrompt, buildArchDocPrompt, ArchContext } from '../domain/architecture-prompt';
import { applySpecUpdate } from '../core/apply-spec-update';

const execFileP = promisify(execFile);

/** A user-triggered rebuild that runs as a background job (survives navigation). */
export type JobKind = 'doc' | 'decisions' | 'mockup' | 'architecture';
export const JOB_KINDS: readonly JobKind[] = ['doc', 'decisions', 'mockup', 'architecture'];
export const isJobKind = (s: string): s is JobKind => (JOB_KINDS as readonly string[]).includes(s);

// Bounds for a full rebuild — re-scan recent activity only (never the whole history).
const REBUILD_DAYS = 14;
const REBUILD_MAX_CHARS = 40_000;

// Code-grounded rebuild (map → merge → reduce over the project's source).
// Infrequent + quality-first, so budgets are generous.
const MAP_CHUNK_BUDGET = 120_000;   // chars of code per map call
const REDUCE_BUDGET = 120_000;      // chars of summaries per merge/synthesis call
const MAP_CONCURRENCY = 4;          // parallel map calls

/** Run `fn` over items with bounded concurrency, preserving order. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}
// Decisions ledger (accumulating). Built incrementally from new work-item turns.
const DECISIONS_TURN_LIMIT = 120;       // recent turns considered per refresh
const DECISIONS_MAX_NEW = 40;           // max new turns processed per refresh
const DECISIONS_TRANSCRIPT_MAX = 30_000; // chars of transcript fed to the extractor

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);
const normWhat = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 'd' + (h >>> 0).toString(36);
}

const joinLen = (parts: string[]): number => parts.reduce((n, p) => n + p.length + 2, 0);
function batchByBudget(parts: string[], budget: number): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const p of parts) {
    if (cur.length && size + p.length > budget) { batches.push(cur); cur = []; size = 0; }
    cur.push(p); size += p.length + 2;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// Bounds for the (live) history/tokens analytics scan.
const ANALYTICS_DAYS = 30;
const ANALYTICS_MAX_BYTES = 64 * 1024 * 1024;

async function defaultGitDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['diff', 'HEAD'], { cwd, maxBuffer: 1024 * 1024 });
    return stdout.length > 8000 ? stdout.slice(0, 8000) + '\n…(truncated)' : stdout;
  } catch {
    return '';
  }
}

// Minimal runner surface this engine needs (one-shot completion only).
interface Completer {
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
}

export interface SessionDeps {
  store: SpecStore;
  runner: Completer;
  reader: ActivityReader;
  /** Reads Throughline's OWN scribe-agent logs (for the overhead breakdown). */
  selfReader?: ActivityReader;
  ingest: IngestStore;
  cwd: string;
  debounceMs?: number;
  gitDiff?: (cwd: string) => Promise<string>;
  /** Reads the observed project's real frontend source (for faithful mockups).
   *  Defaults to scanning the project cwd; injectable for tests. */
  uiSource?: (cwd: string) => Promise<UiSource>;
  /** Reads the observed project's full source (for the code-grounded rebuild).
   *  Defaults to scanning the project cwd; injectable for tests. */
  projectCode?: (cwd: string) => Promise<ProjectCode>;
  /** How long to wait before a decisions background-refresh may re-run (ms).
   *  Default 3 min; set 0 in tests for pure mark-based staleness. */
  decisionsCooldownMs?: number;
}

/** Observer: reads the user's agent session logs and keeps the PRD live. */
export class Session {
  readonly broadcaster = new Broadcaster();

  private store: SpecStore;
  private runner: Completer;
  private reader: ActivityReader;
  private selfReader?: ActivityReader;
  private ingest: IngestStore;
  private cwd: string;
  private debouncer: Debouncer;
  private gitDiff: (cwd: string) => Promise<string>;
  private uiSource: (cwd: string) => Promise<UiSource>;
  private projectCode: (cwd: string) => Promise<ProjectCode>;
  private decisionsPath: string;
  private decisionsStatePath: string;
  private decisionsCooldownMs: number;
  private mockupPath: string;
  private architecturePath: string;
  private checkpoint: Record<string, number> = {};
  private unwatch?: () => void;

  // In-flight background rebuild jobs, keyed by kind (one per kind at a time).
  private jobs = new Map<JobKind, Promise<void>>();

  // "AI is working" state — true while an LLM op runs or new activity is pending.
  private busyCount = 0;
  private pendingActivity = false;
  private lastWorking = false;

  constructor(deps: SessionDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.reader = deps.reader;
    this.selfReader = deps.selfReader;
    this.ingest = deps.ingest;
    this.cwd = deps.cwd;
    this.debouncer = new Debouncer(deps.debounceMs ?? 8000);
    this.gitDiff = deps.gitDiff ?? defaultGitDiff;
    this.uiSource = deps.uiSource ?? collectUiSource;
    this.projectCode = deps.projectCode ?? collectProjectFiles;
    this.decisionsPath = join(deps.cwd, '.throughline', 'decisions.json');
    this.decisionsStatePath = join(deps.cwd, '.throughline', 'decisions-state.json');
    this.decisionsCooldownMs = deps.decisionsCooldownMs ?? 180_000;
    this.mockupPath = join(deps.cwd, '.throughline', 'mockup.html');
    this.architecturePath = join(deps.cwd, '.throughline', 'architecture.md');
  }

  /** The developer-facing architecture doc ('' if not generated yet). */
  async readArchitecture(): Promise<string> {
    try { return existsSync(this.architecturePath) ? await readFile(this.architecturePath, 'utf8') : ''; }
    catch { return ''; }
  }
  private async writeArchitecture(md: string): Promise<void> {
    await mkdir(dirname(this.architecturePath), { recursive: true });
    await writeFile(this.architecturePath, md, 'utf8');
  }

  /** The latest generated mockup HTML ('' if none yet). */
  async readMockup(): Promise<string> {
    try { return existsSync(this.mockupPath) ? await readFile(this.mockupPath, 'utf8') : ''; }
    catch { return ''; }
  }

  /** Generate a design-canvas mockup. We read the project's REAL stylesheet +
   *  components, embed the CSS verbatim, and let the LLM reproduce each screen's
   *  DOM as artboards — so the mockup matches the running app instead of an
   *  LLM re-derivation. Data comes from the product doc, inferred from UI for gaps. */
  async generateMockup(): Promise<string> {
    let failure: unknown;
    await this.runBusy(async () => {
      const doc = await this.store.read();
      try {
        const src = await this.uiSource(this.cwd);
        const fragment = (await this.runner.complete(buildMockupPrompt({ doc, css: src.css, components: src.components }))).trim();
        if (fragment) {
          const html = assembleMockupHtml(src.css, fragment, src.headLinks);
          await mkdir(dirname(this.mockupPath), { recursive: true });
          await writeFile(this.mockupPath, html, 'utf8');
        }
      } catch (e) {
        failure = e; // keep the previous mockup, but surface the failure to the job
      }
    });
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
    return this.readMockup();
  }

  /** The accumulating decisions ledger (chronological list; [] if none yet). */
  async readDecisions(): Promise<DecisionItem[]> {
    try {
      const raw = existsSync(this.decisionsPath) ? await readFile(this.decisionsPath, 'utf8') : '';
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? (arr as DecisionItem[]) : [];
    } catch { return []; }
  }
  private async writeDecisions(items: DecisionItem[]): Promise<void> {
    await mkdir(dirname(this.decisionsPath), { recursive: true });
    await writeFile(this.decisionsPath, JSON.stringify(items, null, 2), 'utf8');
  }
  /** Ledger rendered as markdown — used as "why" context for the doc rebuild. */
  private async decisionsAsText(): Promise<string> {
    const items = await this.readDecisions();
    return items.map((d) => `## ${d.what}\n- why: ${d.why}${d.alternatives ? `\n- alternatives: ${d.alternatives}` : ''}`).join('\n\n');
  }

  /** A cheap "have logs changed" gate (sum of current byte offsets). */
  private async activityMark(): Promise<number> {
    try { return Object.values(await this.reader.currentOffsets()).reduce((a, b) => a + b, 0); }
    catch { return -1; }
  }
  private async readDecisionsState(): Promise<{ mark: number; ts: number; lastTime: number }> {
    try {
      const s = JSON.parse(await readFile(this.decisionsStatePath, 'utf8'));
      return { mark: s.mark ?? -1, ts: s.ts ?? 0, lastTime: s.lastTime ?? 0 };
    } catch { return { mark: -1, ts: 0, lastTime: 0 }; }
  }
  private async writeDecisionsState(s: { mark: number; ts: number; lastTime: number }): Promise<void> {
    try {
      await mkdir(dirname(this.decisionsStatePath), { recursive: true });
      await writeFile(this.decisionsStatePath, JSON.stringify(s), 'utf8');
    } catch { /* best-effort */ }
  }

  /** Stale-while-revalidate gate: if new turns exist (and past cooldown), extend the
   *  ledger in the BACKGROUND. Returns true if a refresh was kicked off (the view
   *  shows the cached ledger meanwhile and gets the result via 'decisions-updated'). */
  async refreshDecisionsIfStale(now: number = Date.now()): Promise<boolean> {
    try {
      const ledger = await this.readDecisions();
      const mark = await this.activityMark();
      if (!ledger.length && mark <= 0) return false; // nothing yet and no activity
      const state = await this.readDecisionsState();
      if (ledger.length) {
        if (state.mark === mark) return false;                        // nothing changed
        if (now - state.ts < this.decisionsCooldownMs) return false;  // throttled
      }
      void this.extendDecisions(now, mark);
      return true;
    } catch { return false; }
  }

  /** Extract decisions from turns newer than the last processed time, dedupe against
   *  the ledger, append, and broadcast. Reuses work-item turns so each decision links
   *  back to its source conversation. Accumulates — old decisions are never dropped. */
  private async extendDecisions(now: number, mark: number): Promise<void> {
    try {
      const state = await this.readDecisionsState();
      const ledger = await this.readDecisions();
      const turns = await this.reader.listWorkItems(DECISIONS_TURN_LIMIT);
      const fresh = turns
        .filter((t) => t.time > state.lastTime)
        .sort((a, b) => a.time - b.time) // oldest → newest; catch up over refreshes
        .slice(0, DECISIONS_MAX_NEW);
      if (!fresh.length) { await this.writeDecisionsState({ mark, ts: now, lastTime: state.lastTime }); return; }

      // compact numbered transcript from the fresh turns (prompt + assistant text)
      const parts: string[] = [];
      const used: typeof fresh = [];
      let chars = 0;
      for (const t of fresh) {
        const d = await this.reader.readWorkItem(t.file, t.start, t.end).catch(() => null);
        const userText = d?.messages.filter((m) => m.role === 'user').map((m) => m.text).join(' / ') || t.title;
        const aiText = (d?.messages.filter((m) => m.role === 'assistant').map((m) => m.text).filter(Boolean).join(' ')) || '';
        const block = `[#${used.length}] User: ${clip(userText, 400)}${aiText ? `\nAI: ${clip(aiText, 600)}` : ''}`;
        if (chars + block.length > DECISIONS_TRANSCRIPT_MAX) break;
        parts.push(block); used.push(t); chars += block.length;
      }
      const advancedTo = (used.length ? used[used.length - 1] : fresh[fresh.length - 1]).time;
      if (!used.length) { await this.writeDecisionsState({ mark, ts: now, lastTime: advancedTo }); return; }

      const raw = await this.runBusy(() => this.runner.complete(buildDecisionsExtractPrompt(parts.join('\n\n'), ledger.map((d) => d.what))));
      const seen = new Set(ledger.map((d) => normWhat(d.what)));
      for (const p of parseDecisions(raw)) {
        const what = p.what.trim();
        if (!what || seen.has(normWhat(what))) continue;
        seen.add(normWhat(what));
        const turn = used[p.turn] ?? used[used.length - 1];
        const supersedes = p.supersedes ? ledger.find((d) => normWhat(d.what) === normWhat(p.supersedes))?.id : undefined;
        ledger.push({
          id: hashId(what),
          what,
          why: p.why.trim(),
          alternatives: p.alternatives.trim(),
          time: turn?.time ?? now,
          ...(supersedes ? { supersedes } : {}),
          ...(turn ? { source: { file: turn.file, start: turn.start, end: turn.end } } : {}),
        });
      }
      await this.writeDecisions(ledger);
      await this.writeDecisionsState({ mark, ts: now, lastTime: advancedTo });
      this.broadcaster.broadcast('decisions-updated', { items: ledger });
    } catch {
      // keep the previous ledger
    }
  }

  /** Load the checkpoint; on first run observe from "now" (a long-lived project's
   *  history is far too large to ingest at once); otherwise catch up. Then watch.
   *  The catch-up ingest runs in the background — it makes an LLM call, so it must
   *  never block the HTTP server from starting. */
  async init(): Promise<void> {
    this.checkpoint = await this.ingest.load();
    if (Object.keys(this.checkpoint).length === 0) {
      this.checkpoint = await this.reader.currentOffsets();
      await this.ingest.save(this.checkpoint);
    } else {
      void this.ingestNow(); // fire-and-forget: catch up without blocking startup
    }
    this.unwatch = this.reader.watch(() => {
      this.pendingActivity = true; // observed agent is active; an update is coming
      this.syncWorking();
      this.debouncer.schedule(() => { void this.ingestNow(); });
    });
  }

  readSpec(): Promise<string> {
    return this.store.read();
  }

  /** The project directory this instance is observing. */
  projectDir(): string {
    return this.cwd;
  }

  /** Whether Throughline is currently working (ingesting/updating). */
  isWorking(): boolean {
    return this.busyCount > 0 || this.pendingActivity;
  }
  private syncWorking(): void {
    const w = this.isWorking();
    if (w !== this.lastWorking) {
      this.lastWorking = w;
      this.broadcaster.broadcast('status', { working: w });
    }
  }
  /** Run an LLM-backed op while reflecting "working" to the UI. */
  private async runBusy<T>(fn: () => Promise<T>): Promise<T> {
    this.busyCount += 1;
    this.syncWorking();
    try { return await fn(); }
    finally { this.busyCount -= 1; this.syncWorking(); }
  }

  /** Live history + token analytics over recent session logs. */
  analytics(): Promise<Analytics> {
    return this.reader.analyze(ANALYTICS_DAYS, ANALYTICS_MAX_BYTES);
  }

  /** Throughline's OWN usage — analytics over its scribe-agent session logs
   *  (null if no self-reader is wired). Same shape as project analytics. */
  async overhead(): Promise<Analytics | null> {
    if (!this.selfReader) return null;
    try { return await this.selfReader.analyze(ANALYTICS_DAYS, ANALYTICS_MAX_BYTES); }
    catch { return null; }
  }

  /** Recent work items (user turns) for the history view. */
  workItems(limit: number): Promise<WorkItem[]> {
    return this.reader.listWorkItems(limit);
  }
  /** Full conversation/work for one work item. */
  workItemDetail(file: string, start: number, end: number): Promise<WorkItemDetail | null> {
    return this.reader.readWorkItem(file, start, end);
  }

  async generateFlow(signal?: AbortSignal): Promise<string> {
    const spec = await this.readSpec();
    return this.runner.complete(buildFlowPrompt(spec), signal);
  }

  /** Fold new agent activity into the PRD. Advances the checkpoint only on success. */
  private async ingestNow(): Promise<void> {
    this.pendingActivity = false; // now actively processing
    await this.runBusy(async () => {
      try {
        const batch = await this.reader.readNew(this.checkpoint);
        if (!batch.excerpt.trim()) return;
        const current = await this.store.read();
        const diff = await this.gitDiff(this.cwd);
        const raw = await this.runner.complete(buildSyncPrompt(current, batch.excerpt, diff));
        const applied = await applySpecUpdate(this.store, raw, current);
        if (applied.ok) {
          this.checkpoint = { ...this.checkpoint, ...batch.advanced };
          await this.ingest.save(this.checkpoint);
          this.broadcaster.broadcast('spec-updated', applied.result);
        }
      } catch {
        // best-effort; keep the last good PRD and retry the activity next time
      }
    });
  }

  /** Apply a user curation instruction to the PRD immediately. */
  async curate(instruction: string): Promise<void> {
    const text = instruction.trim();
    if (!text) return;
    await this.runBusy(async () => {
      const current = await this.store.read();
      const diff = await this.gitDiff(this.cwd);
      const raw = await this.runner.complete(buildCuratePrompt(current, text, diff));
      const applied = await applySpecUpdate(this.store, raw, current);
      if (applied.ok) this.broadcaster.broadcast('spec-updated', applied.result);
    });
  }

  /** Kinds with a rebuild currently in flight (for a freshly-connected client). */
  runningJobs(): JobKind[] {
    return [...this.jobs.keys()];
  }

  /** Start a per-kind rebuild as a background job, detached from the HTTP request so
   *  it runs to completion even after the user leaves the page or reloads (as long as
   *  the server lives). Idempotent: returns false if that kind is already running.
   *  Start/finish are broadcast as 'job-updated' so every client can reflect busy
   *  state and toast on completion. The underlying op still goes through runBusy,
   *  so the global "Working…" indicator keeps working too. */
  startJob(kind: JobKind): boolean {
    if (this.jobs.has(kind)) return false;
    this.broadcaster.broadcast('job-updated', { kind, status: 'running' });
    const p = this.runJob(kind).then(() => 'done' as const, () => 'error' as const).then((status) => {
      this.jobs.delete(kind);
      this.broadcaster.broadcast('job-updated', { kind, status });
    });
    this.jobs.set(kind, p);
    return true;
  }

  private runJob(kind: JobKind): Promise<void> {
    switch (kind) {
      case 'doc': return this.rebuild();
      case 'decisions': return this.rebuildDecisions();
      case 'mockup': return this.generateMockup().then(() => {});
      case 'architecture': return this.rebuildArchitecture();
    }
  }

  /** Full rebuild of the decisions ledger: discard the accumulated ledger + state and
   *  re-extract from recent turns (catch up fully over a few bounded passes). Mirrors
   *  the doc Rebuild's "discard and rebuild" semantics; normal operation only extends
   *  incrementally (see refreshDecisionsIfStale). */
  async rebuildDecisions(): Promise<void> {
    await this.writeDecisions([]);
    await this.writeDecisionsState({ mark: -1, ts: 0, lastTime: 0 });
    for (let guard = 0; guard < 10; guard++) {
      const before = (await this.readDecisionsState()).lastTime;
      await this.extendDecisions(Date.now(), await this.activityMark());
      const after = (await this.readDecisionsState()).lastTime;
      if (after === before) break; // no more turns to process
    }
  }

  /** Reset & re-organize the *product doc*: discard the current PRD and rebuild it
   *  from a deep, code-grounded scan of the whole project (map → merge → reduce).
   *  Decisions are not touched here — they refresh on open (see ensureDecisions).
   *  Then resume incremental ingest from "now". */
  async rebuild(): Promise<void> {
    await this.runBusy(async () => {
      const excerpt = await this.reader.readRecent(REBUILD_DAYS, REBUILD_MAX_CHARS).catch(() => '');

      // product doc — rebuilt from the codebase (the truth of what's actually built)
      let nextDoc = DEFAULT_SPEC;
      try {
        nextDoc = await this.buildDocFromCode(excerpt);
      } catch {
        nextDoc = DEFAULT_SPEC;
      }
      const previous = await this.store.read();
      const applied = await applySpecUpdate(this.store, nextDoc, previous);

      this.checkpoint = await this.reader.currentOffsets();
      await this.ingest.save(this.checkpoint);
      if (applied.ok) this.broadcaster.broadcast('spec-updated', applied.result);
    });
  }

  /** Deep, code-grounded product doc. Reads the whole project (bounded), extracts
   *  user-facing behavior per chunk (map), collapses to fit (merge), then synthesizes
   *  the detailed doc (reduce). Falls back to activity-based when there's no source. */
  private async buildDocFromCode(activityExcerpt: string): Promise<string> {
    const { files, truncated } = await this.projectCode(this.cwd);

    if (files.length === 0) {
      if (!activityExcerpt.trim()) return DEFAULT_SPEC;
      const diff = await this.gitDiff(this.cwd);
      const raw = await this.runner.complete(buildSyncPrompt(DEFAULT_SPEC, activityExcerpt, diff));
      return raw.trim() ? raw : DEFAULT_SPEC;
    }

    const chunks = chunkByBudget(files, MAP_CHUNK_BUDGET);
    const maps = (await pool(chunks, MAP_CONCURRENCY, (c) =>
      this.runner.complete(buildCodeMapPrompt(c.label, c.text)).catch(() => ''),
    )).filter((s) => s.trim());

    const ctx: DocContext = {
      manifest: files.find((f) => /(^|\/)package\.json$/i.test(f.path))?.content,
      readme: files.find((f) => /(^|\/)readme(\.[a-z]+)?$/i.test(f.path))?.content,
      decisions: await this.decisionsAsText().catch(() => ''),
      activity: activityExcerpt,
      truncated,
    };
    return this.reduceToDoc(maps, ctx);
  }

  /** Collapse per-chunk summaries (hierarchically if large) then synthesize the doc. */
  private async reduceToDoc(summaries: string[], ctx: DocContext): Promise<string> {
    let level = summaries.filter((s) => s.trim());
    if (level.length === 0) return DEFAULT_SPEC;

    let guard = 0;
    while (joinLen(level) > REDUCE_BUDGET && level.length > 1 && guard < 6) {
      guard += 1;
      const batches = batchByBudget(level, REDUCE_BUDGET);
      if (batches.length >= level.length) break; // can't shrink further
      const merged: string[] = [];
      for (const b of batches) {
        const m = (await this.runner.complete(buildReduceMergePrompt(b.join('\n\n'))).catch(() => '')).trim();
        if (m) merged.push(m);
      }
      if (merged.length === 0) break;
      level = merged;
    }

    const doc = await this.runner.complete(buildProductDocPrompt(level.join('\n\n'), ctx));
    return doc.trim() ? doc : DEFAULT_SPEC;
  }

  /** Rebuild the *architecture* doc: a deep, code-grounded technical overview (the developer
   *  "how it's built" lens). Same map→reduce pass as the product doc, opposite perspective.
   *  Generated only on demand (this job) — not continuously ingested. Keeps the previous doc
   *  on empty/failure. */
  async rebuildArchitecture(): Promise<void> {
    let failure: unknown;
    await this.runBusy(async () => {
      try {
        const next = await this.buildArchFromCode();
        if (next.trim()) await this.writeArchitecture(next);
      } catch (e) {
        failure = e; // keep the previous doc, but surface the failure to the job
      }
    });
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  }

  /** Deep, code-grounded architecture overview. Reads the whole project (bounded), extracts
   *  architectural facts per chunk (map), collapses to fit (merge), then synthesizes the doc. */
  private async buildArchFromCode(): Promise<string> {
    const { files, truncated } = await this.projectCode(this.cwd);
    if (files.length === 0) return '';

    const chunks = chunkByBudget(files, MAP_CHUNK_BUDGET);
    let mapErr: unknown;
    const maps = (await pool(chunks, MAP_CONCURRENCY, (c) =>
      this.runner.complete(buildArchMapPrompt(c.label, c.text)).catch((e) => { mapErr = e; return ''; }),
    )).filter((s) => s.trim());
    if (maps.length === 0) {
      if (mapErr) throw mapErr; // all map calls failed (e.g. overload) → surface, don't silently no-op
      return '';                // genuinely no architecture extracted
    }

    const ctx: ArchContext = {
      manifest: files.find((f) => /(^|\/)package\.json$/i.test(f.path))?.content,
      readme: files.find((f) => /(^|\/)readme(\.[a-z]+)?$/i.test(f.path))?.content,
      decisions: await this.decisionsAsText().catch(() => ''),
      truncated,
    };

    // collapse hierarchically if the summaries don't fit, then synthesize
    let level = maps;
    let guard = 0;
    while (joinLen(level) > REDUCE_BUDGET && level.length > 1 && guard < 6) {
      guard += 1;
      const batches = batchByBudget(level, REDUCE_BUDGET);
      if (batches.length >= level.length) break;
      const merged: string[] = [];
      for (const b of batches) {
        const m = (await this.runner.complete(buildArchMergePrompt(b.join('\n\n'))).catch(() => '')).trim();
        if (m) merged.push(m);
      }
      if (merged.length === 0) break;
      level = merged;
    }
    const doc = await this.runner.complete(buildArchDocPrompt(level.join('\n\n'), ctx));
    return doc.trim() ? doc : '';
  }

  /** Run any pending ingest immediately (tests / shutdown). */
  flush(): void {
    this.debouncer.flush();
  }

  stop(): void {
    this.debouncer.cancel();
    this.unwatch?.();
  }
}
