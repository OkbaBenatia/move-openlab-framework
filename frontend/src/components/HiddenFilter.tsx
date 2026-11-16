import { useEffect, useRef, useState } from 'react';
import { EyeOff, SlidersHorizontal } from 'lucide-react';
import { t, tr } from '../i18n';
import { useInViewport } from './useInViewport';

/** The compact Filters control of a list: "Show hidden" lives here, not in the list header. Hidden records are kept
 *  out of lists and counts, never deleted; the tooltip says where to restore them. */
export function HiddenFilter({ n, on, setOn, align = 'right' }: { n: number; on: boolean; setOn: (v: boolean) => void; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useInViewport(pop, open);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [open]);
  if (n <= 0 && !on) return null;
  return <div className="menu-wrap" ref={ref}>
    <button type="button" className="btn sm" aria-haspopup="true" aria-expanded={open} title={t('hidden.tip')} onClick={() => setOpen(!open)}>
      <SlidersHorizontal size={13} /> {tr('Filters')}{on ? ' · 1' : ''}</button>
    {open && <div ref={pop} className={`menu ${align} filters-pop`} role="group" aria-label={tr('filters')}>
      <label className="row small gap" title={t('hidden.tip')}><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /><EyeOff size={13} /> {tr('Show hidden ({n})', { n })}</label></div>}
  </div>;
}
