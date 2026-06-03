// src/web/ScribeChat.tsx
// Floating scribe chat — a small button by default; opens a tall multi-turn
// chat that sends curation instructions to /api/curate (the PRD updates via SSE).
// Available on every view.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { curate } from './api';
import { Icons } from './icons';

type Msg = { role: 'user' | 'scribe'; text: string };

export function ScribeChat() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState<Msg[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [thread, busy, open]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setThread((t) => [...t, { role: 'user', text }]);
    setBusy(true);
    try {
      await curate(text);
      setThread((t) => [...t, { role: 'scribe', text: 'Applied to the document.' }]);
    } catch {
      setThread((t) => [...t, { role: 'scribe', text: 'Something went wrong. Please try again.' }]);
    } finally {
      setBusy(false);
    }
  }
  function onSubmit(e: FormEvent) { e.preventDefault(); void send(); }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  }

  if (!open) {
    return (
      <button className="tl-fab" type="button" aria-label="Open scribe" onClick={() => setOpen(true)}>
        {Icons.sparkle}
      </button>
    );
  }

  return (
    <div className="tl-fchat">
      <div className="tl-fchat-head">
        <span className="tl-fbadge">{Icons.sparkle}</span>
        <span className="tl-fname">Scribe</span>
        <span className="tl-fsub">Document</span>
        <span className="sp" />
        <button className="tl-fmin" type="button" aria-label="Collapse" onClick={() => setOpen(false)}>—</button>
      </div>
      <div className="tl-fthread">
        {thread.length === 0 ? (
          <div className="tl-fa">Tell me how to refine the document. e.g. "Add a risks section", "Make the overview shorter".</div>
        ) : null}
        {thread.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'tl-fu' : 'tl-fa'}>{m.text}</div>
        ))}
        {busy ? <div className="tl-fa">Applying…</div> : null}
        <div ref={endRef} />
      </div>
      <form className="tl-finput" onSubmit={onSubmit}>
        <textarea
          className="tl-finput-ta"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Instruct the scribe…"
          rows={1}
          disabled={busy}
        />
        <div className="row">
          <span className="sp" />
          <button type="submit" className="tl-send" disabled={busy || !input.trim()} aria-label="Send">{Icons.send}</button>
        </div>
      </form>
    </div>
  );
}
