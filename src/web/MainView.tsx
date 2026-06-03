// src/web/MainView.tsx
// Primary region: wordmark + (mockup) Generate + Rebuild on top (no header bar);
// then the active view.
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rebuild, fetchMockup, generateMockup, fetchInfo, type Analytics } from './api';
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

/** Shorten a path keeping the meaningful tail (project folder) visible. */
function shortenPath(p: string, max = 52): string {
  return p.length <= max ? p : '…' + p.slice(p.length - max + 1);
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
  const [info, setInfo] = useState<{ cwd: string; display: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetchInfo().then((i) => { if (alive) setInfo(i); }).catch(() => {});
    return () => { alive = false; };
  }, []);

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
        {info?.display ? <span className="tl-cwd" title={info.cwd}>{shortenPath(info.display)}</span> : null}
        <span className="sp" />
        {activeView === 'mockup' ? (
          <button className="tl-gen" type="button" onClick={() => void genMockup()} disabled={mockupBusy}>
            {Icons.sparkle}{mockupBusy ? 'Generating…' : mockupHtml ? 'Update' : 'Generate'}
          </button>
        ) : null}
        <button className="tl-rebtn" type="button" onClick={() => setConfirm(true)} title="Rebuild the document from a fresh scan of your codebase">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v4h-4" /></svg>
          Rebuild
        </button>
      </div>

      {activeView === 'doc' ? (
        <div className="tl-doc">
          <div className="tl-doc-inner">
            <div className="tl-kicker">Product doc · auto-generated</div>
            {md.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(md)}</ReactMarkdown>
            ) : (
              <p className="tl-placeholder">Start working in your terminal and a feature-by-feature product doc fills in here automatically.</p>
            )}
          </div>
        </div>
      ) : activeView === 'history' ? (
        <HistoryView />
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
            <div className="tl-modal-title">Rebuild document</div>
            <p className="tl-modal-body">
              The current document will be <b>replaced</b> and rebuilt from a fresh scan of your codebase. Continue?
            </p>
            <div className="tl-modal-actions">
              <button className="tl-btn-ghost" type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
              <button className="tl-btn-solid" type="button" disabled={busy} onClick={() => void doRebuild()}>
                {busy ? 'Rebuilding…' : 'Continue'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
