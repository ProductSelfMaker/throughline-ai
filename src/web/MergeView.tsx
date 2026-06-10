// src/web/MergeView.tsx
// Unified merge: on open, merge all workspaces into one doc. Conflicts (where workspaces
// disagree) are surfaced one at a time as a chat question; the user's answer is applied to
// the merged doc. Read-only doc + a conflict-resolution chat.
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mergeUnified, resolveConflict, type Conflict } from './api';

export function MergeView({ onClose }: { onClose: () => void }) {
  const [md, setMd] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [busy, setBusy] = useState(true);
  const [answer, setAnswer] = useState('');

  useEffect(() => {
    let alive = true;
    mergeUnified()
      .then((u) => { if (alive) { setMd(u.md); setConflicts(u.conflicts); } })
      .catch(() => { if (alive) setMd(''); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, []);

  const current = conflicts[0];
  const submit = async () => {
    if (!current || !answer.trim() || busy) return;
    setBusy(true);
    try {
      const u = await resolveConflict(current.id, answer.trim());
      setMd(u.md);
      setConflicts(u.conflicts);
      setAnswer('');
    } catch { /* keep current */ } finally { setBusy(false); }
  };

  return (
    <>
      <div className="tl-merge-head">
        <span className="tl-merge-title">Unified document <span className="tl-merge-sub">— all workspaces merged</span></span>
        <span className="sp" />
        <button type="button" className="tl-btn-ghost" onClick={onClose}>Close</button>
      </div>

      {busy && md === null ? (
        <p className="tl-placeholder">Merging workspaces…</p>
      ) : (
        <div className="tl-merge-body">
          <div className="tl-doc"><div className="tl-doc-inner">
            {md && md.trim()
              ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
              : <p className="tl-placeholder">Nothing to merge yet.</p>}
          </div></div>

          <div className="tl-merge-chat">
            {current ? (
              <>
                <div className="tl-merge-count">⚠ Conflict — {conflicts.length} to resolve</div>
                <div className="tl-merge-q">{current.question}</div>
                <div className="tl-merge-input">
                  <textarea
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
                    placeholder="Answer to resolve this conflict…"
                    rows={2}
                    disabled={busy}
                  />
                  <button type="button" className="tl-btn-solid" onClick={() => void submit()} disabled={busy || !answer.trim()}>
                    {busy ? 'Resolving…' : 'Resolve'}
                  </button>
                </div>
              </>
            ) : (
              <div className="tl-merge-done">✓ All conflicts resolved — this is the unified document.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
