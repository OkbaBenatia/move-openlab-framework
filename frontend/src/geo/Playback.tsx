import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { Json } from '../api/client';
import { errText } from '../components/common';
import { COLORS, LeafletMap, type MapLine, type MapPoint } from './LeafletMap';
import { geo, hhmmss, type GeoConfig } from './api';

const dur = (s: number) => (Math.abs(s) < 60 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

const PALETTE = ['#1f5fd1', '#15803d', '#7c3aed', '#c2410c', '#0f766e', '#a21caf', '#b45309', '#0369a1', '#4d7c0f', '#be123c'];

function positionAt(path: number[][], t: number): [number, number] | null {
  if (!path.length || t < path[0][2]) return null;
  if (t >= path[path.length - 1][2]) return null;
  for (let i = 1; i < path.length; i++) {
    if (path[i][2] >= t) {
      const [a, b] = [path[i - 1], path[i]];
      const f = b[2] > a[2] ? (t - a[2]) / (b[2] - a[2]) : 1;
      return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
    }
  }
  return null;
}

/** Route playback of one validated run: the instance's own travel times, earliest feasible departures. */
export function Playback({ campaign, setErr }: { campaign: Json; setErr: (s: string | null) => void }) {
  const [cfg, setCfg] = useState<GeoConfig | null>(null);
  const runs: Json[] = useMemo(() => campaign.runs.filter((r: Json) => r.repetition === 1), [campaign]);
  const [runId, setRunId] = useState<string>(runs[0]?.run_id ?? '');
  const [plan, setPlan] = useState<Json | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const raf = useRef<number | null>(null);
  useEffect(() => { geo.config().then(setCfg).catch((e) => setErr(errText(e))); }, [setErr]);
  useEffect(() => {
    if (!runId) return;
    setPlaying(false);
    geo.playback(campaign.campaign_id, runId).then((p) => { setPlan(p); setT(p.t_min); }).catch((e) => setErr(errText(e)));
  }, [campaign.campaign_id, runId, setErr]);
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
  const lines: MapLine[] = useMemo(() => (plan?.vehicles ?? []).map((v: Json, i: number) => ({ coords: v.path.map((p: number[]) => [p[0], p[1]]), color: v.rider ? PALETTE[i % PALETTE.length] : '#94a3b8', weight: v.rider ? 4 : 2, dash: v.rider ? undefined : '4 6', label: v.rider ? `${v.driver} carries ${v.rider} · detour ${dur(v.detour_s)}` : `${v.driver} alone` })), [plan]);
  const points: MapPoint[] = useMemo(() => [
    ...(plan?.vehicles ?? []).flatMap((v: Json) => v.stops.filter((s: Json) => s.type === 'pickup' || s.type === 'dropoff').map((s: Json) => ({ lat: s.at[0], lon: s.at[1], color: COLORS.rider, fill: s.type === 'pickup', radius: 5, label: `${s.rider} ${s.type} ${hhmmss(s.t)}` }))),
    ...(plan?.unserved ?? []).map((u: Json) => ({ lat: u.at[0], lon: u.at[1], color: COLORS.unserved, radius: 6, label: `${u.rider} unserved` }))], [plan]);
  const dynamic: MapPoint[] = (plan?.vehicles ?? []).flatMap((v: Json, i: number) => { const p = positionAt(v.path, t); return p ? [{ lat: p[0], lon: p[1], color: v.rider ? PALETTE[i % PALETTE.length] : '#64748b', label: v.driver }] : []; });
  const events = (plan?.vehicles ?? []).flatMap((v: Json) => v.stops.map((s: Json) => ({ ...s, driver: v.driver }))).sort((a: Json, b: Json) => a.t - b.t);
  const recent = events.filter((e: Json) => e.t <= t).slice(-6).reverse();
  if (!cfg) return null;
  return <div>
    <div className="row gap actions">
      <label className="row">Run <select value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="run">{runs.map((r) => <option key={r.run_id} value={r.run_id}>{r.instance_id} · {r.method_id}</option>)}</select></label>
      {plan && <><button className="btn" onClick={() => { if (t >= plan.t_max) setT(plan.t_min); setPlaying(!playing); }} aria-label={playing ? 'pause' : 'play'}>{playing ? <Pause size={13} /> : <Play size={13} />}</button>
        <input type="range" min={plan.t_min} max={plan.t_max} step={1} value={t} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="time" className="grow" />
        <span className="mono">{hhmmss(t)}</span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="speed">{[10, 30, 60, 120].map((s) => <option key={s} value={s}>×{s}</option>)}</select></>}
    </div>
    {plan && <p className="small muted">{plan.served}/{plan.riders} riders served · served riders {plan.metrics.served} · total detour {dur(plan.metrics.detour_s)} · geometry: {plan.geometry === 'road' ? 'road network routes' : 'straight segments (network not installed)'} · timing: {plan.timing}.</p>}
    <div className="split">
      <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} lines={lines} points={points} dynamic={dynamic} fitKey={runId} height={520} />
      <div><h3>Events up to {hhmmss(t)}</h3>{recent.length === 0 ? <p className="muted small">No event yet.</p> :
        <table aria-label="events"><tbody>{recent.map((e: Json, i: number) => <tr key={i}><td className="mono">{hhmmss(e.t)}</td><td>{e.driver}</td><td>{e.type}{e.rider ? ` ${e.rider}` : ''}</td></tr>)}</tbody></table>}</div>
    </div>
  </div>;
}
