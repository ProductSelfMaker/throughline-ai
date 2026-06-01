// src/web/App.tsx
import { useCallback, useEffect, useState } from 'react';
import { subscribeSpec } from './api';
import { ChatPane } from './ChatPane';
import { ViewToolbar, type ViewId } from './ViewToolbar';
import { ResizableDivider } from './ResizableDivider';
import { RightPane } from './RightPane';

const SPLIT_KEY = 'throughline.splitWidth';

function initialSplit(): number {
  const saved = Number(localStorage.getItem(SPLIT_KEY));
  return saved >= 20 && saved <= 80 ? saved : 50;
}

export function App() {
  const [md, setMd] = useState('');
  const [changedLines, setChangedLines] = useState<number[]>([]);
  const [specRevision, setSpecRevision] = useState(0);
  const [activeView, setActiveView] = useState<ViewId | null>(null);
  const [splitWidth, setSplitWidth] = useState(initialSplit);

  useEffect(
    () =>
      subscribeSpec((u) => {
        setMd(u.md);
        setChangedLines(u.changedLines);
        setSpecRevision((r) => r + 1);
      }),
    [],
  );

  const toggle = useCallback((view: ViewId) => {
    setActiveView((cur) => (cur === view ? null : view));
  }, []);

  const onResize = useCallback((rightPercent: number) => {
    const clamped = Math.min(80, Math.max(20, rightPercent));
    setSplitWidth(clamped);
    localStorage.setItem(SPLIT_KEY, String(clamped));
  }, []);

  const open = activeView !== null;

  return (
    <div className="app">
      <div className="chat-col" style={open ? { flexBasis: `${100 - splitWidth}%` } : { flex: 1 }}>
        <ChatPane />
      </div>
      {open ? (
        <>
          <ResizableDivider onResize={onResize} />
          <div className="view-col" style={{ flexBasis: `${splitWidth}%` }}>
            <RightPane
              activeView={activeView}
              md={md}
              changedLines={changedLines}
              specRevision={specRevision}
            />
          </div>
        </>
      ) : null}
      <ViewToolbar active={activeView} onToggle={toggle} />
    </div>
  );
}
