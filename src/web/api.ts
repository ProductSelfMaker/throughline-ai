// src/web/api.ts
import type { Analytics, WorkItem, WorkItemDetail, DecisionItem, Freshness } from '../domain/types';

export type SpecUpdate = { md: string; changedLines: number[] };
export type { Analytics, WorkItem, WorkItemDetail, DecisionItem, Freshness };
/** Token analytics: the observed project's coding usage + Throughline's own usage. */
export type AnalyticsResponse = { project: Analytics; self: Analytics | null };

/** Recent work items (history cards). */
export async function fetchWorkItems(limit = 100): Promise<WorkItem[]> {
  const res = await fetch(`/api/history?limit=${limit}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: WorkItem[] };
  return data.items ?? [];
}

/** Full conversation/work for one history card. */
export async function fetchWorkItemDetail(item: WorkItem): Promise<WorkItemDetail | null> {
  const q = `file=${encodeURIComponent(item.file)}&start=${item.start}&end=${item.end}`;
  const res = await fetch(`/api/history/item?${q}`);
  if (!res.ok) return null;
  return (await res.json()) as WorkItemDetail;
}

/** Which project directory this instance is observing. */
export async function fetchInfo(): Promise<{ cwd: string; display: string }> {
  const res = await fetch('/api/info');
  if (!res.ok) return { cwd: '', display: '' };
  const data = (await res.json()) as { cwd?: string; display?: string };
  return { cwd: data.cwd ?? '', display: data.display ?? '' };
}

/** Live token analytics for the observed project (+ Throughline overhead). */
export async function fetchAnalytics(): Promise<AnalyticsResponse> {
  const res = await fetch('/api/analytics');
  if (!res.ok) throw new Error(`analytics failed (${res.status})`);
  return res.json();
}

/** Subscribe to live PRD updates over SSE. */
export function subscribeSpec(onSpec: (u: SpecUpdate) => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('spec-updated', (e) => onSpec(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

/** Subscribe to the "AI is working" status (SSE 'status'). */
export function subscribeStatus(onStatus: (working: boolean) => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('status', (e) => onStatus(!!JSON.parse((e as MessageEvent).data).working));
  return () => es.close();
}

/** Send a curation instruction to the scribe (it edits the PRD; changes arrive via SSE). */
export async function curate(instruction: string): Promise<void> {
  const res = await fetch('/api/curate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction }),
  });
  if (!res.ok) throw new Error(`curate failed (${res.status})`);
}

/** A user-triggered rebuild that runs as a background job (survives navigation). */
export type JobKind = 'doc' | 'decisions' | 'mockup' | 'architecture' | 'tidy';
export type JobStatus = 'running' | 'done' | 'error';

/** Start a per-page rebuild job. The work runs server-side to completion even if the
 *  page is left or reloaded; progress arrives via subscribeJobs. */
export async function startJob(kind: JobKind): Promise<{ started: boolean; running: JobKind[] }> {
  const res = await fetch(`/api/jobs/${kind}`, { method: 'POST' });
  if (!res.ok) throw new Error(`job ${kind} failed (${res.status})`);
  return res.json();
}

/** Subscribe to background-job lifecycle: the initial in-flight set ('jobs') + per-job
 *  deltas ('job-updated'). Used for busy state and completion toasts. */
export function subscribeJobs(
  onInitial: (running: JobKind[]) => void,
  onUpdate: (kind: JobKind, status: JobStatus) => void,
): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('jobs', (e) => onInitial((JSON.parse((e as MessageEvent).data).running ?? []) as JobKind[]));
  es.addEventListener('job-updated', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { kind: JobKind; status: JobStatus };
    onUpdate(d.kind, d.status);
  });
  return () => es.close();
}

/** The cached decisions ledger + whether a background refresh was started. */
export async function fetchDecisions(): Promise<{ items: DecisionItem[]; refreshing: boolean }> {
  const res = await fetch('/api/decisions');
  if (!res.ok) return { items: [], refreshing: false };
  const data = (await res.json()) as { items?: DecisionItem[]; refreshing?: boolean };
  return { items: data.items ?? [], refreshing: data.refreshing ?? false };
}

/** Subscribe to background decisions-ledger updates (SSE 'decisions-updated'). */
export function subscribeDecisions(onUpdate: (items: DecisionItem[]) => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('decisions-updated', (e) => onUpdate(JSON.parse((e as MessageEvent).data).items ?? []));
  return () => es.close();
}

/** The latest generated mockup HTML ('' if none). */
export async function fetchMockup(): Promise<string> {
  const res = await fetch('/api/mockup');
  if (!res.ok) return '';
  const data = (await res.json()) as { html?: string };
  return data.html ?? '';
}

/** The architecture doc + its freshness (which sections may be stale). */
export async function fetchArchitecture(): Promise<{ md: string; freshness: Freshness | null }> {
  const res = await fetch('/api/architecture');
  if (!res.ok) return { md: '', freshness: null };
  const data = (await res.json()) as { md?: string; freshness?: Freshness | null };
  return { md: data.md ?? '', freshness: data.freshness ?? null };
}

/** Product-doc freshness — which sections' cited files changed since the last Rebuild (null if none). */
export async function fetchDocFreshness(): Promise<Freshness | null> {
  const res = await fetch('/api/doc-freshness');
  if (!res.ok) return null;
  return (await res.json()) as Freshness | null;
}

/** A workspace: a named bucket of work. The active one captures new activity. */
export interface WorkspaceInfo { id: string; name: string; isDefault: boolean }

export async function fetchWorkspaces(): Promise<{ active: string; workspaces: WorkspaceInfo[] }> {
  const res = await fetch('/api/workspaces');
  if (!res.ok) return { active: 'default', workspaces: [] };
  return res.json();
}
export async function createWorkspace(name: string): Promise<WorkspaceInfo> {
  const res = await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`create workspace failed (${res.status})`);
  return res.json();
}
export async function selectWorkspace(id: string): Promise<void> {
  await fetch(`/api/workspaces/${id}/select`, { method: 'POST' });
}
export async function deleteWorkspace(id: string): Promise<void> {
  await fetch(`/api/workspaces/${id}/delete`, { method: 'POST' });
}

/** Unified merge of all workspaces + chat conflict resolution. */
export interface Conflict { id: string; question: string }
export interface Unified { md: string; conflicts: Conflict[] }
export async function mergeUnified(): Promise<Unified> {
  const res = await fetch('/api/unified/merge', { method: 'POST' });
  if (!res.ok) throw new Error(`merge failed (${res.status})`);
  return res.json();
}
export async function resolveConflict(id: string, answer: string): Promise<Unified> {
  const res = await fetch('/api/unified/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, answer }) });
  if (!res.ok) throw new Error(`resolve failed (${res.status})`);
  return res.json();
}
/** Subscribe to active-workspace changes (SSE 'workspace-changed'). */
export function subscribeWorkspace(onChange: (active: WorkspaceInfo) => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('workspace-changed', (e) => onChange(JSON.parse((e as MessageEvent).data) as WorkspaceInfo));
  return () => es.close();
}

