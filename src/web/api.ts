// src/web/api.ts
export type SpecUpdate = { md: string; changedLines: number[] };

/** Subscribe to live spec updates over SSE. Returns an unsubscribe fn. */
export function subscribeSpec(onUpdate: (u: SpecUpdate) => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('spec-updated', (e) => {
    onUpdate(JSON.parse((e as MessageEvent).data) as SpecUpdate);
  });
  return () => es.close();
}

/** Send a chat message; invoke onToken for each streamed chunk of the reply. */
export async function sendChat(
  message: string,
  onToken: (t: string) => void,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onToken(decoder.decode(value, { stream: true }));
  }
}

/** Fetch a freshly generated mermaid user-flow for the current spec. */
export async function fetchFlow(): Promise<string> {
  const res = await fetch('/api/flow');
  const data = (await res.json()) as { mermaid?: string; error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `flow request failed (${res.status})`);
  }
  return data.mermaid ?? '';
}
