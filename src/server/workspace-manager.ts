// src/server/workspace-manager.ts
// Time/active-scoped workspaces: the user works in the active workspace, and new session
// activity accrues only to it. Each workspace has its own artifacts under .throughline/ws/<id>.
// One shared watcher routes activity to the active workspace's Session; one shared broadcaster
// keeps a single SSE stream across switches.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { Broadcaster } from './broadcaster';
import { ActivityReader } from '../domain/types';
import { Session } from './session';
import { buildMergePrompt, extractConflicts, type Conflict } from '../domain/merge-prompt';
import { buildResolvePrompt } from '../domain/resolve-prompt';

export interface WorkspaceInfo { id: string; name: string; isDefault: boolean }
interface Registry { active: string; workspaces: { id: string; name: string }[] }
interface Completer { complete(prompt: string): Promise<string> }
export interface Unified { md: string; conflicts: Conflict[] }

const DEFAULT_ID = 'default';
// artifacts that lived directly in .throughline/ before workspaces — migrated into ws/default.
const LEGACY_FILES = [
  'prd.md', 'decisions.json', 'decisions-state.json', 'decisions.md', 'mockup.html',
  'mockup-flow.json', 'architecture.md', 'architecture-meta.json', 'prd-meta.json', 'ingest-state.json',
];

export interface WorkspaceManagerDeps {
  cwd: string;
  reader: ActivityReader;
  /** Shared completer for cross-workspace ops (unified merge + conflict resolution). */
  runner: Completer;
  /** Build a Session for a workspace, pointed at its artifacts dir, sharing the broadcaster. */
  makeSession: (opts: { id: string; artifactsDir: string; broadcaster: Broadcaster }) => Session;
}

export class WorkspaceManager {
  readonly broadcaster = new Broadcaster();
  private cwd: string;
  private reader: ActivityReader;
  private runner: Completer;
  private makeSession: WorkspaceManagerDeps['makeSession'];
  private registryPath: string;
  private unifiedPath: string;
  private unifiedConflictsPath: string;
  private wsRoot: string;
  private registry: Registry = { active: DEFAULT_ID, workspaces: [{ id: DEFAULT_ID, name: 'Default' }] };
  private sessions = new Map<string, Session>();
  private unwatch?: () => void;
  private nextId = 1;

  constructor(deps: WorkspaceManagerDeps) {
    this.cwd = deps.cwd;
    this.reader = deps.reader;
    this.runner = deps.runner;
    this.makeSession = deps.makeSession;
    this.registryPath = join(deps.cwd, '.throughline', 'workspaces.json');
    this.unifiedPath = join(deps.cwd, '.throughline', 'unified.md');
    this.unifiedConflictsPath = join(deps.cwd, '.throughline', 'unified-conflicts.json');
    this.wsRoot = join(deps.cwd, '.throughline', 'ws');
  }

  private dir(id: string): string { return join(this.wsRoot, id); }

  async init(): Promise<void> {
    await this.loadOrBootstrap();
    for (const w of this.registry.workspaces) await this.build(w.id, false);
    // single watcher → only the active workspace ingests new activity
    this.unwatch = this.reader.watch(() => this.active().notifyActivity());
  }

  private async loadOrBootstrap(): Promise<void> {
    if (existsSync(this.registryPath)) {
      try {
        const r = JSON.parse(await readFile(this.registryPath, 'utf8')) as Registry;
        if (r?.workspaces?.length) this.registry = r;
      } catch { /* keep the default */ }
      // continue ids past the highest existing wsN
      for (const w of this.registry.workspaces) {
        const m = /^ws(\d+)$/.exec(w.id);
        if (m) this.nextId = Math.max(this.nextId, Number(m[1]) + 1);
      }
      return;
    }
    // first run: create the default workspace + migrate any legacy root artifacts into it
    await mkdir(this.dir(DEFAULT_ID), { recursive: true });
    for (const f of LEGACY_FILES) {
      const src = join(this.cwd, '.throughline', f);
      if (existsSync(src)) { try { await rename(src, join(this.dir(DEFAULT_ID), f)); } catch { /* best-effort */ } }
    }
    await this.save();
  }

  private async build(id: string, fresh: boolean): Promise<Session> {
    const s = this.makeSession({ id, artifactsDir: this.dir(id), broadcaster: this.broadcaster });
    await s.init({ watch: false });
    if (fresh) await s.startFresh();
    this.sessions.set(id, s);
    return s;
  }

  private async save(): Promise<void> {
    await mkdir(join(this.cwd, '.throughline'), { recursive: true });
    await writeFile(this.registryPath, JSON.stringify(this.registry, null, 2), 'utf8');
  }

  /** The Session for the active workspace (all API endpoints operate on this). */
  active(): Session {
    return this.sessions.get(this.registry.active) ?? this.sessions.get(DEFAULT_ID)!;
  }
  activeInfo(): WorkspaceInfo { return this.info(this.registry.active); }
  private info(id: string): WorkspaceInfo {
    const w = this.registry.workspaces.find((x) => x.id === id);
    return { id, name: w?.name ?? id, isDefault: id === DEFAULT_ID };
  }
  list(): WorkspaceInfo[] { return this.registry.workspaces.map((w) => this.info(w.id)); }

  async create(name: string): Promise<WorkspaceInfo> {
    const id = `ws${this.nextId++}`;
    const clean = (name || '').trim().slice(0, 60) || 'Untitled';
    this.registry.workspaces.push({ id, name: clean });
    await this.save();
    await this.build(id, true); // new workspace captures from now
    return this.info(id);
  }

  async select(id: string): Promise<boolean> {
    if (!this.sessions.has(id) || id === this.registry.active) return false;
    this.registry.active = id;
    await this.save();
    const s = this.active();
    await s.startFresh(); // capture-from-now on (re)activation — prior activity went elsewhere
    // re-emit the now-active workspace's state so SSE clients update without a reconnect
    this.broadcaster.broadcast('spec-updated', { md: await s.readSpec(), changedLines: [] });
    this.broadcaster.broadcast('decisions-updated', { items: await s.readDecisions() });
    this.broadcaster.broadcast('workspace-changed', this.activeInfo());
    return true;
  }

  /** Delete a non-default workspace (the fixed "Default" can't be removed). */
  async remove(id: string): Promise<boolean> {
    if (id === DEFAULT_ID || !this.sessions.has(id)) return false;
    this.sessions.get(id)?.stop();
    this.sessions.delete(id);
    this.registry.workspaces = this.registry.workspaces.filter((w) => w.id !== id);
    if (this.registry.active === id) this.registry.active = DEFAULT_ID; // fall back to default
    await this.save();
    await rm(this.dir(id), { recursive: true, force: true }).catch(() => { /* best-effort */ });
    return true;
  }

  private async allWorkspaceDocs(): Promise<{ name: string; md: string }[]> {
    const out: { name: string; md: string }[] = [];
    for (const w of this.registry.workspaces) {
      const s = this.sessions.get(w.id);
      if (s) out.push({ name: w.name, md: await s.readSpec() });
    }
    return out;
  }

  private async writeUnified(u: Unified): Promise<void> {
    await mkdir(join(this.cwd, '.throughline'), { recursive: true });
    await writeFile(this.unifiedPath, u.md, 'utf8');
    await writeFile(this.unifiedConflictsPath, JSON.stringify(u.conflicts), 'utf8');
  }

  /** The latest unified doc + open conflicts ('' / [] when never merged). */
  async readUnified(): Promise<Unified> {
    let md = '';
    let conflicts: Conflict[] = [];
    try { if (existsSync(this.unifiedPath)) md = await readFile(this.unifiedPath, 'utf8'); } catch { md = ''; }
    try { if (existsSync(this.unifiedConflictsPath)) conflicts = JSON.parse(await readFile(this.unifiedConflictsPath, 'utf8')); } catch { conflicts = []; }
    return { md, conflicts: Array.isArray(conflicts) ? conflicts : [] };
  }

  /** Merge every workspace's doc into one. 0–1 workspace → passthrough (no LLM call). */
  async mergeAll(): Promise<Unified> {
    const docs = await this.allWorkspaceDocs();
    const u: Unified = docs.length <= 1
      ? { md: docs[0]?.md ?? '', conflicts: [] }
      : extractConflicts(await this.runner.complete(buildMergePrompt(docs)));
    await this.writeUnified(u);
    return u;
  }

  /** Apply the user's chat answer to one conflict; updates the unified doc, drops the conflict. */
  async resolveConflict(id: string, answer: string): Promise<Unified> {
    const cur = await this.readUnified();
    const conflict = cur.conflicts.find((c) => c.id === id);
    if (!conflict) return cur;
    const md = (await this.runner.complete(buildResolvePrompt(cur.md, conflict.question, answer))).trim() || cur.md;
    const u: Unified = { md, conflicts: cur.conflicts.filter((c) => c.id !== id) };
    await this.writeUnified(u);
    return u;
  }

  flush(): void { this.active().flush(); }
  stop(): void { this.unwatch?.(); for (const s of this.sessions.values()) s.stop(); }
}
