import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, Map as MapIcon, MapPinned, Pencil, Plus, Shuffle, Trash2 } from 'lucide-react';
import type { Json } from '../api/client';
import { errText, num } from '../components/common';
import { COLORS, LeafletMap, type MapLine, type MapPoint } from './LeafletMap';
import { geo, hhmm, toSec, type Agent, type Area, type GeoConfig, type Scenario } from './api';
import { Areas } from './Areas';
import { Datasets } from './Datasets';

type View = 'areas' | 'datasets' | 'library' | 'editor' | 'generate';
const CURRENT_KEY = 'move-openlab.area';

const VIEWS: View[] = ['areas', 'datasets', 'library', 'editor', 'generate'];

export function GeoWorkbench({ setErr, onUseInCampaign, initialView, onView }: { setErr: (s: string | null) => void; onUseInCampaign: (hashes: string[]) => void; initialView?: string; onView?: (v: string) => void }) {
  const [cfg, setCfg] = useState<GeoConfig | null>(null);
  const [view, setView] = useState<View>(VIEWS.includes(initialView as View) ? (initialView as View) : 'library');
  const [lib, setLib] = useState<Json[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [currentId, setCurrentId] = useState<string>(() => { try { return localStorage.getItem(CURRENT_KEY) ?? ''; } catch { return ''; } });
  const [editing, setEditing] = useState<{ scenario: Scenario; parent?: string } | null>(null);
  useEffect(() => { if (VIEWS.includes(initialView as View)) setView(initialView as View); }, [initialView]);
  const load = useCallback(() => {
    geo.config().then(setCfg).catch((e) => setErr(errText(e)));
    geo.scenarios().then((r) => setLib(r.scenarios)).catch((e) => setErr(errText(e)));
    geo.areas().then((r) => setAreas(r.areas)).catch((e) => setErr(errText(e)));
  }, [setErr]);
  useEffect(load, [load]);
  const current = areas.find((a) => a.area_id === currentId) ?? areas.find((a) => a.network_id) ?? areas[0] ?? null;
  const setCurrent = (id: string) => { setCurrentId(id); try { localStorage.setItem(CURRENT_KEY, id); } catch { /* storage unavailable */ } };
  if (!cfg) return null;
  const netReady = !!current?.network_id;
  const tabs: [View, string, typeof MapIcon][] = [['areas', 'Areas', MapPinned], ['datasets', 'Datasets', Database], ['library', 'Library', MapIcon], ['editor', 'Editor', Pencil], ['generate', 'Generate', Shuffle]];
  return <div>
    <div className="areabar">
      <label className="row gap"><span className="small muted">Area</span>
        <select value={current?.area_id ?? ''} onChange={(e) => setCurrent(e.target.value)} aria-label="current area" disabled={!areas.length}>
          {!areas.length && <option value="">no area yet</option>}
          {areas.map((a) => <option key={a.area_id} value={a.area_id}>{a.name}{a.network_id ? '' : ' (no network)'}</option>)}</select></label>
      {current && <span className="small muted">{current.profile} · {num(current.km2, 0)} km²</span>}
    </div>
    <nav className="subtabs" aria-label="geographic sections">{tabs.map(([v, label, Icon]) =>
      <button key={v} className={`btn ${view === v ? 'primary' : ''}`} onClick={() => { setErr(null); setView(v); onView?.(v); }}><Icon size={13} /> {label}</button>)}</nav>
    {!netReady && (view === 'editor' || view === 'generate') && <p className="note warn">{current ? `No road network for “${current.name}” yet: download it under Areas.` : 'Create an area under Areas first.'}</p>}
    {view === 'areas' && <Areas cfg={cfg} areas={areas} current={current} setCurrent={setCurrent} setErr={setErr} onChanged={load} />}
    {view === 'datasets' && <Datasets cfg={cfg} areas={areas} current={current} setErr={setErr} onChanged={load} />}
    {view === 'library' && <Library cfg={cfg} lib={lib} setErr={setErr} onEdit={(sc, parent) => { setEditing({ scenario: sc, parent }); setView('editor'); }} onUse={onUseInCampaign} />}
    {view === 'editor' && (netReady || editing) && <Editor key={editing?.parent ?? current?.network_id} cfg={cfg} area={current} areas={areas} initial={editing} setErr={setErr}
      onSaved={() => { setEditing(null); load(); setView('library'); }} onCancel={editing ? () => { setEditing(null); setView('library'); } : undefined} />}
    {view === 'generate' && netReady && current && <Generate area={current} areas={areas} setErr={setErr} onSaved={() => { load(); setView('library'); }} />}
    <p className="small muted attribution">Road data {cfg.osm_licence}. Map tiles: {cfg.tile_attribution.replace(/<[^>]+>/g, '').replace(/&copy;/g, '©').replace(/&amp;/g, '&')}.</p>
  </div>;
}

export function instanceLayers(inst: Json | null, showPairs: boolean): { points: MapPoint[]; lines: MapLine[] } {
  if (!inst) return { points: [], lines: [] };
  const points: MapPoint[] = [], lines: MapLine[] = [];
  for (const d of inst.drivers as Json[]) {
    points.push({ lat: d.origin[0], lon: d.origin[1], color: COLORS.driver, label: `${d.id} origin · ${hhmm(d.earliest)}–${hhmm(d.latest)}` });
    points.push({ lat: d.destination[0], lon: d.destination[1], color: COLORS.driver, fill: false, label: `${d.id} destination` });
  }
  for (const r of inst.riders as Json[]) {
    points.push({ lat: r.origin[0], lon: r.origin[1], color: COLORS.rider, label: `${r.id} pickup · ${hhmm(r.earliest)}–${hhmm(r.latest)}` });
    points.push({ lat: r.destination[0], lon: r.destination[1], color: COLORS.rider, fill: false, label: `${r.id} drop-off` });
  }
  if (showPairs && inst.pairs) {
    const pos: Record<string, [number, number]> = {};
    for (const a of [...inst.drivers, ...inst.riders] as Json[]) pos[a.id] = a.origin;
    for (const p of inst.pairs as Json[]) lines.push({ coords: [pos[p.driver], pos[p.rider]], color: COLORS.match, weight: 1, dash: '3 5', opacity: 0.6, label: `${p.driver} → ${p.rider} · detour ${Math.round(p.detour_s / 60)} min` });
  }
  return { points, lines };
}

function provText(p?: Json): string {
  if (!p) return '—';
  const own = [p.source, p.seed != null ? `seed ${p.seed}` : null, p.release ? `release ${p.release}` : null, p.attribution].filter(Boolean).join(' · ');
  return p.derived_from ? `${own} · edited from ${p.parent} · original: ${provText(p.derived_from)}` : own;
}

function Library({ cfg, lib, setErr, onEdit, onUse }: { cfg: GeoConfig; lib: Json[]; setErr: (s: string | null) => void; onEdit: (s: Scenario, parent: string) => void; onUse: (h: string[]) => void }) {
  const [sel, setSel] = useState<Json | null>(null);
  const [pairs, setPairs] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const open = (id: string) => geo.scenario(id).then(setSel).catch((e) => setErr(errText(e)));
  const layers = useMemo(() => instanceLayers(sel?.instance ?? null, pairs), [sel, pairs]);
  return <div className="split">
    <div>
      {lib.length === 0 ? <p className="muted">The library is empty. Create a scenario with the map editor or a generator.</p> :
        <div className="table-scroll"><table aria-label="scenario library"><thead><tr><th /><th>Scenario</th><th>Source</th><th>Drivers</th><th>Riders</th><th>Created</th><th /></tr></thead>
          <tbody>{lib.map((s) => <tr key={s.scenario_id} className={sel?.scenario_id === s.scenario_id ? 'hl' : ''}>
            <td><input type="checkbox" aria-label={`select ${s.name}`} checked={chosen.includes(s.instance_hash)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.instance_hash] : chosen.filter((x) => x !== s.instance_hash))} /></td>
            <td><b>{s.name}</b>{s.parent && <div className="small muted">edited from {s.parent}</div>}</td><td>{s.source}</td><td>{s.drivers}</td><td>{s.riders}</td>
            <td className="small">{s.created_at.slice(0, 16).replace('T', ' ')}</td><td><button className="btn sm" onClick={() => open(s.scenario_id)}>Open</button></td></tr>)}</tbody></table></div>}
      <button className="btn primary" disabled={chosen.length === 0} onClick={() => onUse(chosen)}><Plus size={13} /> New campaign with {chosen.length} scenario(s)</button>
      {sel && <><h3>{sel.name}</h3>
        <table className="kv"><tbody>
          <tr><th>Drivers · riders</th><td>{sel.summary.drivers} · {sel.summary.riders}</td></tr>
          <tr><th>Compatible pairs</th><td>{sel.summary.pairs} ({sel.summary.riders_with_option} riders with at least one option)</td></tr>
          <tr><th>Mean detour</th><td>{sel.summary.mean_detour_s == null ? '—' : `${num(sel.summary.mean_detour_s / 60, 1)} min`}</td></tr>
          <tr><th>Largest snapping distance</th><td>{num(sel.summary.max_snap_m, 0)} m</td></tr>
          <tr><th>Detour limits</th><td>{Math.round(sel.scenario.params.max_detour_s / 60)} min and {sel.scenario.params.max_detour_ratio} × direct time</td></tr>
          <tr><th>Provenance</th><td className="small">{provText(sel.scenario.provenance)}</td></tr>
          <tr><th>Instance</th><td className="mono small">{sel.instance_hash}</td></tr>
        </tbody></table>
        <div className="row gap actions"><label className="row"><input type="checkbox" checked={pairs} onChange={(e) => setPairs(e.target.checked)} /> Show compatible pairs</label>
          <button className="btn" onClick={() => onEdit(sel.scenario, sel.scenario_id)}><Pencil size={13} /> Edit as new version</button></div></>}
    </div>
    <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={layers.points} lines={layers.lines} fitKey={sel?.scenario_id ?? 'none'} />
  </div>;
}

function Editor({ cfg, area, areas, initial, setErr, onSaved, onCancel }: { cfg: GeoConfig; area: Area | null; areas: Area[]; initial: { scenario: Scenario; parent?: string } | null; setErr: (s: string | null) => void; onSaved: () => void; onCancel?: () => void }) {
  const [sc, setSc] = useState<Scenario>(initial?.scenario ?? { name: 'New scenario', network_id: area?.network_id ?? '', params: { max_detour_s: 900, max_detour_ratio: 0.5 }, drivers: [], riders: [] });
  const [pick, setPick] = useState<{ role: 'drivers' | 'riders'; id: string; field: 'origin' | 'destination' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<MapLine[]>([]);
  const net = cfg.networks.find((n) => n.network_id === sc.network_id);
  const box = (net?.area.bbox ?? area?.bbox ?? [0, 0, 0, 0]) as [number, number, number, number];
  const nextId = (prefix: string, list: Agent[]) => `${prefix}${list.reduce((m, a) => Math.max(m, Number(a.id.slice(1)) || 0), 0) + 1}`;
  const add = (role: 'drivers' | 'riders') => {
    const list = sc[role]; const id = nextId(role === 'drivers' ? 'D' : 'R', list);
    const [s, w, n, e] = box; const c: [number, number] = [Number(((s + n) / 2).toFixed(5)), Number(((w + e) / 2).toFixed(5))];
    setSc({ ...sc, [role]: [...list, { id, origin: c, destination: c, earliest: 7 * 3600 + 30 * 60, latest: role === 'drivers' ? 7 * 3600 + 45 * 60 : 7 * 3600 + 50 * 60 }] });
    setPick({ role, id, field: 'origin' });
  };
  const update = (role: 'drivers' | 'riders', id: string, patch: Partial<Agent>) => setSc({ ...sc, [role]: sc[role].map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  const remove = (role: 'drivers' | 'riders', id: string) => setSc({ ...sc, [role]: sc[role].filter((a) => a.id !== id) });
  const onClick = (lat: number, lon: number) => {
    if (!pick) return;
    update(pick.role, pick.id, { [pick.field]: [lat, lon] } as Partial<Agent>);
    setPick(pick.field === 'origin' ? { ...pick, field: 'destination' } : null);
  };
  const points: MapPoint[] = [...sc.drivers.flatMap((d) => [{ lat: d.origin[0], lon: d.origin[1], color: COLORS.driver, label: `${d.id} origin` }, { lat: d.destination[0], lon: d.destination[1], color: COLORS.driver, fill: false, label: `${d.id} destination` }]),
    ...sc.riders.flatMap((r) => [{ lat: r.origin[0], lon: r.origin[1], color: COLORS.rider, label: `${r.id} pickup` }, { lat: r.destination[0], lon: r.destination[1], color: COLORS.rider, fill: false, label: `${r.id} drop-off` }])];
  const routePreview = async (a: Agent) => {
    try { const r = await geo.route(sc.network_id, a.origin, a.destination); setPreview([{ coords: r.coords, color: COLORS.route, weight: 4, label: `${a.id}: ${Math.round(r.time_s / 60)} min · ${(r.length_m / 1000).toFixed(1)} km` }]); }
    catch (e) { setErr(errText(e)); }
  };
  const save = async () => { setBusy(true); setErr(null); try { await geo.save(sc, initial?.parent); onSaved(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };
  const row = (role: 'drivers' | 'riders', a: Agent) => <tr key={a.id} className={pick?.id === a.id ? 'hl' : ''}>
    <td className="mono">{a.id}</td>
    <td><button className={`btn sm ${pick?.id === a.id && pick.field === 'origin' ? 'primary' : ''}`} onClick={() => setPick({ role, id: a.id, field: 'origin' })}>Origin</button>{' '}
      <button className={`btn sm ${pick?.id === a.id && pick.field === 'destination' ? 'primary' : ''}`} onClick={() => setPick({ role, id: a.id, field: 'destination' })}>Destination</button></td>
    <td><input aria-label={`${a.id} earliest`} className="time" defaultValue={hhmm(a.earliest)} onBlur={(e) => { const v = toSec(e.target.value); if (!Number.isNaN(v)) update(role, a.id, { earliest: v }); }} /></td>
    <td><input aria-label={`${a.id} latest`} className="time" defaultValue={hhmm(a.latest)} onBlur={(e) => { const v = toSec(e.target.value); if (!Number.isNaN(v)) update(role, a.id, { latest: v }); }} /></td>
    <td><button className="btn sm" onClick={() => routePreview(a)}>Route</button> <button className="btn icon" aria-label={`remove ${a.id}`} onClick={() => remove(role, a.id)}><Trash2 size={12} /></button></td></tr>;
  return <div className="split">
    <div className="form">
      <label>Name <input value={sc.name} onChange={(e) => setSc({ ...sc, name: e.target.value })} aria-label="scenario name" /></label>
      <p className="small muted">Road network: {areas.find((a) => a.network_id === sc.network_id)?.name ?? net?.area.name ?? `network ${sc.network_id.slice(0, 12)}`}{net ? ` · ${net.profile ?? "car"} · ${net.nodes} nodes` : ""}</p>
      <div className="row gap"><label>Max detour (min) <input type="number" min={0} max={120} value={Math.round(sc.params.max_detour_s / 60)} onChange={(e) => setSc({ ...sc, params: { ...sc.params, max_detour_s: Number(e.target.value) * 60 } })} aria-label="max detour minutes" /></label>
        <label>Max detour ratio <input type="number" min={0} max={5} step={0.1} value={sc.params.max_detour_ratio} onChange={(e) => setSc({ ...sc, params: { ...sc.params, max_detour_ratio: Number(e.target.value) } })} aria-label="max detour ratio" /></label></div>
      <p className="small muted">{pick ? `Click the map to place the ${pick.field} of ${pick.id}.` : 'Select Origin or Destination, then click the map. Times are HH:MM; drivers: departure window, riders: pickup window.'}</p>
      {(['drivers', 'riders'] as const).map((role) => <fieldset key={role}><legend>{role === 'drivers' ? 'Drivers' : 'Riders'} ({sc[role].length})</legend>
        {sc[role].length > 0 && <table aria-label={role}><thead><tr><th>Id</th><th>Place</th><th>Earliest</th><th>Latest</th><th /></tr></thead><tbody>{sc[role].map((a) => row(role, a))}</tbody></table>}
        <button className="btn sm" onClick={() => add(role)}><Plus size={12} /> Add {role === 'drivers' ? 'driver' : 'rider'}</button></fieldset>)}
      <div className="row gap"><button className="btn primary" disabled={busy || !sc.drivers.length || !sc.riders.length} onClick={save}>{initial?.parent ? 'Save as new version' : 'Save scenario'}</button>
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}</div>
    </div>
    <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={points} lines={preview} rects={[{ bbox: box, color: COLORS.area }]} fitKey={sc.network_id} onClick={onClick} cursor={pick ? 'crosshair' : undefined} />
  </div>;
}

function Generate({ area, areas, setErr, onSaved }: { area: Area; areas: Area[]; setErr: (s: string | null) => void; onSaved: () => void }) {
  const [datasets, setDatasets] = useState<Json[]>([]);
  const [f, setF] = useState({ source: 'synthetic', dataset_key: '', name: `${area.name} · demand`, n_drivers: 10, n_riders: 15, seed: 1, start: '07:00', end: '09:00', date: '', detour: 15, ratio: 0.5, min_trip_km: 1.5 });
  const [busy, setBusy] = useState(false);
  useEffect(() => { geo.datasets().then((r) => { const all = [...r.mine, ...r.shared]; setDatasets(all); setF((x) => ({ ...x, dataset_key: x.dataset_key || all[0]?.dataset_key || '' })); }).catch((e) => setErr(errText(e))); }, [setErr]);
  const set = (k: string, v: string | number) => setF({ ...f, [k]: v });
  const run = async () => {
    setBusy(true); setErr(null);
    const body: Json = { network_id: area.network_id, name: f.name, n_drivers: f.n_drivers, n_riders: f.n_riders, seed: f.seed, start_s: toSec(f.start), end_s: toSec(f.end), params: { max_detour_s: f.detour * 60, max_detour_ratio: f.ratio } };
    try { if (f.source === 'synthetic') await geo.generate({ ...body, min_trip_m: f.min_trip_km * 1000 }); else await geo.fromDataset({ ...body, dataset_key: f.dataset_key, date: f.date || null }); onSaved(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return <div className="form">
    <label>Source <select value={f.source} onChange={(e) => set('source', e.target.value)} aria-label="generator source">
      <option value="synthetic">Synthetic demand on the road network (seeded)</option>
      <option value="dataset" disabled={!datasets.length}>Resample a trip dataset{datasets.length ? '' : ' (no dataset)'}</option></select></label>
    {f.source === 'dataset' ? <>
      <label>Dataset <select value={f.dataset_key} onChange={(e) => set('dataset_key', e.target.value)} aria-label="dataset">{datasets.map((d) => <option key={d.dataset_key} value={d.dataset_key}>{d.provider === 'rpc' ? `RPC ${d.release} · ${areas.find((a) => a.bbox.join() === d.area.bbox.map((x: number) => Number(x.toFixed(5))).join())?.name ?? d.name.split(' · ')[1]}` : d.name} · {d.rows_kept} trips</option>)}</select></label>
      <p className="small muted">Each agent takes one record's origin–destination pair (trips outside “{area.name}” are ignored). RPC departure times are re-drawn within their 10-minute rounding; roles are respected when the dataset has them.</p>
      <label>Date (optional, YYYY-MM-DD) <input value={f.date} onChange={(e) => set('date', e.target.value)} aria-label="date" /></label></>
      : <label>Minimum trip length (km) <input type="number" min={0.2} max={50} step={0.1} value={f.min_trip_km} onChange={(e) => set('min_trip_km', Number(e.target.value))} aria-label="minimum trip length" /></label>}
    <label>Name <input value={f.name} onChange={(e) => set('name', e.target.value)} aria-label="generated name" /></label>
    <div className="row gap">
      <label>Drivers <input type="number" min={1} max={100} value={f.n_drivers} onChange={(e) => set('n_drivers', Number(e.target.value))} aria-label="drivers" /></label>
      <label>Riders <input type="number" min={1} max={100} value={f.n_riders} onChange={(e) => set('n_riders', Number(e.target.value))} aria-label="riders" /></label>
      <label>Seed <input type="number" min={0} value={f.seed} onChange={(e) => set('seed', Number(e.target.value))} aria-label="seed" /></label></div>
    <div className="row gap">
      <label>From <input className="time" value={f.start} onChange={(e) => set('start', e.target.value)} aria-label="from" /></label>
      <label>To <input className="time" value={f.end} onChange={(e) => set('end', e.target.value)} aria-label="to" /></label>
      <label>Max detour (min) <input type="number" min={0} max={120} value={f.detour} onChange={(e) => set('detour', Number(e.target.value))} aria-label="generator detour" /></label>
      <label>Ratio <input type="number" min={0} max={5} step={0.1} value={f.ratio} onChange={(e) => set('ratio', Number(e.target.value))} aria-label="generator ratio" /></label></div>
    <button className="btn primary" disabled={busy || (f.source === 'dataset' && !f.dataset_key)} onClick={run}><Shuffle size={13} /> {busy ? 'Building…' : 'Generate'}</button>
  </div>;
}
