// src/web/DecisionsView.tsx
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchDecisions } from './api';

export function DecisionsView() {
  const [md, setMd] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchDecisions().then((m) => { if (alive) setMd(m); }).catch(() => { if (alive) setMd(''); });
    return () => { alive = false; };
  }, []);

  if (md === null) return <div className="tl-pad"><p className="tl-placeholder">불러오는 중…</p></div>;
  if (!md.trim()) {
    return (
      <div className="tl-placeholder-wrap">
        <p className="tl-placeholder">아직 의사결정 기록이 없습니다. "다시 정리"로 최근 기록에서 추출됩니다.</p>
      </div>
    );
  }
  return (
    <div className="tl-doc">
      <div className="tl-doc-inner">
        <div className="tl-kicker">의사결정 · 자동 추출</div>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </div>
    </div>
  );
}
