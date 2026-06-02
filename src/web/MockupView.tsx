// src/web/MockupView.tsx
// User-triggered AI design canvas: generates a self-contained HTML mockup of the
// product's screens from the product doc, rendered in a sandboxed iframe.
import { useEffect, useState } from 'react';
import { fetchMockup, generateMockup } from './api';
import { Icons } from './icons';

export function MockupView() {
  const [html, setHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchMockup().then((h) => { if (alive) setHtml(h); }).catch(() => { if (alive) setHtml(''); });
    return () => { alive = false; };
  }, []);

  async function gen() {
    setBusy(true);
    try { setHtml(await generateMockup()); } catch { /* keep current */ } finally { setBusy(false); }
  }

  if (html === null) return <div className="tl-pad"><p className="tl-placeholder">불러오는 중…</p></div>;

  return (
    <div className="tl-mockup">
      <div className="tl-mock-bar">
        <button className="tl-gen" type="button" onClick={() => void gen()} disabled={busy}>
          {Icons.sparkle}{busy ? '생성 중…' : html ? '다시 생성' : '목업 생성'}
        </button>
        <span className="sp" />
        <span className="tl-mock-note">제품 문서 기반 · 가상 데이터</span>
      </div>
      {html ? (
        <div className="tl-mock-body">
          <iframe className="tl-mock-frame" sandbox="" srcDoc={html} title="목업" />
        </div>
      ) : (
        <div className="tl-placeholder-wrap">
          <p className="tl-placeholder">"목업 생성"을 누르면 제품 문서를 바탕으로 화면들을 그려 펼쳐 보여줍니다.</p>
        </div>
      )}
    </div>
  );
}
