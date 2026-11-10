import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Play, Plus, Save, Search, Square, Trash2, X } from 'lucide-react';
import { CarIcon, RiderIcon, VehicleIcon } from '../components/DomainIcons';
import type { Json, MethodRef } from '../api/client';
import { JobProgress } from '../components/JobProgress';
import { errText, num } from '../components/common';
import { COLORS, LeafletMap, type BBox, type MapLine, type MapPoint } from '../geo/LeafletMap';
import { geo, hhmm, km, mins, toSec, type Agent, type Area, type GeoConfig, type Scenario } from '../geo/api';
import type { DatasetItem } from '../lab/useLabData';
import { methodKey } from '../lab/ResultPanel';
import { BASELINE_LABEL, SCOPE_LABEL, mob, type Compose, type EmissionsConfig, type Preview, type VehicleProfile, type VehiclesInfo } from './api';
import { VehicleEditor } from './VehicleEditor';

type Source = 'synthetic' | 'dataset' | 'manual';
type Role = 'drivers' | 'riders';
const STEPS = ['Area & Data', 'Participants & Vehicles', 'Constraints', 'Methods & Experiment', 'Review & Save'];
const around = (lat: number, lon: number, halfKm = 2.5): BBox => {
  const dl = halfKm / 111.2, dn = halfKm / (111.2 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [lat - dl, lon - dn, lat + dl, lon + dn].map((x) => Number(x.toFixed(5))) as BBox;
};
const overlaps = (a: BBox | null | undefined, b: BBox | null | undefined) => !!a && !!b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

export interface WizardProps {
  cfg: GeoConfig; areas: Area[]; datasets: DatasetItem[]; methods: MethodRef[]; areaId?: string; datasetKey?: string;   // datasetKey: start from this mobility data (Library › Use)
  initial?: { scenario: Scenario & { vehicles?: Json; emissions?: EmissionsConfig }; parent?: string } | null;
  onClose: () => void; onSaved: (rec: Json) => void; onRun: (r: { campaign_id: string; job: Json }) => void;
  reloadAreas: () => void; setErr: (s: string | null) => void; onAddMethod?: () => void;
}

/** Scenario creation in five steps over the map. Nothing is stored before the Review step's Save buttons. */
/** A mobility dataset as people read it: source, release and how many observed trips fall in the area (no coordinates). */
const dsLabel = (d?: DatasetItem) => !d ? '' : d.provider === 'rpc'
  ? `RPC ${d.release ?? ''} · ${d.rows_kept != null ? `${d.rows_kept} observed trips in this area` : d.name}` : d.name;

export function Wizard({ cfg, areas, datasets, methods, areaId: areaId0, datasetKey: datasetKey0, initial, onClose, onSaved, onRun, reloadAreas, setErr, onAddMethod }: WizardProps) {
  const [step, setStep] = useState(1);
  const [areaId, setAreaId] = useState(() => initial ? (areas.find((a) => a.network_id === initial.scenario.network_id)?.area_id ?? '') : (areaId0 && areas.some((a) => a.area_id === areaId0) ? areaId0 : areas.find((a) => a.network_id)?.area_id ?? ''));
  const [source, setSource] = useState<Source>(initial ? 'manual' : datasetKey0 ? 'dataset' : 'synthetic');
  const [datasetKey, setDatasetKey] = useState(datasetKey0 ?? '');
  const [f, setF] = useState({ name: initial?.scenario.name ?? '', n_drivers: 10, n_riders: 15, seed: 1, start: '07:00', end: '09:00', date: '', detour: Math.round((initial?.scenario.params.max_detour_s ?? 900) / 60), ratio: initial?.scenario.params.max_detour_ratio ?? 0.5, min_trip_km: 1.5 });
  const [manual, setManual] = useState<{ drivers: Agent[]; riders: Agent[] }>({ drivers: initial?.scenario.drivers ?? [], riders: initial?.scenario.riders ?? [] });
  const [pick, setPick] = useState<{ role: Role; id: string; field: 'origin' | 'destination' } | null>(null);
  const [routes, setRoutes] = useState<Record<string, { line?: MapLine; text: string; error?: boolean }>>({});
  const [veh, setVeh] = useState<VehiclesInfo | null>(null);
  const [vehicleId, setVehicleId] = useState<string>(initial?.scenario.vehicles?.default ?? '');
  const [assign, setAssign] = useState<Record<string, string>>(initial?.scenario.vehicles?.assignments ?? {});
  const [editor, setEditor] = useState(false);
  const [emis, setEmis] = useState<EmissionsConfig>(initial?.scenario.emissions ?? { scope: 'operational-energy', baseline: 'everyone-drives-alone' });
  const [title, setTitle] = useState(`Experiment ${stamp()}`);
  const [checked, setChecked] = useState<string[]>([]);
  const [reps, setReps] = useState(3);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Json[] | null>(null);
  const [mapMode, setMapMode] = useState<'none' | 'point' | 'draw'>('none');
  const [draft, setDraft] = useState<{ name: string; bbox: BBox; profile: string; origin?: Json } | null>(null);
  const [corner, setCorner] = useState<[number, number] | null>(null);
  const [job, setJob] = useState<Json | null>(null);
  const [focus, setFocus] = useState<{ key: string; bbox: BBox } | null>(null);
  const [boxKm, setBoxKm] = useState(5);
  const area = areas.find((a) => a.area_id === areaId) ?? null;
  const netReady = !!area?.network_id;
  const shownDatasets = useMemo(() => datasets.filter((d) => overlaps(d.bbox, area?.bbox)), [datasets, area]);
  const allProfiles: VehicleProfile[] = useMemo(() => veh ? [...veh.mine, ...veh.presets.filter((p) => !veh.mine.some((m) => m.id === p.id))] : [], [veh]);
  const profile = allProfiles.find((p) => p.id === vehicleId) ?? null;
  const loadVehicles = useCallback(() => mob.vehicles().then((v) => { setVeh(v); setVehicleId((id) => id || (initial ? '' : v.default?.id ?? '')); }).catch((e) => setErr(errText(e))), [setErr, initial]);
  useEffect(() => { loadVehicles(); }, [loadVehicles]);
  useEffect(() => { setChecked((c) => c.length ? c : methods.filter((m) => m.source === 'builtin').map(methodKey)); }, [methods]);
  useEffect(() => { if (area) setFocus({ key: area.area_id, bbox: area.bbox }); }, [area]);
  useEffect(() => { if (!shownDatasets.some((d) => d.dataset_key === datasetKey)) setDatasetKey(shownDatasets[0]?.dataset_key ?? ''); }, [shownDatasets, datasetKey]);
  useEffect(() => { if (!f.name && area) setF((x) => ({ ...x, name: `${area.name} · ${source === 'manual' ? 'scenario' : 'demand'}` })); }, [area, source, f.name]);

  // vehicles and emissions as the scenario carries them
  const vehicles = () => {
    if (!profile) return null;
    const used = new Set([profile.id, ...Object.values(assign)]);
    return { profiles: allProfiles.filter((p) => used.has(p.id)), default: profile.id, assignments: Object.fromEntries(Object.entries(assign).filter(([, v]) => v !== profile.id)) };
  };
  const compose = (): Compose | null => {
    if (!area?.network_id) return null;
    return { source, network_id: area.network_id, name: f.name.trim() || 'New scenario', n_drivers: f.n_drivers, n_riders: f.n_riders, seed: f.seed, start_s: toSec(f.start), end_s: toSec(f.end),
      params: { max_detour_s: Math.round(f.detour * 60), max_detour_ratio: f.ratio }, min_trip_m: Math.round(f.min_trip_km * 1000), dataset_key: source === 'dataset' ? datasetKey : null,
      date: source === 'dataset' && f.date ? f.date : null, drivers: source === 'manual' ? manual.drivers : undefined, riders: source === 'manual' ? manual.riders : undefined,
      vehicles: vehicles(), emissions: profile ? emis : null };
  };
  const composeKey = JSON.stringify([step >= 2, areaId, source, datasetKey, f, manual, vehicleId, assign, emis]);
  const timer = useRef<number | null>(null);
  useEffect(() => {                                         // the preview follows the parameters (nothing is stored)
    if (step < 2 || !netReady) return;
    const body = compose();
    if (!body || (source === 'manual' && (!manual.drivers.length || !manual.riders.length)) || (source === 'dataset' && !datasetKey)) { setPreview(null); return; }
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      mob.preview(body).then((p) => { setPreview(p); setPreviewErr(null); }).catch((e) => { setPreview(null); setPreviewErr(errText(e)); });
    }, 400);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [composeKey]);                                                          // eslint-disable-line react-hooks/exhaustive-deps

  // manual placement
  const nextId = (prefix: string, list: Agent[]) => `${prefix}${list.reduce((m, a) => Math.max(m, Number(a.id.slice(1)) || 0), 0) + 1}`;
  const add = (role: Role) => {
    if (!area) return;
    const list = manual[role], id = nextId(role === 'drivers' ? 'D' : 'R', list);
    const [s, w, n, e] = area.bbox; const c: [number, number] = [Number(((s + n) / 2).toFixed(5)), Number(((w + e) / 2).toFixed(5))];
    setManual({ ...manual, [role]: [...list, { id, origin: c, destination: c, earliest: 7 * 3600 + 30 * 60, latest: role === 'drivers' ? 7 * 3600 + 45 * 60 : 7 * 3600 + 50 * 60 }] });
    setPick({ role, id, field: 'origin' });
  };
  const update = (role: Role, id: string, patch: Partial<Agent>) => setManual({ ...manual, [role]: manual[role].map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  const remove = (role: Role, id: string) => { setManual({ ...manual, [role]: manual[role].filter((a) => a.id !== id) }); setRoutes((r) => { const n = { ...r }; delete n[id]; return n; }); };
  const placed = (a: Agent) => a.origin[0] !== a.destination[0] || a.origin[1] !== a.destination[1];
  const route = async (a: Agent) => {
    if (!area?.network_id) return;
    setRoutes((r) => ({ ...r, [a.id]: { text: '…' } }));
    try {
      const r = await geo.route(area.network_id, a.origin, a.destination);
      setRoutes((x) => ({ ...x, [a.id]: { line: { coords: r.coords, color: COLORS.route, weight: 4, label: `${a.id}: ${mins(r.time_s)} · ${km(r.length_m)}` }, text: `${mins(r.time_s)} · ${km(r.length_m)}` } }));
      const la = r.coords.map((c: number[]) => c[0]), lo = r.coords.map((c: number[]) => c[1]);
      setFocus({ key: `r${a.id}${Date.now()}`, bbox: [Math.min(...la), Math.min(...lo), Math.max(...la), Math.max(...lo)] });
    } catch (e) { setRoutes((x) => ({ ...x, [a.id]: { text: errText(e), error: true } })); }
  };
  const onMap = async (lat: number, lon: number) => {
    if (step === 1 && mapMode === 'point') {                 // a draft box: nothing is saved until "Create area"
      setMapMode('none');
      setDraft({ name: `Area ${lat.toFixed(3)}, ${lon.toFixed(3)}`, bbox: around(lat, lon, boxKm / 2), profile: draft?.profile ?? 'car' });
      return;
    }
    if (step === 1 && mapMode === 'draw') {
      if (!corner) { setCorner([lat, lon]); return; }
      const b: BBox = [Math.min(corner[0], lat), Math.min(corner[1], lon), Math.max(corner[0], lat), Math.max(corner[1], lon)].map((x) => Number(x.toFixed(5))) as BBox;
      setCorner(null); setMapMode('none');
      setDraft({ name: draft?.name ?? `Area ${lat.toFixed(3)}, ${lon.toFixed(3)}`, bbox: b, profile: draft?.profile ?? 'car' });
      return;
    }
    if (!pick) return;
    update(pick.role, pick.id, { [pick.field]: [lat, lon] } as Partial<Agent>);
    setRoutes((r) => { const n = { ...r }; delete n[pick.id]; return n; });
    setPick(pick.field === 'origin' ? { ...pick, field: 'destination' } : null);
  };

  // areas: search, pick on map, road network download
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };
  const auto = !!cfg.geocoding?.autocomplete, minChars = cfg.geocoding?.min_chars ?? 2;
  const sTimer = useRef<number | null>(null);
  const search = (text = q) => act(async () => { try { const r = await geo.geocode(text); setResults(r.results); if (!r.results.length && !auto) setErr(`no place found for “${text}”`); } catch (e) { if (!auto) throw e; setResults(null); } });
  const download = async (id: string) => { const r = await geo.areaNetwork(id); if (r.cached) reloadAreas(); else setJob(r.job); };
  const choose = (r: Json) => {                                 // a search result becomes a draft box to adjust
    let b = r.bbox as BBox;
    const prof = cfg.profiles.find((p) => p.id === (draft?.profile ?? 'car')) ?? cfg.profiles[0];
    if ((b[2] - b[0]) * (b[3] - b[1]) > prof.max_bbox_deg2) b = around(r.lat, r.lon, 4);
    setResults(null); setDraft({ name: String(r.name).split(',')[0].slice(0, 80), bbox: b, profile: prof.id, origin: { search: q, name: r.name, kind: r.kind } });
    setFocus({ key: `d${Date.now()}`, bbox: b });
  };
  const draftProfile = cfg.profiles.find((p) => p.id === draft?.profile) ?? cfg.profiles[0];
  const draftKm = draft ? [(draft.bbox[2] - draft.bbox[0]) * 111.2, (draft.bbox[3] - draft.bbox[1]) * 111.2 * Math.cos(((draft.bbox[0] + draft.bbox[2]) / 2) * Math.PI / 180)] : null;
  const draftTooBig = !!draft && !!draftProfile && (draft.bbox[2] - draft.bbox[0]) * (draft.bbox[3] - draft.bbox[1]) > draftProfile.max_bbox_deg2;
  const createDraft = () => draft && act(async () => {
    const a = await geo.createArea({ name: draft.name.trim() || 'New area', bbox: draft.bbox, profile: draft.profile, origin: draft.origin });
    setDraft(null); setQ(''); reloadAreas(); setAreaId(a.area_id);
    await download(a.area_id);
  });

  // map layers
  const layers = useMemo(() => {
    const points: MapPoint[] = [], lines: MapLine[] = [];
    const sc = source === 'manual' ? manual : preview?.scenario;
    for (const d of sc?.drivers ?? []) { points.push({ lat: d.origin[0], lon: d.origin[1], color: COLORS.driver, label: `${d.id} start · ${hhmm(d.earliest)}–${hhmm(d.latest)}` }); if (placed(d)) points.push({ lat: d.destination[0], lon: d.destination[1], color: COLORS.driver, fill: false, label: `${d.id} end` }); }
    for (const r of sc?.riders ?? []) { points.push({ lat: r.origin[0], lon: r.origin[1], color: COLORS.rider, label: `${r.id} start · ${hhmm(r.earliest)}–${hhmm(r.latest)}` }); if (placed(r)) points.push({ lat: r.destination[0], lon: r.destination[1], color: COLORS.rider, fill: false, label: `${r.id} end` }); }
    for (const r of Object.values(routes)) if (r.line) lines.push(r.line);
    return { points, lines };
  }, [source, manual, preview, routes]);

  // saving
  const scenarioToSave = (): Json | null => {
    const body = compose();
    if (!body) return null;
    const base = source === 'manual' ? { drivers: manual.drivers, riders: manual.riders } : preview?.scenario;
    if (!base) return null;
    return { name: body.name, network_id: body.network_id, params: body.params, drivers: base.drivers, riders: base.riders, ...(body.vehicles ? { vehicles: body.vehicles } : {}), ...(body.emissions ? { emissions: body.emissions } : {}) };
  };
  const save = () => act(async () => { const sc = scenarioToSave(); if (!sc) return; onSaved(await mob.saveScenario(sc, source === 'manual' ? null : compose(), initial?.parent)); });
  const run = () => act(async () => {
    const sc = scenarioToSave(); if (!sc) return;
    onRun(await mob.run({ title: title.trim(), methods: checked.map((k) => k.split('@')), repetitions: reps, emissions: profile ? emis : undefined, scenario: sc, basis: source === 'manual' ? undefined : compose(), parent: initial?.parent }));
  });

  const ready = [netReady && (source !== 'dataset' || !!datasetKey),
    source === 'manual' ? manual.drivers.length > 0 && manual.riders.length > 0 && [...manual.drivers, ...manual.riders].every(placed) : !!preview,
    !Number.isNaN(toSec(f.start)) && !Number.isNaN(toSec(f.end)) && toSec(f.start) < toSec(f.end) && !!preview,
    checked.length > 0 && title.trim().length >= 3, true][step - 1];
  const summary = preview?.summary;
  const drivers = source === 'manual' ? manual.drivers : preview?.scenario.drivers ?? [];
  const row = (role: Role, a: Agent) => { const r = routes[a.id]; return <tr key={a.id} className={pick?.id === a.id ? 'hl' : ''}>
    <td className="mono">{a.id}</td>
    <td><button type="button" className={`btn sm ${pick?.id === a.id && pick.field === 'origin' ? 'primary' : ''}`} onClick={() => setPick({ role, id: a.id, field: 'origin' })}>Start point</button>{' '}
      <button type="button" className={`btn sm ${pick?.id === a.id && pick.field === 'destination' ? 'primary' : ''}`} onClick={() => setPick({ role, id: a.id, field: 'destination' })}>End point</button></td>
    <td><input aria-label={`${a.id} earliest`} className="time" defaultValue={hhmm(a.earliest)} onBlur={(e) => { const v = toSec(e.target.value); if (!Number.isNaN(v)) update(role, a.id, { earliest: v }); }} /></td>
    <td><input aria-label={`${a.id} latest`} className="time" defaultValue={hhmm(a.latest)} onBlur={(e) => { const v = toSec(e.target.value); if (!Number.isNaN(v)) update(role, a.id, { latest: v }); }} /></td>
    <td><button type="button" className="btn sm" disabled={!placed(a)} title={placed(a) ? '' : 'place the start and end points first'} onClick={() => route(a)}>Route</button>
      {r && <span className={`small ${r.error ? 'bad' : 'muted'}`}> {r.text}</span>}</td>
    <td><button type="button" className="btn icon" aria-label={`remove ${a.id}`} onClick={() => remove(role, a.id)}><Trash2 size={12} /></button></td></tr>; };

  return <div className="wizard" role="dialog" aria-label="generate scenario" data-tour="wizard">
    <div className="row gap wizard-top"><div className="wiz-title"><h2>Generate</h2><span className="muted small">New scenario and experiment</span></div>
      <ol className="steps" aria-label="steps">{STEPS.map((s, i) => <li key={s} className={i + 1 === step ? 'current' : i + 1 < step ? 'done' : ''}><span className="dotnum">{i + 1 < step ? <Check size={13} /> : i + 1}</span>{s}</li>)}</ol>
      <button className="btn icon ghost" aria-label="close" onClick={onClose}><X size={16} /></button></div>
    <div className="wizard-side">
      <div className="wizard-body form">
        {step === 1 && <>
          <label>Area <select aria-label="area" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            {!areas.length && <option value="">—</option>}{areas.map((a) => <option key={a.area_id} value={a.area_id}>{a.name}{a.network_id ? '' : ' (no road network)'}</option>)}</select></label>
          {area && !area.network_id && <div className="row gap"><button className="btn sm" disabled={busy || (!cfg.can_fetch && !area.cached_network) || (!!job && job.state === 'running')} onClick={() => act(() => download(area.area_id))}><Download size={12} /> {area.cached_network ? 'Use stored road network' : 'Download road network'}</button></div>}
          {job && <JobProgress job={job} setErr={setErr} onFinished={(j) => { setJob(j); reloadAreas(); }} />}
          <fieldset><legend>New area</legend>
            <form className="row gap" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= minChars) search(); }}>
              <input value={q} onChange={(e) => { setQ(e.target.value); if (auto) { if (sTimer.current) window.clearTimeout(sTimer.current); if (e.target.value.trim().length >= minChars) sTimer.current = window.setTimeout(() => search(e.target.value), 450); } }}
                placeholder={cfg.geocoder ? 'Find a city or region' : 'Place search is off'} aria-label="place search" disabled={!cfg.geocoder} className="grow" />
              <button className="btn sm" disabled={!cfg.geocoder || busy || q.trim().length < minChars}><Search size={12} /> Search</button></form>
            <div className="row gap"><button type="button" className={`btn sm ${mapMode === 'point' ? 'primary' : ''}`} onClick={() => { setCorner(null); setMapMode(mapMode === 'point' ? 'none' : 'point'); }}>Pick on map</button>
              {mapMode === 'point' && <select aria-label="box size" value={boxKm} onChange={(e) => setBoxKm(Number(e.target.value))} className="small">{[3, 5, 8, 12].map((k) => <option key={k} value={k}>{k} km</option>)}</select>}
              <button type="button" className={`btn sm ${mapMode === 'draw' ? 'primary' : ''}`} onClick={() => { setCorner(null); setMapMode(mapMode === 'draw' ? 'none' : 'draw'); }}><Square size={12} /> Draw a box</button></div>
            {results && results.length > 0 && <ul className="results" aria-label="search results">{results.map((r, i) => <li key={i} tabIndex={0} onClick={() => choose(r)} onKeyDown={(e) => e.key === 'Enter' && choose(r)}>{r.name}<span className="muted small"> · {r.kind}</span></li>)}</ul>}
            {mapMode === 'point' && <p className="small muted">Click the map: a {boxKm} × {boxKm} km box is centred on the point.</p>}
            {mapMode === 'draw' && <p className="small muted">{corner ? 'Click the opposite corner.' : 'Click a first corner on the map.'}</p>}
            {draft && <div className="draft">
              <label>Name <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="area name" /></label>
              <label>Road-network profile <select aria-label="road network profile" value={draft.profile} onChange={(e) => setDraft({ ...draft, profile: e.target.value })}>{cfg.profiles.map((p) => <option key={p.id} value={p.id}>{p.label ?? p.id}</option>)}</select></label>
              <p className={`small ${draftTooBig ? 'bad-text' : 'muted'}`}>{draftKm ? `${num(draftKm[1], 1)} × ${num(draftKm[0], 1)} km` : ''}{draftTooBig ? ' · too large for this profile — drag a corner to shrink it' : ' · drag the corners to resize, the centre to move'}</p>
              <div className="row gap"><button type="button" className="btn primary sm" disabled={busy || draftTooBig || !cfg.can_fetch} onClick={createDraft}><Download size={12} /> Create area and prepare road network</button>
                <button type="button" className="btn sm" onClick={() => setDraft(null)}>Discard</button></div>
              {!cfg.can_fetch && <p className="small muted">Downloading road networks is not allowed on this installation.</p>}</div>}
          </fieldset>
          <fieldset><legend>Mobility data</legend>
            <label className="row top"><input type="radio" name="src" checked={source === 'dataset'} disabled={!shownDatasets.length} onChange={() => setSource('dataset')} />
              <span><b>Sampled from observed trips</b>{!shownDatasets.length ? <span className="muted"> (none for this area)</span> : null}<span className="small muted block">Participants are drawn from the start points, end points and departure times of observed trips (RPC open data or your file) — the observed trips are not replayed one-to-one.</span></span></label>
            {source === 'dataset' && <select aria-label="dataset" value={datasetKey} onChange={(e) => setDatasetKey(e.target.value)}>{shownDatasets.map((d) => <option key={d.dataset_key} value={d.dataset_key}>{dsLabel(d)}</option>)}</select>}
            <label className="row top"><input type="radio" name="src" checked={source === 'synthetic'} onChange={() => setSource('synthetic')} /><span><b>Synthetic demand</b><span className="small muted block">Random trips on the road network, seeded</span></span></label>
            <label className="row top"><input type="radio" name="src" checked={source === 'manual'} onChange={() => setSource('manual')} /><span><b>Place participants on the map</b><span className="small muted block">Set each start point and end point yourself</span></span></label>
            <a className="small" href="#/data/datasets" target="_blank" rel="noopener">Upload a CSV or GeoJSON file…</a>
          </fieldset>
        </>}
        {step === 2 && <>
          <label>Scenario name <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="scenario name" /></label>
          {source !== 'manual' && <div className="row gap">
            <label>Drivers <input type="number" min={1} max={100} value={f.n_drivers} onChange={(e) => setF({ ...f, n_drivers: Number(e.target.value) })} aria-label="drivers" /></label>
            <label>Riders <input type="number" min={1} max={100} value={f.n_riders} onChange={(e) => setF({ ...f, n_riders: Number(e.target.value) })} aria-label="riders" /></label>
            <label>Seed <input type="number" min={0} value={f.seed} onChange={(e) => setF({ ...f, seed: Number(e.target.value) })} aria-label="seed" /></label>
            {source === 'dataset' && <label>Date <input value={f.date} placeholder="YYYY-MM-DD" onChange={(e) => setF({ ...f, date: e.target.value })} aria-label="date" /></label>}
          </div>}
          {source === 'manual' && <>
            <p className="small muted">{pick ? `Click the map to place the ${pick.field === 'origin' ? 'start point' : 'end point'} of ${pick.id}.` : 'Select Start point or End point, then click the map.'}</p>
            {(['drivers', 'riders'] as const).map((role) => <fieldset key={role}><legend>{role === 'drivers' ? 'Drivers' : 'Riders'} ({manual[role].length})</legend>
              {manual[role].length > 0 && <div className="table-scroll"><table className="compact" aria-label={role}><thead><tr><th>Id</th><th>Place</th><th>Earliest</th><th>Latest</th><th>Route</th><th /></tr></thead><tbody>{manual[role].map((a) => row(role, a))}</tbody></table></div>}
              <button type="button" className="btn sm" onClick={() => add(role)}><Plus size={12} /> Add {role === 'drivers' ? 'driver' : 'rider'}</button></fieldset>)}
          </>}
          <fieldset><legend>Vehicle</legend>
            <div className="row gap"><select aria-label="vehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className="grow"><option value="">None (no emission data)</option>
              {allProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <button type="button" className="btn sm" disabled={!veh} onClick={() => setEditor(true)}>Manage</button></div>
            {profile && drivers.length > 0 && <details className="small"><summary>Advanced</summary>
              <div className="table-scroll"><table className="compact" aria-label="vehicle per driver"><tbody>{drivers.map((d) => <tr key={d.id}><td className="mono">{d.id}</td>
                <td><select aria-label={`vehicle of ${d.id}`} value={assign[d.id] ?? profile.id} onChange={(e) => setAssign({ ...assign, [d.id]: e.target.value })}>{allProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td></tr>)}</tbody></table></div></details>}
          </fieldset>
          <PreviewLine preview={preview} err={previewErr} manual={source === 'manual'} />
        </>}
        {step === 3 && <>
          <div className="row gap"><label>From <input className="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} aria-label="from" /></label>
            <label>To <input className="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} aria-label="to" /></label></div>
          <div className="row gap"><label>Max detour (min) <input type="number" min={0} max={120} value={f.detour} onChange={(e) => setF({ ...f, detour: Number(e.target.value) })} aria-label="max detour minutes" /></label>
            <label>Max detour ratio <input type="number" min={0} max={5} step={0.1} value={f.ratio} onChange={(e) => setF({ ...f, ratio: Number(e.target.value) })} aria-label="max detour ratio" /></label></div>
          <p className="small muted">Capacity: one rider per driver (problem definition).</p>
          {source === 'synthetic' && <details className="small"><summary>Advanced</summary>
            <label>Minimum trip length (km) <input type="number" min={0.2} max={50} step={0.1} value={f.min_trip_km} onChange={(e) => setF({ ...f, min_trip_km: Number(e.target.value) })} aria-label="minimum trip length" /></label></details>}
          <PreviewLine preview={preview} err={previewErr} manual={source === 'manual'} />
        </>}
        {step === 4 && <>
          <label>Experiment name <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="experiment name" /></label>
          <fieldset><legend className="row gap">Method{onAddMethod && <button type="button" className="btn sm" onClick={onAddMethod}><Plus size={12} /> Add method</button>}</legend><ul className="methods">{methods.map((m) => { const k = methodKey(m); return <li key={k}><label className="row"><input type="checkbox" checked={checked.includes(k)} onChange={() => setChecked(checked.includes(k) ? checked.filter((x) => x !== k) : [...checked, k])} /> <span className="grow">{m.name}<span className="muted small"> · {m.kind}{m.source === 'plugin' ? ' · your method' : ''}</span></span></label></li>; })}</ul></fieldset>
          <div className="row gap"><label>Repetitions <input type="number" min={1} max={20} value={reps} onChange={(e) => setReps(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} aria-label="repetitions" style={{ width: '5em' }} /></label>
            <span className="small muted" style={{ alignSelf: 'flex-end', paddingBottom: 9 }}>Seed {source === 'manual' ? '— (participants placed by hand)' : `${f.seed} (set in step 2)`} · each repetition runs every method on the same scenarios</span></div>
          {profile && veh && <fieldset><legend>CO₂ calculation</legend>
            <label>Method <select aria-label="emission scope" value={emis.scope} onChange={(e) => setEmis({ ...emis, scope: e.target.value })}>{veh.scopes.map((s) => <option key={s.id} value={s.id}>{SCOPE_LABEL[s.id] ?? s.id}</option>)}</select></label>
            <label>Baseline <select aria-label="emission baseline" value={emis.baseline} onChange={(e) => setEmis({ ...emis, baseline: e.target.value })}>{veh.baselines.map((b) => <option key={b.id} value={b.id}>{BASELINE_LABEL[b.id] ?? b.id}</option>)}</select></label>
            <p className="small muted">{veh.scopes.find((s) => s.id === emis.scope)?.definition}. Baseline: {veh.baselines.find((b) => b.id === emis.baseline)?.definition}.</p></fieldset>}
        </>}
        {step === 5 && <dl className="facts review" aria-label="review">
          <dt>Area</dt><dd>{area?.name}</dd>
          <dt>Road network</dt><dd>OpenStreetMap · {cfg.profiles.find((p) => p.id === area?.profile)?.label ?? area?.profile ?? 'car'} profile</dd>
          <dt>Mobility data</dt><dd>{source === 'synthetic' ? 'synthetic demand (seeded)' : source === 'manual' ? 'placed on the map' : `${dsLabel(shownDatasets.find((d) => d.dataset_key === datasetKey))} — participants sampled from the observed trips, not replayed one-to-one`}</dd>
          <dt>Scenario</dt><dd>{f.name}</dd>
          <dt>Drivers</dt><dd className="iconed"><CarIcon size={14} />{drivers.length}</dd>
          <dt>Riders</dt><dd className="iconed"><RiderIcon size={14} />{(source === 'manual' ? manual.riders : preview?.scenario.riders ?? []).length}{summary ? ` · ${summary.pairs} compatible pairs` : ''}</dd>
          <dt>Vehicles</dt><dd className="iconed">{profile && <VehicleIcon powertrain={profile.powertrain} size={14} />}{profile ? fleet(drivers, profile, assign, allProfiles) : 'none'}</dd>
          <dt>Time horizon</dt><dd>{f.start}–{f.end}</dd>
          <dt>Constraints</dt><dd>detour ≤ {f.detour} min and ≤ {Math.round(f.ratio * 100)} % of the direct trip · one rider per driver</dd>
          <dt>Repetitions and seed</dt><dd>{reps} repetition{reps === 1 ? '' : 's'} · seed {source === 'manual' ? '—' : f.seed}</dd>
          <dt>Methods</dt><dd>{checked.map((k) => methods.find((m) => methodKey(m) === k)?.name ?? k).join(', ')} · {reps} repetition{reps === 1 ? '' : 's'}</dd>
          <dt>CO₂ calculation</dt><dd>{profile ? `${SCOPE_LABEL[emis.scope]} · baseline: ${BASELINE_LABEL[emis.baseline]}` : 'not computed (no vehicle)'}</dd>
          <dt>Provenance</dt><dd>{source === 'synthetic' ? `seeded generator on ${area?.name} road network` : source === 'dataset' ? `seeded sampling (seed ${f.seed}) of ${dsLabel(shownDatasets.find((d) => d.dataset_key === datasetKey))}` : initial?.parent ? 'edited from a library scenario' : 'map editor'}</dd>
        </dl>}
      </div>
      <div className="row gap wizard-foot">
        {step > 1 ? <button className="btn" onClick={() => setStep(step - 1)}><ChevronLeft size={14} /> Back</button> : <button className="btn" onClick={onClose}>Cancel</button>}
        <span className="grow" /><span className="small muted">Step {step} of 5</span>
        {step < 5 && <button className="btn primary" disabled={!ready} onClick={() => setStep(step + 1)}>Next <ChevronRight size={14} /></button>}
        {step === 5 && <><button className="btn" disabled={busy} onClick={save}><Save size={14} /> Save Scenario</button>
          <button className="btn primary" disabled={busy} onClick={run}><Play size={14} /> Save &amp; Run</button></>}
      </div>
    </div>
    <div className="wizard-map">
      <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={layers.points} lines={layers.lines} rects={area && !draft ? [{ bbox: area.bbox, color: COLORS.area }] : []}
        box={draft ? { bbox: draft.bbox, color: COLORS.area, onChange: (b) => setDraft({ ...draft, bbox: b }) } : null}
        fitKey={`${areaId}|${source}|${source === 'manual' ? 'm' : preview?.summary.instance_hash ?? ''}`} focus={focus} onClick={pick || mapMode !== 'none' ? onMap : undefined} cursor={pick || mapMode !== 'none' ? 'crosshair' : undefined} height="100%" />
    </div>
    {editor && veh && <VehicleEditor info={veh} onChange={loadVehicles} onClose={() => setEditor(false)} setErr={setErr} />}
  </div>;
}

function PreviewLine({ preview, err, manual }: { preview: Preview | null; err: string | null; manual: boolean }) {
  if (err) return <p className="note warn small" role="alert">{err}</p>;
  if (!preview) return <p className="small muted">{manual ? 'Add drivers and riders to preview the scenario.' : 'Preview…'}</p>;
  const s = preview.summary;
  return <p className="small muted" aria-label="preview summary">{s.drivers} drivers · {s.riders} riders · {s.pairs} compatible pairs · {s.riders_with_option} riders with an option · snapped ≤ {num(s.max_snap_m, 0)} m</p>;
}

function fleet(drivers: Agent[], profile: VehicleProfile, assign: Record<string, string>, all: VehicleProfile[]) {
  const count: Record<string, number> = {};
  for (const d of drivers) { const id = assign[d.id] ?? profile.id; count[id] = (count[id] ?? 0) + 1; }
  return Object.entries(count).map(([id, n]) => `${all.find((p) => p.id === id)?.name ?? id} ×${n}`).join(' · ');
}
