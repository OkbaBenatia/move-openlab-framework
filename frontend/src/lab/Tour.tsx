import { useEffect, useLayoutEffect, useState } from 'react';

export const TOUR_STEPS: { anchor: string; title: string; text: string }[] = [
  { anchor: 'context', title: 'Area, dataset, experiment', text: 'Choose where you work, which trip data you use and which experiment you open. Lists follow the selected area.' },
  { anchor: 'scenario', title: 'Scenario and participants', text: 'The drivers and riders of the selected scenario, with their time windows and whether they were served.' },
  { anchor: 'map', title: 'Map', text: 'Participants, pickups, drop-offs and the routes of the selected method on the road network.' },
  { anchor: 'methods', title: 'Methods', text: 'Tick the methods to run. Keeping the same methods re-executes the experiment; adding one extends it.' },
  { anchor: 'run', title: 'Run', text: 'Runs in the background with live progress. Every solution is checked by the independent validator.' },
  { anchor: 'results', title: 'Results and comparability', text: 'Key results per method and whether this experiment can be compared with the one it derives from.' },
  { anchor: 'compare', title: 'Compare and replay', text: 'Compare opens the table and charts; Replay plays the routes over time.' },
  { anchor: 'share', title: 'Export and import', text: 'Export a verified bundle for a colleague, or import theirs and reproduce it here.' },
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
