// src/web/ViewRail.tsx
// Far-right icon rail — switches the primary view. Always has an active view.
import type { ReactElement } from 'react';
import { Icons } from './icons';

export type ViewId = 'doc' | 'history' | 'decisions' | 'tokens' | 'mockup';

const VIEWS: { id: ViewId; label: string; icon: ReactElement }[] = [
  { id: 'doc', label: 'Document', icon: Icons.doc },
  { id: 'history', label: 'History', icon: Icons.history },
  { id: 'decisions', label: 'Decisions', icon: Icons.decisions },
  { id: 'tokens', label: 'Tokens', icon: Icons.tokens },
  { id: 'mockup', label: 'Mockup', icon: Icons.mockup },
];

export function ViewRail({
  active,
  onToggle,
}: {
  active: ViewId;
  onToggle: (v: ViewId) => void;
}) {
  return (
    <nav className="tl-region tl-rail" aria-label="Views">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          className={'tl-rail-btn' + (active === v.id ? ' active' : '')}
          aria-pressed={active === v.id}
          title={v.label}
          aria-label={v.label}
          onClick={() => onToggle(v.id)}
        >
          {v.icon}
        </button>
      ))}
    </nav>
  );
}
