import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { tr } from '../i18n';

export interface PaletteItem { id: string; label: string; icon: ReactNode; title?: string; disabled?: boolean }

/** A small palette of things to place on the map. An item is dragged onto the map (pointer events: mouse, pen and
 *  touch alike) or selected with a click, a tap or the keyboard — the next click on the map then places it. */
export function Palette({ items, armed, disabled, onArm, onDrop }: {
  items: PaletteItem[]; armed: string | null; disabled?: boolean;
  /** the item was selected (click, tap, Enter): it is placed by the next click on the map */
  onArm: (id: string) => void;
  /** the item was dragged and released at this point of the screen */
  onDrop: (id: string, clientX: number, clientY: number) => void;
}) {
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const noClickBefore = useRef(0);                         // the click that ends a drag is not a selection
  const [ghost, setGhost] = useState<{ id: string; x: number; y: number } | null>(null);
  const down = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { id, x: e.clientX, y: e.clientY, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) d.moved = true;
    if (d.moved) setGhost({ id: d.id, x: e.clientX, y: e.clientY });
  };
  const up = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null; setGhost(null);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!d?.moved) return;
    noClickBefore.current = performance.now() + 400;
    onDrop(d.id, e.clientX, e.clientY);
  };
  const cancel = () => { drag.current = null; setGhost(null); };
  const shown = ghost ? items.find((i) => i.id === ghost.id) : null;
  return <div className="palette" role="toolbar" aria-label={tr('palette')}>
    {items.map((it) => <button key={it.id} type="button" className={`pal-item${armed === it.id ? ' on' : ''}`} data-item={it.id} disabled={disabled || it.disabled}
      aria-pressed={armed === it.id} title={it.title ?? tr('Drag onto the map, or select and click the map')}
      onPointerDown={(e) => down(e, it.id)} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
      onClick={() => { if (performance.now() < noClickBefore.current) { noClickBefore.current = 0; return; } onArm(it.id); }}>
      {it.icon}<span>{it.label}</span></button>)}
    {shown && ghost && <span className="pal-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden="true">{shown.icon}<span>{shown.label}</span></span>}
  </div>;
}
