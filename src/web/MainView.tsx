// src/web/MainView.tsx
// Primary region: wordmark + (mockup) 다시 생성 + 다시 정리 on top (no header bar);
// then the active view.
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rebuild, fetchMockup, generateMockup, type Analytics } from './api';
import { HistoryView } from './HistoryView';
import { TokensView } from './TokensView';
import { DecisionsView } from './DecisionsView';
import { MockupView } from './MockupView';
import { Icons } from './icons';
import type { ViewId } from './ViewRail';

/** Drop a leading YAML frontmatter block so it doesn't render as a stray heading. */
function stripFrontmatter(md: string): string {
  const m = /^\s*---\n[\s\S]*?\n---\s*\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

export function MainView({
  activeView,
  md,
  analytics,
  analyticsLoading,
}: {
  activeView: ViewId;
  md: string;
  analytics: Analytics | null;
  analyticsLoading: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mockupHtml, setMockupHtml] = useState<string | null>(null);
  const [mockupBusy, setMockupBusy] = useState(false);

  useEffect(() => {
    if (activeView !== 'mockup') return;
    let alive = true;
    fetchMockup().then((h) => { if (alive) setMockupHtml(h); }).catch(() => { if (alive) setMockupHtml(''); });
    return () => { alive = false; };
  }, [activeView]);

  async function doRebuild() {
    setBusy(true);
    try { await rebuild(); } catch { /* SSE reflects the result */ } finally {
      setBusy(false);
      setConfirm(false);
    }
  }
  async function genMockup() {
    setMockupBusy(true);
    try { setMockupHtml(await generateMockup()); } catch { /* keep current */ } finally { setMockupBusy(false); }
  }

  return (
    <section className="tl-region tl-main">
      <div className="tl-toprow">
        <span className="wm">Throughline</span>
        <span className="sp" />
        {activeView === 'mockup' ? (
          <button className="tl-gen" type="button" onClick={() => void genMockup()} disabled={mockupBusy}>
            {Icons.sparkle}{mockupBusy ? '생성 중…' : mockupHtml ? '다시 생성' : '목업 생성'}
          </button>
        ) : null}
        <button className="tl-rebtn" type="button" onClick={() => setConfirm(true)} title="최근 기록으로 문서·의사결정을 새로 정리">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v4h-4" /></svg>
          다시 정리
        </button>
      </div>

      {activeView === 'doc' ? (
        <div className="tl-doc">
          <div className="tl-doc-inner">
            <div className="tl-kicker">제품 문서 · 자동 생성</div>
            {md.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(md)}</ReactMarkdown>
            ) : (
              <p className="tl-placeholder">터미널에서 작업을 시작하면, 기능·페이지별 제품 문서가 여기에 자동으로 정리됩니다.</p>
            )}
          </div>
        </div>
      ) : activeView === 'history' ? (
        <HistoryView analytics={analytics} loading={analyticsLoading} />
      ) : activeView === 'tokens' ? (
        <TokensView analytics={analytics} loading={analyticsLoading} />
      ) : activeView === 'decisions' ? (
        <DecisionsView />
      ) : (
        <MockupView html={mockupHtml} busy={mockupBusy} />
      )}

      {confirm ? (
        <div className="tl-modal-overlay" onClick={() => { if (!busy) setConfirm(false); }}>
          <div className="tl-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tl-modal-title">전체 다시 정리</div>
            <p className="tl-modal-body">
              현재 문서 내용이 <b>사라지고</b>, 최근 기록(약 14일)을 다시 분석해 문서·의사결정을 새로 정리합니다. 계속할까요?
            </p>
            <div className="tl-modal-actions">
              <button className="tl-btn-ghost" type="button" disabled={busy} onClick={() => setConfirm(false)}>취소</button>
              <button className="tl-btn-solid" type="button" disabled={busy} onClick={() => void doRebuild()}>
                {busy ? '정리 중…' : '계속'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
