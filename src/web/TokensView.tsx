// src/web/TokensView.tsx
import type { Analytics } from './api';

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}

export function TokensView({ analytics, loading }: { analytics: Analytics | null; loading: boolean }) {
  if (loading && !analytics) return <div className="tl-pad"><p className="tl-placeholder">불러오는 중…</p></div>;
  if (!analytics) return <div className="tl-pad"><p className="tl-placeholder">데이터가 없습니다.</p></div>;
  const t = analytics.tokens;
  const max = Math.max(1, ...t.perDay.map((d) => d.total));
  return (
    <div className="tl-pad">
      <div className="tl-tok-hero">
        <div className="tl-tok-big">{fmt(t.total)}<small>토큰</small></div>
        <div className="tl-tok-cost">{t.turns} 턴 · {t.tools} 도구 호출{analytics.approx ? ' · 최근 일부' : ''}</div>
      </div>
      <div className="tl-grid4">
        <div className="tl-stat"><div className="k">입력</div><div className="v">{fmt(t.input)}</div></div>
        <div className="tl-stat"><div className="k">출력</div><div className="v">{fmt(t.output)}</div></div>
        <div className="tl-stat"><div className="k">캐시 읽기</div><div className="v">{fmt(t.cacheRead)}</div></div>
        <div className="tl-stat"><div className="k">캐시 생성</div><div className="v">{fmt(t.cacheCreate)}</div></div>
      </div>
      {t.perDay.length > 0 ? (
        <>
          <p className="tl-section-h">일자별</p>
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
