// src/web/MainView.tsx
// Primary region: wordmark + a per-page Rebuild action on top (no header bar); then the
// active view. Rebuild is scoped to the current page and runs as a background job — it
// completes even if you leave the page or reload (see useJobs); a toast fires on finish.
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchMockup, fetchArchitecture, fetchDocFreshness, fetchInfo, subscribeStatus, fetchWorkspaces, createWorkspace, selectWorkspace, type AnalyticsResponse, type JobKind, type Freshness, type WorkspaceInfo } from './api';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { MergeView } from './MergeView';
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

/** Header label per view — shown identically on every page. */
const VIEW_LABEL: Record<ViewId, string> = {
  doc: 'Document',
  architecture: 'Architecture',
  history: 'History',
  decisions: 'Decisions',
  tokens: 'Tokens',
  mockup: 'Mockup',
};

/** Which generative artifact a page's Rebuild rebuilds (null = no rebuild on that page). */
type RebuildKind = 'doc' | 'decisions' | 'architecture';
const REBUILD_KIND: Record<ViewId, RebuildKind | null> = {
  doc: 'doc',
  architecture: 'architecture',
  decisions: 'decisions',
  history: null,
  tokens: null,
  mockup: null, // mockup uses its own Generate/Update button
};

/** Confirm-modal copy for the destructive (replace & rebuild) actions. */
const CONFIRM_COPY: Record<RebuildKind, { title: string; body: React.ReactNode }> = {
  doc: { title: 'Rebuild document', body: <>The current document will be <b>replaced</b> and rebuilt from a fresh scan of your codebase. Continue?</> },
  decisions: { title: 'Rebuild decisions', body: <>The decisions ledger will be <b>rebuilt</b> from your recent activity. Continue?</> },
  architecture: { title: 'Rebuild architecture', body: <>The architecture overview will be <b>rebuilt</b> from a fresh scan of your codebase. Continue?</> },
};

export function MainView({
  activeView,
  md,
  analytics,
  analyticsLoading,
  running,
  start,
  doneCounts,
  mergeMode,
  onMerge,
  onCloseMerge,
}: {
  activeView: ViewId;
  md: string;
  analytics: AnalyticsResponse | null;
  analyticsLoading: boolean;
  running: Set<JobKind>;
  start: (kind: JobKind) => void;
  doneCounts: Record<JobKind, number>;
  mergeMode: boolean;
  onMerge: () => void;
  onCloseMerge: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [activeWs, setActiveWs] = useState<WorkspaceInfo | null>(null);
  const [mockupHtml, setMockupHtml] = useState<string | null>(null);
  const [archMd, setArchMd] = useState<string | null>(null);
  const [archFresh, setArchFresh] = useState<Freshness | null>(null);
  const [docFresh, setDocFresh] = useState<Freshness | null>(null);
  const [info, setInfo] = useState<{ cwd: string; display: string } | null>(null);
  const [working, setWorking] = useState(false);

  const rebuildKind = REBUILD_KIND[activeView];
  const rebuilding = rebuildKind ? running.has(rebuildKind) : false;
  const mockupBusy = running.has('mockup');
  const tidying = running.has('tidy');
  // Phase 1: deep code generation (Rebuild/Tidy/Mockup) only on the "everything" default
  // workspace; non-default workspaces build purely from their captured activity.
  const codeGenAllowed = activeWs ? activeWs.isDefault : true;

  useEffect(() => {
    let alive = true;
    fetchInfo().then((i) => { if (alive) setInfo(i); }).catch(() => {});
    const unsub = subscribeStatus((w) => { if (alive) setWorking(w); });
    return () => { alive = false; unsub(); };
  }, []);

  // (Re)load the mockup when entering the page and whenever a mockup job completes.
  useEffect(() => {
    if (activeView !== 'mockup') return;
    let alive = true;
    fetchMockup().then((h) => { if (alive) setMockupHtml(h); }).catch(() => { if (alive) setMockupHtml(''); });
    return () => { alive = false; };
  }, [activeView, doneCounts.mockup]);

  // (Re)load the architecture doc on entering the page and after each architecture rebuild.
  useEffect(() => {
    if (activeView !== 'architecture') return;
    let alive = true;
    fetchArchitecture()
      .then(({ md, freshness }) => { if (alive) { setArchMd(md); setArchFresh(freshness); } })
      .catch(() => { if (alive) { setArchMd(''); setArchFresh(null); } });
    return () => { alive = false; };
  }, [activeView, doneCounts.architecture]);

  // product-doc freshness: refresh on entering the doc view and after each doc rebuild.
  useEffect(() => {
    if (activeView !== 'doc') return;
    let alive = true;
    fetchDocFreshness().then((f) => { if (alive) setDocFresh(f); }).catch(() => { if (alive) setDocFresh(null); });
    return () => { alive = false; };
  }, [activeView, doneCounts.doc]);

  return (
    <section className="tl-region tl-main">
      <div className="tl-toprow">
        <span className="wm">Throughline</span>
        <WorkspaceSwitcher onActive={setActiveWs} />
        {info?.display ? <span className="tl-cwd" title={info.cwd}>{shortenPath(info.display)}</span> : null}
        {working ? <span className="tl-working"><span className="dot" />Working…</span> : null}
        <span className="sp" />
        {activeView === 'mockup' && codeGenAllowed ? (
          <button className="tl-gen" type="button" onClick={() => start('mockup')} disabled={mockupBusy}>
            {Icons.sparkle}{mockupBusy ? 'Generating…' : mockupHtml ? 'Update' : 'Generate'}
          </button>
        ) : null}
        {activeView === 'doc' && codeGenAllowed && !mergeMode ? (
          <button
            className="tl-rebtn"
            type="button"
            onClick={onMerge}
            title="Merge all workspaces into one document; resolve conflicts in chat"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4v5a4 4 0 0 0 4 4h6M7 20v-5M17 9l3 4-3 4" /></svg>
            Merge
          </button>
        ) : null}
        {activeView === 'doc' && codeGenAllowed && !mergeMode ? (
          <button
            className="tl-rebtn"
            type="button"
            onClick={() => { if (!tidying) start('tidy'); }}
            disabled={tidying}
            title="Reorganize the current document in place (merge duplicates, regroup, tighten) — no content lost"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h10M4 18h6" /></svg>
            {tidying ? 'Tidying…' : 'Tidy'}
          </button>
        ) : null}
        {rebuildKind && codeGenAllowed && !mergeMode ? (
          <button
            className="tl-rebtn"
            type="button"
            onClick={() => { if (!rebuilding) setConfirm(true); }}
            disabled={rebuilding}
            title="Rebuild this page from a fresh scan"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v4h-4" /></svg>
            {rebuilding ? 'Rebuilding…' : 'Rebuild'}
          </button>
        ) : null}
      </div>

      <div className="tl-viewhead">{mergeMode ? 'Merge' : VIEW_LABEL[activeView]}</div>

      {mergeMode ? (
        <MergeView onClose={onCloseMerge} />
      ) : activeView === 'doc' ? (
        <div className="tl-doc">
          <div className="tl-doc-inner">
            {docFresh && docFresh.stale.length ? (
              <div className="tl-stale-banner">
                ⚠ Citations as of <code>{docFresh.commit.slice(0, 7)}</code> — {docFresh.stale.length} section{docFresh.stale.length > 1 ? "s'" : "'s"} cited code changed since: {docFresh.stale.join(', ')}. <b>Rebuild</b> to refresh grounding.
              </div>
            ) : null}
            {md.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(md)}</ReactMarkdown>
            ) : (
              <p className="tl-placeholder">Start working in your terminal and a feature-by-feature product doc fills in here automatically.</p>
            )}
          </div>
        </div>
      ) : activeView === 'architecture' ? (
        <div className="tl-doc">
          <div className="tl-doc-inner">
            {archFresh && archFresh.stale.length ? (
              <div className="tl-stale-banner">
                ⚠ Built against <code>{archFresh.commit.slice(0, 7)}</code> — {archFresh.stale.length} section{archFresh.stale.length > 1 ? 's' : ''} may be stale (code changed since): {archFresh.stale.join(', ')}. <b>Rebuild</b> to refresh.
              </div>
            ) : null}
            {archMd === null ? (
              <p className="tl-placeholder">Loading…</p>
            ) : archMd.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(archMd)}</ReactMarkdown>
            ) : (
              <p className="tl-placeholder">Press <b>Rebuild</b> to generate a developer-facing architecture overview from a scan of your codebase.</p>
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

      {confirm && rebuildKind ? (
        <div className="tl-modal-overlay" onClick={() => setConfirm(false)}>
          <div className="tl-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tl-modal-title">{CONFIRM_COPY[rebuildKind].title}</div>
            <p className="tl-modal-body">{CONFIRM_COPY[rebuildKind].body}</p>
            <div className="tl-modal-actions">
              <button className="tl-btn-ghost" type="button" onClick={() => setConfirm(false)}>Cancel</button>
              <button className="tl-btn-solid" type="button" onClick={() => { start(rebuildKind); setConfirm(false); }}>
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
