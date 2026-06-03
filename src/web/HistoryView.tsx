// src/web/HistoryView.tsx
// Recent work items (one per user turn) as clickable cards; clicking opens a
// panel with the full conversation + the work done (tools, files touched).
import { useEffect, useState } from 'react';
import { fetchWorkItems, fetchWorkItemDetail, type WorkItem, type WorkItemDetail } from './api';

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}
function when(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function HistoryView() {
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [sel, setSel] = useState<WorkItem | null>(null);
  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchWorkItems(100).then((i) => { if (alive) setItems(i); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    let alive = true;
    setDetailLoading(true);
    fetchWorkItemDetail(sel)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => { if (alive) setDetail(null); })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [sel]);

  if (items === null) return <div className="tl-pad"><p className="tl-placeholder">Loading…</p></div>;
  if (items.length === 0) return <div className="tl-pad"><p className="tl-placeholder">No work yet.</p></div>;

  return (
    <div className="tl-pad">
      <div className="tl-hist-list">
        {items.map((h) => (
          <button className="tl-hist-card" key={h.id} type="button" onClick={() => setSel(h)}>
            <div className="tl-hist-time">{when(h.time)}</div>
            <div className="tl-hist-b">
              <div className="t">{h.title}</div>
              <div className="meta">
                <span>{h.tools} tools</span>
                <span>{fmt(h.tokens)} tokens</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      {sel ? (
        <div className="tl-detail-overlay" onClick={() => setSel(null)}>
          <div className="tl-detail" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <div className="t">{sel.title}</div>
              <button className="x" type="button" onClick={() => setSel(null)} aria-label="Close">✕</button>
            </div>
            {detailLoading && !detail ? (
              <div className="tl-detail-body"><p className="tl-placeholder">Loading…</p></div>
            ) : !detail ? (
              <div className="tl-detail-body"><p className="tl-placeholder">Couldn't load the detail.</p></div>
            ) : (
              <div className="tl-detail-body">
                <div className="tl-detail-meta">
                  <span>{when(detail.time || sel.time)}</span>
                  <span>{fmt(detail.tokens)} tokens</span>
                  {detail.filesTouched.length ? <span>{detail.filesTouched.length} files changed</span> : null}
                </div>
                {detail.filesTouched.length ? (
                  <div className="tl-detail-files">
                    {detail.filesTouched.map((f) => <span className="chip" key={f}>{f}</span>)}
                  </div>
                ) : null}
                {detail.messages.map((m, i) => (
                  <div className={`tl-msg ${m.role}`} key={i}>
                    <div className="who">{m.role === 'user' ? 'You' : 'AI'}</div>
                    <div className="bubble">
                      {m.text ? <div className="txt">{m.text}</div> : null}
                      {m.tools.map((t, j) => (
                        <div className="tool" key={j}><b>{t.name}</b>{t.target ? ` · ${t.target}` : ''}</div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
