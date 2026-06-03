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

  if (md === null) return <div className="tl-pad"><p className="tl-placeholder">Loading…</p></div>;
  if (!md.trim()) {
    return (
      <div className="tl-placeholder-wrap">
        <p className="tl-placeholder">
          {refreshing ? 'Extracting decisions from recent activity…' : 'No decisions yet. They are extracted automatically as activity accumulates.'}
        </p>
      </div>
    );
  }
  return (
    <div className="tl-doc">
      <div className="tl-doc-inner">
        <div className="tl-kicker">Decisions · auto-extracted{refreshing ? ' · refreshing…' : ''}</div>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </div>
    </div>
  );
}
