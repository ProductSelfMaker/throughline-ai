// src/web/DecisionsView.tsx
// Decisions, stale-while-revalidate: show the cached doc instantly (no waiting),
// and if the server is refreshing in the background, swap in the fresh version
// when its 'decisions-updated' event arrives.
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchDecisions, subscribeDecisions } from './api';

export function DecisionsView() {
  const [md, setMd] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchDecisions()
      .then(({ md, refreshing }) => { if (alive) { setMd(md); setRefreshing(refreshing); } })
      .catch(() => { if (alive) setMd(''); });
    const unsub = subscribeDecisions((fresh) => { if (alive) { setMd(fresh); setRefreshing(false); } });
    return () => { alive = false; unsub(); };
  }, []);

  if (md === null) return <div className="tl-pad"><p className="tl-placeholder">불러오는 중…</p></div>;
  if (!md.trim()) {
    return (
      <div className="tl-placeholder-wrap">
        <p className="tl-placeholder">
          {refreshing ? '최근 활동에서 의사결정을 정리하는 중…' : '아직 의사결정 기록이 없습니다. 최근 활동이 쌓이면 자동으로 추출됩니다.'}
        </p>
      </div>
    );
  }
  return (
    <div className="tl-doc">
      <div className="tl-doc-inner">
        <div className="tl-kicker">의사결정 · 자동 추출{refreshing ? ' · 갱신 중…' : ''}</div>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </div>
    </div>
  );
}
