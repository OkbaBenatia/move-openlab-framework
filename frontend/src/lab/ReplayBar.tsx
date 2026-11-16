import { useEffect, useRef, useState } from 'react';
import { Pause, Play, X } from 'lucide-react';
import type { Json } from '../api/client';
import { hhmm, hhmmss } from '../geo/api';
import { tr } from '../i18n';

export function positionAt(path: number[][], t: number): [number, number] | null {
  if (!path.length || t < path[0][2] || t >= path[path.length - 1][2]) return null;
  for (let i = 1; i < path.length; i++) {
    if (path[i][2] >= t) {
      const [a, b] = [path[i - 1], path[i]];
      const f = b[2] > a[2] ? (t - a[2]) / (b[2] - a[2]) : 1;
      return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
    }
  }
  return null;
}

/** Time state of a replay: plays the plan's own timeline at a chosen speed. */
export function useReplay(plan: Json | null, active: boolean) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const raf = useRef<number | null>(null);
  useEffect(() => { setPlaying(false); if (plan) setT(plan.t_min); }, [plan]);
  useEffect(() => { if (!active) setPlaying(false); }, [active]);
  useEffect(() => {
    if (!playing || !plan) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = ((now - last) / 1000) * speed; last = now;
      setT((x) => { const n = x + dt; if (n >= plan.t_max) { setPlaying(false); return plan.t_max; } return n; });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [playing, plan, speed]);
  return { t, setT, playing, setPlaying, speed, setSpeed };
}

/** Counts at time t: vehicles moving, riders on board, riders delivered, riders without a match. */
export function nowCounts(plan: Json, t: number) {
  let moving = 0, onboard = 0, delivered = 0;
  for (const v of plan.vehicles as Json[]) {
    if (positionAt(v.path, t)) moving += 1;
    const pick = v.stops.find((s: Json) => s.type === 'pickup'), drop = v.stops.find((s: Json) => s.type === 'dropoff');
    if (pick && t >= pick.t && (!drop || t < drop.t)) onboard += 1;
    if (drop && t >= drop.t) delivered += 1;
  }
  return { moving, onboard, delivered, unserved: plan.unserved.length };
}

export function ReplayBar({ plan, replay, onClose }: { plan: Json; replay: ReturnType<typeof useReplay>; onClose: () => void }) {
  const { t, setT, playing, setPlaying, speed, setSpeed } = replay;
  const span = Math.max(1, plan.t_max - plan.t_min);
  const ticks = (plan.vehicles as Json[]).flatMap((v) => v.stops.filter((s: Json) => s.type === 'pickup' || s.type === 'dropoff'));
  const n = nowCounts(plan, t);
  const pct = (100 * (t - plan.t_min)) / span;
  return <div className="replay" data-tour="replay" aria-label={tr('replay')}>
    <div className="row gap">
      <button className="btn icon" onClick={() => { if (t >= plan.t_max) setT(plan.t_min); setPlaying(!playing); }} aria-label={playing ? tr('pause') : tr('play')}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
      <span className="mono">{hhmmss(t)}</span>
      <div className="timeline grow">
        <div className="timeline-track"><span style={{ width: `${pct}%` }} /></div>
        {ticks.map((s: Json, i: number) => <i key={i} className={`tick ${s.type}`} style={{ left: `${(100 * (s.t - plan.t_min)) / span}%` }} title={`${s.rider} ${tr(s.type)} ${hhmm(s.t)}`} />)}
        <input type="range" min={plan.t_min} max={plan.t_max} step={1} value={t} aria-label={tr('time')} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} />
      </div>
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label={tr('speed')}>{[10, 30, 60, 120, 300].map((s) => <option key={s} value={s}>×{s}</option>)}</select>
      <button className="btn icon" aria-label={tr('close replay')} onClick={onClose}><X size={14} /></button>
    </div>
    <div className="small muted row gap"><span>{n.moving === 1 ? tr('{n} vehicle moving', { n: n.moving }) : tr('{n} vehicles moving', { n: n.moving })}</span><span>{n.onboard === 1 ? tr('{n} rider on board', { n: n.onboard }) : tr('{n} riders on board', { n: n.onboard })}</span><span>{tr('{n} delivered', { n: n.delivered })}</span>
      <span>{tr('{n} unserved', { n: n.unserved })}</span><span className="grow" /><span>{hhmm(plan.t_min)}–{hhmm(plan.t_max)}</span></div>
  </div>;
}
