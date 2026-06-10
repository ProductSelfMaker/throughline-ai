// src/web/App.tsx
import { useEffect, useState } from 'react';
import { subscribeSpec, subscribeWorkspace, fetchAnalytics, type AnalyticsResponse } from './api';
import { MainView } from './MainView';
import { ViewRail, type ViewId } from './ViewRail';
import { ScribeChat } from './ScribeChat';
import { useJobs } from './useJobs';
import { Toaster } from './Toaster';

export function App() {
  const [activeView, setActiveView] = useState<ViewId>('doc');
  const [md, setMd] = useState('');
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [wsTick, setWsTick] = useState(0); // bumps on workspace switch → remounts the view
  const [mergeMode, setMergeMode] = useState(false); // unified merge view (default workspace)
  const jobs = useJobs();

  // Live product doc from the background scribe (session-log → doc).
  useEffect(() => subscribeSpec((u) => setMd(u.md)), []);
  // Active-workspace changes: remount the view so per-workspace content refetches; leave merge.
  useEffect(() => subscribeWorkspace(() => { setWsTick((n) => n + 1); setMergeMode(false); }), []);
  // Leaving the doc view exits the merge flow.
  useEffect(() => { if (activeView !== 'doc') setMergeMode(false); }, [activeView]);

  // Tokens are derived live from the logs — fetch on entering that view (and on workspace switch).
  // (History self-fetches its work items.)
  useEffect(() => {
    if (activeView !== 'tokens') return;
    let alive = true;
    setAnalyticsLoading(true);
    fetchAnalytics()
      .then((a) => { if (alive) setAnalytics(a); })
      .catch(() => {})
      .finally(() => { if (alive) setAnalyticsLoading(false); });
    return () => { alive = false; };
  }, [activeView, wsTick]);

  return (
    <div className="tl" data-variant="cards" data-theme="light">
      <MainView
        key={wsTick}
        activeView={activeView}
        md={md}
        analytics={analytics}
        analyticsLoading={analyticsLoading}
        running={jobs.running}
        start={jobs.start}
        doneCounts={jobs.doneCounts}
        mergeMode={mergeMode}
        onMerge={() => setMergeMode(true)}
        onCloseMerge={() => setMergeMode(false)}
      />
      <ViewRail active={activeView} onToggle={setActiveView} />
      {activeView === 'doc' && !mergeMode ? <ScribeChat /> : null}
      <Toaster toasts={jobs.toasts} onDismiss={jobs.dismiss} />
    </div>
  );
}
