import { useEffect, useMemo, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { Json } from '../api/client';
import { errText } from '../components/common';
import { LeafletMap, type MapPoint, type MapView } from '../geo/LeafletMap';
import { geo, hhmmss } from '../geo/api';
import { tr } from '../i18n';
import type { Experiment, ResultRow } from './api';
import { ARC, arcLayers, planLayers, planPositions, type ArcMode } from './layers';
import { useReplay } from './ReplayBar';
import { hasCap } from './scenarioMatch';

const MODES: [ArcMode, string][] = [['routes', 'Routes'], ['before', 'Before'], ['after', 'After'], ['solution', 'Solution']];
const key = (xs: number[][]) => new Set(xs.map(([a, b]) => `${a}:${b}`));

/** Two methods side by side on the same scenario: two maps that pan and zoom together, the same view on both
 *  (validated routes, or the candidate reduction: before / after / solution), one vehicle filter, one replay clock, and
 *  the differences counted from the recorded data of the two runs. */
export function MethodMaps({ exp, rows, hash, setErr }: { exp: Experiment; rows: ResultRow[]; hash: string; setErr: (s: string | null) => void }) {
  const [cfg, setCfg] = useState<Json | null>(null);
  const [a, setA] = useState(0);
  const [b, setB] = useState(Math.min(1, rows.length - 1));
  const [mode, setMode] = useState<ArcMode>('routes');
  const [veh, setVeh] = useState<number | 'all'>('all');
  const [sync, setSync] = useState(true);
  const [view, setView] = useState<MapView | null>(null);
  const [data, setData] = useState<{ plan: (Json | null)[]; arc: (Json | null)[] }>({ plan: [null, null], arc: [null, null] });
  const [playing, setPlaying] = useState(false);
  const canArc = hasCap(exp, 'candidates'), canPlay = hasCap(exp, 'playback');
  useEffect(() => { geo.config().then(setCfg).catch((e) => setErr(errText(e))); }, [setErr]);
  const pair = [rows[Math.min(a, rows.length - 1)], rows[Math.min(b, rows.length - 1)]];
  const runOf = (r: ResultRow | undefined) => (r ? exp.runs.find((x) => x.instance_hash === hash && x.campaign_id === r.campaign_id && x.method_id === r.method_id) : undefined);
  const ra = runOf(pair[0]), rb = runOf(pair[1]);
  useEffect(() => {
    let live = true;
    setData({ plan: [null, null], arc: [null, null] }); setPlaying(false);
    const load = async (run: typeof ra) => {
      if (!run) return [null, null] as const;
      const plan = canPlay ? await geo.playback(run.campaign_id, run.run_id).catch(() => null) : null;
      const arc = canArc ? await geo.candidates(run.campaign_id, run.run_id).catch(() => null) : null;
      return [plan, arc] as const;
    };
    Promise.all([load(ra), load(rb)]).then(([x, y]) => { if (live) setData({ plan: [x[0], y[0]], arc: [x[1], y[1]] }); }).catch((e) => live && setErr(errText(e)));
    return () => { live = false; };
  }, [ra?.run_id, rb?.run_id, canArc, canPlay]); // eslint-disable-line react-hooks/exhaustive-deps
  const m: ArcMode = mode !== 'routes' && !canArc ? 'routes' : mode;
  // one clock for both replays: the union of the two timelines
  const merged = useMemo(() => { const ps = data.plan.filter((p): p is Json => !!p); return ps.length ? { t_min: Math.min(...ps.map((p) => p.t_min)), t_max: Math.max(...ps.map((p) => p.t_max)) } : null; }, [data.plan]);
  const replay = useReplay(merged, m === 'routes' && playing);
  useEffect(() => { replay.setPlaying(playing); }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps
  const layers = (i: number) => {
    if (m === 'routes') return data.plan[i] ? { ...planLayers(data.plan[i]!), counts: null } : { points: [] as MapPoint[], lines: [], counts: null };
    return data.arc[i] ? arcLayers(data.arc[i]!, m, veh) : { points: [] as MapPoint[], lines: [], counts: null };
  };
  const la = layers(0), lb = layers(1);
  const vehicles = (data.arc[0]?.by_vehicle ?? data.arc[0]?.vehicles ?? []) as Json[];
  // differences from the two recorded runs (same candidates: same scenario): removed and solution vehicle-edges
  const diff = useMemo(() => {
    const [x, y] = data.arc; if (!x || !y) return null;
    const only = (p: Set<string>, q: Set<string>) => [...p].filter((k) => !q.has(k) && (veh === 'all' || k.startsWith(`${veh}:`))).length;
    const both = (p: Set<string>, q: Set<string>) => [...p].filter((k) => q.has(k) && (veh === 'all' || k.startsWith(`${veh}:`))).length;
    const rx = key(x.removed), ry = key(y.removed), sx = key(x.selected), sy = key(y.selected);
    return { removed: [only(rx, ry), both(rx, ry), only(ry, rx)], selected: [only(sx, sy), both(sx, sy), only(sy, sx)] };
  }, [data.arc, veh]);
  const served = (i: number) => (data.plan[i] ? `${data.plan[i]!.served}/${data.plan[i]!.riders}` : null);
  if (rows.length < 2) return <p className="muted">{tr('Select at least two methods to compare their maps.')}</p>;
  if (!hasCap(exp, 'map')) return <p className="muted">{tr('This problem has no map.')}</p>;
  const pick = (i: number, val: number, set: (n: number) => void, label: string) => <label className="row small gap">{label}
    <select aria-label={`${tr('method')} ${label}`} value={val} onChange={(e) => set(Number(e.target.value))}>{rows.map((r, k) => <option key={`${r.campaign_id}:${r.method_id}`} value={k}>{r.name}</option>)}</select>
    {served(i) && <span className="muted nowrap">{tr('served')} {served(i)}</span>}</label>;
  const legend = (i: number) => { const d = data.arc[i]; const l = i === 0 ? la : lb; const c = l.counts as { candidates: number; retained: number; removed: number; protected: number; selected: number } | null;
    if (m === 'routes') return data.plan[i] ? <span className="small">{tr('validated routes on road geometry')}</span> : <span className="small muted">{ra && rb ? tr('Loading…') : tr('no run of this method on this scenario')}</span>;
    if (!d || !c) return <span className="small muted">{tr('no candidate data for this run')}</span>;
    return <span className="small">{m === 'before' && `${c.candidates.toLocaleString('en')} ${tr('candidate vehicle-edges')}`}
      {m === 'after' && <><i className="lg-line" style={{ borderColor: ARC.retained }} />{tr('Retained')} {c.retained.toLocaleString('en')} · <i className="lg-dash" style={{ borderColor: ARC.removed }} />{tr('Removed')} {c.removed.toLocaleString('en')} ({c.candidates ? (100 * c.removed / c.candidates).toFixed(1) : '0.0'} %)
        {c.protected > 0 && <> · <i className="lg-line" style={{ borderColor: ARC.protected }} />{tr('Kept by the structural rule')} {c.protected.toLocaleString('en')}</>}</>}
      {m === 'solution' && <><i className="lg-line" style={{ borderColor: ARC.selected }} />{tr('Used by the solution')} {c.selected.toLocaleString('en')}</>}</span>; };
  return <div className="method-maps">
    <div className="row gap wrap chart-controls" role="group" aria-label={tr('map comparison settings')}>
      {pick(0, a, setA, 'A')}{pick(1, b, setB, 'B')}
      <div className="seg" role="group" aria-label={tr('map view')}>{MODES.filter(([x]) => x === 'routes' || canArc).map(([x, label]) => <button key={x} className={m === x ? 'on' : ''} aria-pressed={m === x} onClick={() => { setMode(x); setPlaying(false); }}>{tr(label)}</button>)}</div>
      {m !== 'routes' && vehicles.length > 0 && <select aria-label={tr('vehicle')} value={String(veh)} onChange={(e) => setVeh(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
        <option value="all">{tr('All vehicles')}</option>{vehicles.map((x) => <option key={x.vehicle_id} value={x.vehicle_id}>{x.label}</option>)}</select>}
      <label className="row small gap"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> {tr('Synchronised maps')}</label>
      {m === 'routes' && merged && <><button className="btn sm" onClick={() => setPlaying(!playing)} aria-label={playing ? tr('pause the replay') : tr('replay both')}>{playing ? <Pause size={13} /> : <Play size={13} />} {playing ? tr('Pause') : tr('Replay both')}</button>
        <input type="range" aria-label={tr('replay time')} min={merged.t_min} max={merged.t_max} step={1} value={replay.t} onChange={(e) => replay.setT(Number(e.target.value))} />
        <span className="small mono">{hhmmss(replay.t)}</span></>}
    </div>
    {m !== 'routes' && <p className="tiny muted">{tr('Straight lines are logical stop edges of the formulation, not road routes. Counts are vehicle-edges (vehicle, edge).')}</p>}
    <div className="maps-two">{[0, 1].map((i) => <div key={i} className="map-side" aria-label={`${tr('map')} ${i === 0 ? 'A' : 'B'}`}>
      <div className="map-side-head"><div className="row gap"><span className="badge">{i === 0 ? 'A' : 'B'}</span><b className="ellipsis">{pair[i]?.name}</b></div><div className="map-side-legend ellipsis">{legend(i)}</div></div>
      {cfg && <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={(i === 0 ? la : lb).points} lines={(i === 0 ? la : lb).lines}
        dynamic={m === 'routes' && data.plan[i] && (playing || replay.t > (merged?.t_min ?? 0)) ? planPositions(data.plan[i]!, replay.t) : []}
        fitKey={sync ? `mm|${hash}|${m}|${data.plan[0] || data.arc[0] ? 1 : 0}` : `mm${i}|${hash}|${m}|${(i === 0 ? ra : rb)?.run_id ?? ''}`} view={sync ? view : null} onView={sync ? setView : undefined} height="100%" />}</div>)}</div>
    {diff && m !== 'routes' && <div className="card diff-card" aria-label={tr('differences between the two methods')}><table className="compact"><thead><tr><th>{tr('Difference (vehicle-edges)')}</th><th className="n">{tr('only A')}</th><th className="n">{tr('both')}</th><th className="n">{tr('only B')}</th></tr></thead>
      <tbody><tr><td>{tr('Removed by the policy')}</td>{diff.removed.map((v, i) => <td key={i} className="n">{v.toLocaleString('en')}</td>)}</tr>
        <tr><td>{tr('Used by the validated solution')}</td>{diff.selected.map((v, i) => <td key={i} className="n">{v.toLocaleString('en')}</td>)}</tr></tbody></table></div>}
  </div>;
}
