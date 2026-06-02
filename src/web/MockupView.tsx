// src/web/MockupView.tsx
// Presentational design canvas: shows the generated mockup HTML in a sandboxed
// iframe on a pannable canvas (drag to move around). Generation is triggered from
// the top row in MainView; this component only renders.
import { useEffect, useRef, useState } from 'react';

export function MockupView({ html, busy }: { html: string | null; busy: boolean }) {
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const drag = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

  // Track drag on the window so panning continues even off the iframe/viewport.
  useEffect(() => {
    function move(e: MouseEvent) {
      const d = drag.current;
      if (!d) return;
      setPan({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) });
    }
    function up() { drag.current = null; }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  if (html === null) {
    return <div className="tl-placeholder-wrap"><p className="tl-placeholder">불러오는 중…</p></div>;
  }
  if (!html) {
    return (
      <div className="tl-placeholder-wrap">
        <p className="tl-placeholder">
          {busy ? '생성 중…' : '상단의 "목업 생성"을 누르면 실제 화면을 그대로 재현한 목업을 캔버스에 펼칩니다.'}
        </p>
      </div>
    );
  }

  return (
    <div
      className="tl-canvas-vp"
      onMouseDown={(e) => { drag.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }; }}
    >
      <div className="tl-canvas-pan" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        {/* pointer-events:none so dragging over the iframe still pans the canvas */}
        <iframe className="tl-canvas-frame" sandbox="" srcDoc={html} title="목업" />
      </div>
    </div>
  );
}
