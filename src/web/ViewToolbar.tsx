// src/web/ViewToolbar.tsx
export type ViewId = 'doc' | 'flow' | 'preview';

const VIEWS: { id: ViewId; icon: string; label: string }[] = [
  { id: 'doc', icon: '📄', label: '문서' },
  { id: 'flow', icon: '🔀', label: '플로우' },
  { id: 'preview', icon: '👁', label: '프리뷰' },
];

export function ViewToolbar({
  active,
  onToggle,
}: {
  active: ViewId | null;
  onToggle: (v: ViewId) => void;
}) {
  return (
    <div className="view-toolbar">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          className={`view-btn ${active === v.id ? 'active' : ''}`}
          aria-pressed={active === v.id}
          onClick={() => onToggle(v.id)}
        >
          <span aria-hidden>{v.icon}</span> {v.label}
        </button>
      ))}
    </div>
  );
}
