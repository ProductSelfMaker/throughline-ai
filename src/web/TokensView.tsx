// src/web/TokensView.tsx
import type { Analytics } from './api';

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}

export function TokensView({ analytics, loading }: { analytics: Analytics | null; loading: boolean }) {
  if (loading && !analytics) return <div className="tl-pad"><p className="tl-placeholder">Loading…</p></div>;
  if (!analytics) return <div className="tl-pad"><p className="tl-placeholder">No data.</p></div>;
  const t = analytics.tokens;
  const max = Math.max(1, ...t.perDay.map((d) => d.total));
  return (
    <div className="tl-pad">
      <div className="tl-tok-hero">
        <div className="tl-tok-big">{fmt(t.total)}<small>tokens</small></div>
        <div className="tl-tok-cost">{t.turns} turns · {t.tools} tool calls{analytics.approx ? ' · recent only' : ''}</div>
      </div>
      <div className="tl-grid4">
        <div className="tl-stat"><div className="k">Input</div><div className="v">{fmt(t.input)}</div></div>
        <div className="tl-stat"><div className="k">Output</div><div className="v">{fmt(t.output)}</div></div>
        <div className="tl-stat"><div className="k">Cache read</div><div className="v">{fmt(t.cacheRead)}</div></div>
        <div className="tl-stat"><div className="k">Cache write</div><div className="v">{fmt(t.cacheCreate)}</div></div>
      </div>
      {t.perDay.length > 0 ? (
        <>
          <p className="tl-section-h">By day</p>
          <div className="tl-bars">
            {t.perDay.map((d) => (
              <div className="tl-bar-row" key={d.date}>
                <span className="lbl">{d.date.slice(5)}</span>
                <span className="tl-bar"><i style={{ width: `${Math.round((d.total / max) * 100)}%` }} /></span>
                <span className="val">{fmt(d.total)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
