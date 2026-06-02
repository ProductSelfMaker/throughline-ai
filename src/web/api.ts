// src/web/api.ts
import type { Analytics } from '../domain/types';

export type SpecUpdate = { md: string; changedLines: number[] };
export type { Analytics };

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

/** The latest generated decisions doc ('' if none). */
export async function fetchDecisions(): Promise<string> {
  const res = await fetch('/api/decisions');
  if (!res.ok) return '';
  const data = (await res.json()) as { md?: string };
  return data.md ?? '';
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
