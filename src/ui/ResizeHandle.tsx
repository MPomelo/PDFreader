import { useEffect, useRef } from 'react';
import { DEFAULT_WIDTHS } from './panel-widths';
export function ResizeHandle({ side, width, max, onResize }: { side: 'left' | 'right'; width: number; max: number; onResize: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const direction = side === 'left' ? 1 : -1;
  function finish() { drag.current = null; document.documentElement.classList.remove('resizing-panels'); }
  useEffect(() => () => { if (drag.current) finish(); }, []);
  return <div className={`resize-handle resize-${side}`} role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={side === 'left' ? '调整左侧栏宽度' : '调整右侧栏宽度'} aria-controls={side === 'left' ? 'left-panel' : 'translation-panel'}
    aria-valuenow={Math.round(width)} aria-valuemin={side === 'left' ? 160 : 280} aria-valuemax={Math.floor(max)}
    title="拖动调整宽度；方向键微调；双击恢复默认宽度"
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); document.documentElement.classList.add('resizing-panels'); }}
    onPointerMove={event => { if (drag.current) onResize(drag.current.width + direction * (event.clientX - drag.current.x)); }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={() => onResize(DEFAULT_WIDTHS[side])}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onResize(width + (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 50 : 20)); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); onResize(event.key === 'Home' ? DEFAULT_WIDTHS[side] : max); }
    }} />;
}
