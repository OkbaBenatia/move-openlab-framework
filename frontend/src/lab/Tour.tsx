import { useEffect, useLayoutEffect, useState } from 'react';

export const TOUR_STEPS: { anchor: string; title: string; text: string }[] = [
  { anchor: 'scenario', title: 'Demo', text: 'The public demonstration opens first: participants, vehicles, methods and results on real road data.' },
  { anchor: 'context', title: 'Area and data', text: 'Choose the area, the trip data and the experiment. Generate creates a scenario in five steps.' },
  { anchor: 'scenario', title: 'Participants and vehicles', text: 'Drivers, riders and their vehicles; click a participant to find it on the map.' },
  { anchor: 'run', title: 'Run', text: 'Runs the ticked methods in the background; every solution is checked independently.' },
  { anchor: 'results', title: 'Results', text: 'Objective, runtime and CO₂ per method, with the comparability of this experiment.' },
  { anchor: 'compare', title: 'Compare', text: 'Table and charts of the methods, or two experiments side by side.' },
  { anchor: 'replay', title: 'Replay', text: 'Plays the routes over time on the map.' },
  { anchor: 'share', title: 'Export, reproduce, extend', text: 'Export a verified bundle; import one to reproduce it or extend it with your method.' },
];

/** Optional guided tour: highlights one interface element per step. Skip closes it; "Don't show again" is saved for
 *  this account. Keys: Esc, ←, →. */
export function Tour({ onClose }: { onClose: (dontShowAgain: boolean) => void }) {
  const [i, setI] = useState(0);
  const [never, setNever] = useState(false);
  const [box, setBox] = useState<DOMRect | null>(null);
  const step = TOUR_STEPS[i];
  useLayoutEffect(() => {
    const place = () => {                         // follows layout changes (panels loading, notices closing)
      const el = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${step.anchor}"]`)).find((e) => e.offsetParent !== null);
      const r = el ? el.getBoundingClientRect() : null;
      setBox((b) => (r && b && r.x === b.x && r.y === b.y && r.width === b.width && r.height === b.height ? b : r));
    };
    place();
    const timer = window.setInterval(place, 250);
    return () => window.clearInterval(timer);
  }, [step.anchor]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(never);
      if (e.key === 'ArrowRight') setI((x) => Math.min(TOUR_STEPS.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [never, onClose]);
  const last = i === TOUR_STEPS.length - 1;
  const vw = window.innerWidth, vh = window.innerHeight, cw = Math.min(320, vw - 32);
  const below = box ? box.bottom + 12 + 190 < vh : false;
  const card = box ? { left: Math.max(16, Math.min(vw - cw - 16, box.left)), top: below ? box.bottom + 12 : Math.max(16, box.top - 12 - 190) } : { left: (vw - cw) / 2, top: vh / 3 };
  return <div className="tour" role="dialog" aria-label="quick tour" aria-modal="true">
    {box ? <div className="tour-spot" style={{ left: box.left - 4, top: box.top - 4, width: box.width + 8, height: box.height + 8 }} /> : <div className="tour-dim" />}
    <div className="tour-card" style={{ ...card, width: cw }}>
      <div className="small muted">{i + 1} / {TOUR_STEPS.length}</div>
      <h3>{step.title}</h3>
      <p>{step.text}</p>
      <label className="row small"><input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} /> Don't show again</label>
      <div className="row gap">
        <button className="btn sm" onClick={() => onClose(never)}>Skip</button><span className="grow" />
        {i > 0 && <button className="btn sm" onClick={() => setI(i - 1)}>Back</button>}
        <button className="btn sm primary" onClick={() => (last ? onClose(true) : setI(i + 1))}>{last ? 'Done' : 'Next'}</button>
      </div>
    </div>
  </div>;
}
