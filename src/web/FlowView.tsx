// src/web/FlowView.tsx
import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { fetchFlow } from './api';

mermaid.initialize({ startOnLoad: false, theme: 'neutral' });

export function FlowView({ specRevision }: { specRevision: number }) {
  const [svg, setSvg] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const renderId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchFlow()
      .then(async (code) => {
        if (cancelled) return;
        try {
          const out = await mermaid.render(`flow-${renderId.current++}`, code.trim());
          if (cancelled) return;
          setSvg(out.svg);
          setLoading(false);
        } catch {
          if (cancelled) return;
          setError(`다이어그램 파싱에 실패했어요. 원문:\n\n${code}`);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message || '플로우 생성에 실패했어요.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [specRevision, retry]);

  return (
    <section className="flow">
      <header className="view-head">
        <span>🔀 유저 플로우</span>
        {loading ? <span className="badge">생성 중…</span> : null}
      </header>
      <div className="flow-body">
        {error ? (
          <div className="flow-error">
            <p>
              플로우를 만들지 못했어요.{' '}
              <button onClick={() => setRetry((r) => r + 1)}>다시 시도</button>
            </p>
            <pre>{error}</pre>
          </div>
        ) : null}
        <div className="mermaid-host" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </section>
  );
}
