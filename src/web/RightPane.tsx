// src/web/RightPane.tsx
import { SpecPane } from './SpecPane';
import { FlowView } from './FlowView';
import { PreviewView } from './PreviewView';
import type { ViewId } from './ViewToolbar';

export function RightPane({
  activeView,
  md,
  changedLines,
  specRevision,
}: {
  activeView: ViewId;
  md: string;
  changedLines: number[];
  specRevision: number;
}) {
  if (activeView === 'doc') return <SpecPane md={md} changedLines={changedLines} />;
  if (activeView === 'flow') return <FlowView specRevision={specRevision} />;
  return <PreviewView />;
}
