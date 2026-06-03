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
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
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

  if (items === null) return <div className="tl-pad"><p className="tl-placeholder">불러오는 중…</p></div>;
  if (items.length === 0) return <div className="tl-pad"><p className="tl-placeholder">아직 작업 기록이 없습니다.</p></div>;

  return (
    <div className="tl-pad">
      <div className="tl-hist-list">
        {items.map((h) => (
          <button className="tl-hist-card" key={h.id} type="button" onClick={() => setSel(h)}>
            <div className="tl-hist-time">{when(h.time)}</div>
            <div className="tl-hist-b">
              <div className="t">{h.title}</div>
              <div className="meta">
                <span>{h.tools} 도구</span>
                <span>{fmt(h.tokens)} 토큰</span>
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
              <button className="x" type="button" onClick={() => setSel(null)} aria-label="닫기">✕</button>
            </div>
            {detailLoading && !detail ? (
              <div className="tl-detail-body"><p className="tl-placeholder">불러오는 중…</p></div>
            ) : !detail ? (
              <div className="tl-detail-body"><p className="tl-placeholder">상세를 불러오지 못했습니다.</p></div>
            ) : (
              <div className="tl-detail-body">
                <div className="tl-detail-meta">
                  <span>{when(detail.time || sel.time)}</span>
                  <span>{fmt(detail.tokens)} 토큰</span>
                  {detail.filesTouched.length ? <span>{detail.filesTouched.length} 파일 변경</span> : null}
                </div>
                {detail.filesTouched.length ? (
                  <div className="tl-detail-files">
                    {detail.filesTouched.map((f) => <span className="chip" key={f}>{f}</span>)}
                  </div>
                ) : null}
                {detail.messages.map((m, i) => (
                  <div className={`tl-msg ${m.role}`} key={i}>
                    <div className="who">{m.role === 'user' ? '나' : 'AI'}</div>
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
