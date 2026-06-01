// src/web/PreviewView.tsx
import { useState, type FormEvent } from 'react';

const URL_KEY = 'throughline.previewUrl';

export function PreviewView() {
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) ?? '');
  const [draft, setDraft] = useState(url);
  const [reloadKey, setReloadKey] = useState(0);

  function load(e: FormEvent) {
    e.preventDefault();
    const next = draft.trim();
    setUrl(next);
    localStorage.setItem(URL_KEY, next);
    setReloadKey((k) => k + 1);
  }

  return (
    <section className="preview">
      <form className="url-bar" onSubmit={load}>
        <span aria-hidden>👁</span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="http://localhost:3000"
        />
        <button type="submit">열기</button>
        {url ? (
          <button type="button" title="새로고침" onClick={() => setReloadKey((k) => k + 1)}>
            ⟳
          </button>
        ) : null}
      </form>
      <div className="preview-body">
        {url ? (
          <iframe key={reloadKey} src={url} title="preview" className="preview-frame" />
        ) : (
          <p className="empty">
            로컬 개발 서버 주소를 입력하면 여기서 바로 보여요 (예: http://localhost:3000).
            <br />
            일부 앱은 임베드를 차단할 수 있어요 — 프록시 지원은 다음 단계입니다.
          </p>
        )}
      </div>
    </section>
  );
}
