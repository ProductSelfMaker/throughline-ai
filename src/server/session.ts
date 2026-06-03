// src/server/session.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ActivityReader, Analytics, DEFAULT_SPEC, WorkItem, WorkItemDetail } from '../domain/types';
import { SpecStore } from '../core/spec-store';
import { IngestStore } from '../core/ingest-store';
import { Debouncer } from './debouncer';
import { Broadcaster } from './broadcaster';
import { buildFlowPrompt } from '../domain/flow-prompt';
import { buildSyncPrompt } from '../domain/sync-prompt';
import { buildCuratePrompt } from '../domain/curate-prompt';
import { buildDecisionsPrompt } from '../domain/decisions-prompt';
import { buildMockupPrompt } from '../domain/mockup-prompt';
import { assembleMockupHtml } from '../domain/mockup-html';
import { collectUiSource, UiSource } from '../agent/project-ui-source';
import { collectProjectFiles, chunkByBudget, ProjectCode } from '../agent/project-code';
import { buildCodeMapPrompt, buildReduceMergePrompt, buildProductDocPrompt, DocContext } from '../domain/product-doc-prompt';
import { applySpecUpdate } from '../core/apply-spec-update';

const execFileP = promisify(execFile);

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
  private checkpoint: Record<string, number> = {};
  private unwatch?: () => void;

  constructor(deps: SessionDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.reader = deps.reader;
    this.ingest = deps.ingest;
    this.cwd = deps.cwd;
    this.debouncer = new Debouncer(deps.debounceMs ?? 8000);
    this.gitDiff = deps.gitDiff ?? defaultGitDiff;
    this.uiSource = deps.uiSource ?? collectUiSource;
    this.projectCode = deps.projectCode ?? collectProjectFiles;
    this.decisionsPath = join(deps.cwd, '.throughline', 'decisions.md');
    this.decisionsStatePath = join(deps.cwd, '.throughline', 'decisions-state.json');
    this.decisionsCooldownMs = deps.decisionsCooldownMs ?? 180_000;
    this.mockupPath = join(deps.cwd, '.throughline', 'mockup.html');
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
    const doc = await this.store.read();
    try {
      const src = await this.uiSource(this.cwd);
      const fragment = (await this.runner.complete(buildMockupPrompt({ doc, css: src.css, components: src.components }))).trim();
      if (fragment) {
        const html = assembleMockupHtml(src.css, fragment, src.headLinks);
        await mkdir(dirname(this.mockupPath), { recursive: true });
        await writeFile(this.mockupPath, html, 'utf8');
      }
    } catch {
      // keep the previous mockup
    }
    return this.readMockup();
  }

  /** The latest generated decisions doc ('' if none yet). */
  async readDecisions(): Promise<string> {
    try { return existsSync(this.decisionsPath) ? await readFile(this.decisionsPath, 'utf8') : ''; }
    catch { return ''; }
  }

  private async writeDecisions(md: string): Promise<void> {
    await mkdir(dirname(this.decisionsPath), { recursive: true });
    await writeFile(this.decisionsPath, md, 'utf8');
  }

  /** A cheap monotonic "have logs changed" marker (sum of current byte offsets). */
  private async activityMark(): Promise<number> {
    try { return Object.values(await this.reader.currentOffsets()).reduce((a, b) => a + b, 0); }
    catch { return -1; }
  }
  private async readDecisionsState(): Promise<{ mark: number; ts: number } | null> {
    try {
      const s = JSON.parse(await readFile(this.decisionsStatePath, 'utf8'));
      return { mark: s.mark ?? -1, ts: s.ts ?? 0 };
    } catch { return null; }
  }
  private async writeDecisionsState(mark: number, ts: number): Promise<void> {
    try {
      await mkdir(dirname(this.decisionsStatePath), { recursive: true });
      await writeFile(this.decisionsStatePath, JSON.stringify({ mark, ts }), 'utf8');
    } catch { /* best-effort */ }
  }

  /** Decide whether decisions are stale and, if so, regenerate in the BACKGROUND.
   *  Returns true if a refresh was kicked off (the view shows cached meanwhile and
   *  gets the result via a 'decisions-updated' broadcast). Cheap checks only —
   *  never blocks on the LLM. A cooldown avoids re-spending tokens on rapid reopens
   *  (in active use the logs change constantly, so mark alone would always fire). */
  async refreshDecisionsIfStale(now: number = Date.now()): Promise<boolean> {
    try {
      const existing = await this.readDecisions();
      const mark = await this.activityMark();
      if (!existing && mark <= 0) return false; // nothing cached and no activity to extract
      const state = await this.readDecisionsState();
      if (existing) {
        if (state && state.mark === mark) return false;                       // nothing new
        if (state && now - state.ts < this.decisionsCooldownMs) return false; // throttled
      }
      void this.regenerateDecisions(mark, now);
      return true;
    } catch {
      return false;
    }
  }

  private async regenerateDecisions(mark: number, now: number): Promise<void> {
    try {
      const excerpt = await this.reader.readRecent(REBUILD_DAYS, REBUILD_MAX_CHARS).catch(() => '');
      if (!excerpt.trim()) return;
      const dec = await this.runner.complete(buildDecisionsPrompt(excerpt));
      if (dec.trim()) {
        await this.writeDecisions(dec);
        await this.writeDecisionsState(mark, now);
        this.broadcaster.broadcast('decisions-updated', { md: dec });
      }
    } catch {
      // keep the previous decisions doc
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
    this.unwatch = this.reader.watch(() => this.debouncer.schedule(() => { void this.ingestNow(); }));
  }

  readSpec(): Promise<string> {
    return this.store.read();
  }

  /** The project directory this instance is observing. */
  projectDir(): string {
    return this.cwd;
  }

  /** Live history + token analytics over recent session logs. */
  analytics(): Promise<Analytics> {
    return this.reader.analyze(ANALYTICS_DAYS, ANALYTICS_MAX_BYTES);
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
  }

  /** Apply a user curation instruction to the PRD immediately. */
  async curate(instruction: string): Promise<void> {
    const text = instruction.trim();
    if (!text) return;
    const current = await this.store.read();
    const diff = await this.gitDiff(this.cwd);
    const raw = await this.runner.complete(buildCuratePrompt(current, text, diff));
    const applied = await applySpecUpdate(this.store, raw, current);
    if (applied.ok) this.broadcaster.broadcast('spec-updated', applied.result);
  }

  /** Reset & re-organize the *product doc*: discard the current PRD and rebuild it
   *  from a deep, code-grounded scan of the whole project (map → merge → reduce).
   *  Decisions are not touched here — they refresh on open (see ensureDecisions).
   *  Then resume incremental ingest from "now". */
  async rebuild(): Promise<void> {
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
      decisions: await this.readDecisions().catch(() => ''),
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

  /** Run any pending ingest immediately (tests / shutdown). */
  flush(): void {
    this.debouncer.flush();
  }

  stop(): void {
    this.debouncer.cancel();
    this.unwatch?.();
  }
}
