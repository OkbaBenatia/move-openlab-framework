import { useState } from 'react';
import { num } from '../components/common';
import { tr } from '../i18n';
import { ticks } from './chartScale';
import { clamp, fmtThreshold, nearest, segments, type CurveKey, type SweepPoint } from './mlEvidence';

const CURVES: [CurveKey, string][] = [['precision', 'Precision'], ['recall', 'Recall'], ['f1', 'F1']];
const W = 360, H = 176, PL = 34, PR = 10, PT = 10, PB = 26;
const pc = (v: number | null) => (v == null ? tr('not defined') : `${num(100 * v, 1)} %`);

/** Precision, recall and F1 against the decision threshold, on one 0–1 axis, from the bounded sweep the server computed
 *  on the evidence. An undefined value breaks its line (it is never drawn as zero). The recorded threshold and the
 *  explored one are marked; pointing reads the nearest computed threshold, clicking explores it. */
export function ThresholdCurve({ sweep, range, recorded, current, name, onPick }: {
  sweep: SweepPoint[]; range: [number, number]; recorded: number; current: number; name: string; onPick: (t: number) => void;
}) {
  const [at, setAt] = useState<SweepPoint | null>(null);
  // the threshold axis covers the scores and the recorded threshold, on round ticks
  const xt = ticks(Math.min(range[0], recorded), Math.max(range[1], recorded));
  const lo = xt[0], hi = xt[xt.length - 1], span = hi - lo || 1;
  const x = (t: number) => PL + (W - PL - PR) * ((clamp(t, lo, hi) - lo) / span);
  const y = (v: number) => PT + (H - PT - PB) * (1 - v);
  const read = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return nearest(sweep, lo + span * clamp((e.clientX - r.left) / (r.width || 1), 0, 1));
  };
  return <figure className="ml-curve">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${tr('precision, recall and F1 against the threshold')} — ${name}`}>
      {[0, 0.25, 0.5, 0.75, 1].map((v) => <g key={v}><line className="grid" x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} />
        <text className="tick" x={PL - 6} y={y(v) + 3.5} textAnchor="end">{v}</text></g>)}
      {xt.map((t, i) => <text key={t} className="tick" x={x(t)} y={H - 9} textAnchor={i === xt.length - 1 ? 'end' : 'middle'}>{fmtThreshold(t)}</text>)}
      <line className="axis" x1={PL} x2={W - PR} y1={y(0)} y2={y(0)} />
      {CURVES.map(([k]) => segments(sweep, k, x, y).map((pts, i) => (pts.includes(' ')
        ? <polyline key={`${k}${i}`} className={`curve c-${k}`} points={pts} />
        : <circle key={`${k}${i}`} className={`curve-dot c-${k}`} cx={pts.split(',')[0]} cy={pts.split(',')[1]} r={2.5} />)))}
      <line className="mark recorded" x1={x(recorded)} x2={x(recorded)} y1={PT} y2={y(0)} />
      {current !== recorded && <line className="mark explored" x1={x(current)} x2={x(current)} y1={PT} y2={y(0)} />}
      {at && <line className="mark hover" x1={x(at.threshold)} x2={x(at.threshold)} y1={PT} y2={y(0)} />}
      <rect className="hit" x={PL} y={PT} width={W - PL - PR} height={H - PT - PB} onMouseMove={(e) => setAt(read(e))} onMouseLeave={() => setAt(null)}
        onClick={(e) => { const p = read(e); if (p) onPick(p.threshold); }}><title>{tr('Click to explore this threshold')}</title></rect>
    </svg>
    <figcaption>
      <div className="lgd" aria-label={tr('legend')}>
        {CURVES.map(([k, label]) => <span key={k}><svg width="22" height="8" aria-hidden="true"><line className={`curve c-${k}`} x1="1" x2="21" y1="4" y2="4" /></svg>{tr(label)}</span>)}
        <span><svg width="10" height="12" aria-hidden="true"><line className="mark recorded" x1="5" x2="5" y1="0" y2="12" /></svg>{tr('recorded threshold')}</span>
        {current !== recorded && <span><svg width="10" height="12" aria-hidden="true"><line className="mark explored" x1="5" x2="5" y1="0" y2="12" /></svg>{tr('explored threshold')}</span>}
      </div>
      <p className="tiny muted ml-readout" role="status">{at ? tr('At threshold {t}: precision {p} · recall {r} · F1 {f} · {k} of the records predicted positive',
        { t: fmtThreshold(at.threshold), p: pc(at.precision), r: pc(at.recall), f: pc(at.f1), k: `${num(100 * at.kept_share, 1)} %` })
        : tr('Point at the curve to read a computed threshold; click to explore it.')}</p>
    </figcaption>
  </figure>;
}
