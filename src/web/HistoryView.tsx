// src/web/HistoryView.tsx
import type { Analytics } from './api';

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}
function day(ms: number): string {
  return new Date(ms).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}

export function HistoryView({ analytics, loading }: { analytics: Analytics | null; loading: boolean }) {
  if (loading && !analytics) return <div className="tl-pad"><p className="tl-placeholder">불러오는 중…</p></div>;
  if (!analytics || analytics.history.length === 0) {
    return <div className="tl-pad"><p className="tl-placeholder">아직 작업 기록이 없습니다.</p></div>;
  }
  return (
    <div className="tl-pad">
      <div className="tl-hist-list">
        {analytics.history.map((h) => (
          <div className="tl-hist-item" key={h.id}>
            <div className="tl-hist-time">{day(h.time)}</div>
            <div className="tl-hist-b">
              <div className="t">{h.title}</div>
              <div className="meta">
                <span>{h.messages} 메시지</span>
                <span>{h.tools} 도구</span>
                <span>{fmt(h.tokens)} 토큰</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {analytics.approx ? <p className="tl-placeholder" style={{ marginTop: 14 }}>최근 일부만 표시됩니다.</p> : null}
    </div>
  );
}
