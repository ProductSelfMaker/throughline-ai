// src/web/api.ts
import type { Analytics, WorkItem, WorkItemDetail } from '../domain/types';

export type SpecUpdate = { md: string; changedLines: number[] };
export type { Analytics, WorkItem, WorkItemDetail };

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

/** Live history + token analytics over recent session logs. */
export async function fetchAnalytics(): Promise<Analytics> {
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

/** Send a curation instruction to the scribe (it edits the PRD; changes arrive via SSE). */
export async function curate(instruction: string): Promise<void> {
  const res = await fetch('/api/curate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction }),
  });
  if (!res.ok) throw new Error(`curate failed (${res.status})`);
}

/** Reset & re-organize: rebuild the doc + decisions from recent activity. */
export async function rebuild(): Promise<void> {
  const res = await fetch('/api/rebuild', { method: 'POST' });
  if (!res.ok) throw new Error(`rebuild failed (${res.status})`);
}

/** The cached decisions doc + whether a background refresh was started. */
export async function fetchDecisions(): Promise<{ md: string; refreshing: boolean }> {
  const res = await fetch('/api/decisions');
  if (!res.ok) return { md: '', refreshing: false };
  const data = (await res.json()) as { md?: string; refreshing?: boolean };
  return { md: data.md ?? '', refreshing: data.refreshing ?? false };
}

/** Subscribe to background decisions refreshes (SSE 'decisions-updated'). */
export function subscribeDecisions(onUpdate: (md: string) => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('decisions-updated', (e) => onUpdate(JSON.parse((e as MessageEvent).data).md));
  return () => es.close();
}

/** The latest generated mockup HTML ('' if none). */
export async function fetchMockup(): Promise<string> {
  const res = await fetch('/api/mockup');
  if (!res.ok) return '';
  const data = (await res.json()) as { html?: string };
  return data.html ?? '';
}

/** Generate the mockup from the product doc (slow — LLM); returns the HTML. */
export async function generateMockup(): Promise<string> {
  const res = await fetch('/api/mockup', { method: 'POST' });
  if (!res.ok) throw new Error(`mockup failed (${res.status})`);
  const data = (await res.json()) as { html?: string };
  return data.html ?? '';
}
