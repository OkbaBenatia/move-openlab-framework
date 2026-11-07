import { useEffect, useMemo, useState } from 'react';
import { Crosshair, Download, MousePointerClick, Ruler, Save, Search, Square, Trash2 } from 'lucide-react';
import type { Json } from '../api/client';
import { errText, num } from '../components/common';
import { JobProgress } from '../components/JobProgress';
import { COLORS, LeafletMap, type BBox, type MapLine, type MapPoint } from './LeafletMap';
import { dur, geo, km, type Area, type GeoConfig } from './api';

type Mode = 'none' | 'point' | 'draw' | 'measure';
const deg2 = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);
const km2 = (b: BBox) => { const lat = ((b[0] + b[2]) / 2) * Math.PI / 180; return (b[2] - b[0]) * 111.2 * (b[3] - b[1]) * 111.2 * Math.cos(lat); };
const around = (lat: number, lon: number, halfKm = 2.5): BBox => {
  const dl = halfKm / 111.2, dn = halfKm / (111.2 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [lat - dl, lon - dn, lat + dl, lon + dn].map((x) => Number(x.toFixed(5))) as BBox;
};

/** Named areas of the workspace: place search, map selection, box drawing and resizing, road-network profile,
 *  network download (background job) with coverage, distances and travel times. */
export function Areas({ cfg, areas, current, setCurrent, setErr, onChanged }: {
  cfg: GeoConfig; areas: Area[]; current: Area | null; setCurrent: (id: string) => void; setErr: (s: string | null) => void; onChanged: () => void;
}) {
  const [draft, setDraft] = useState<{ id?: string; name: string; bbox: BBox | null; profile: string; origin?: Json }>({ name: '', bbox: null, profile: 'car' });
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Json[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<Mode>('none');
  const [corner, setCorner] = useState<[number, number] | null>(null);
  const [focus, setFocus] = useState<{ key: string; bbox: BBox } | null>(null);
  const [job, setJob] = useState<Json | null>(null);
  const [cov, setCov] = useState<Json | null>(null);
  const [measure, setMeasure] = useState<{ a?: [number, number]; route?: Json }>({});
  const prof = cfg.profiles.find((p) => p.id === draft.profile) ?? cfg.profiles[0];
  const tooBig = draft.bbox ? deg2(draft.bbox) > prof.max_bbox_deg2 : false;
  const editing = draft.id ? areas.find((a) => a.area_id === draft.id) : undefined;

  const net = current?.network_id ?? null;
  useEffect(() => {
    let alive = true;
    setCov(null); setMeasure({});
    if (net) geo.coverage(net).then((c) => { if (alive) setCov(c); }).catch((e) => { if (alive) setErr(errText(e)); });
    return () => { alive = false; };
  }, [net, setErr]);
  useEffect(() => { if (current && !draft.id && !draft.bbox) setFocus({ key: current.area_id, bbox: current.bbox }); }, [current, draft.id, draft.bbox]);

  const search = async () => {
    setErr(null); setSearching(true);
    try { const r = await geo.geocode(q); setResults(r.results); if (!r.results.length) setErr(`no place found for “${q}”`); } catch (e) { setErr(errText(e)); setResults(null); } finally { setSearching(false); }
  };
  const choose = (r: Json) => {
    let b = r.bbox as BBox;
    if (deg2(b) > prof.max_bbox_deg2) b = around(r.lat, r.lon, 4);   // regions and countries: start from the centre
    setDraft({ id: undefined, name: String(r.name).split(',')[0].slice(0, 80), bbox: b, profile: draft.profile, origin: { search: q, name: r.name, kind: r.kind } });
    setFocus({ key: `r${r.lat},${r.lon}`, bbox: b }); setResults(null);
  };
  const onMap = async (lat: number, lon: number) => {
    if (mode === 'point') { const b = around(lat, lon); setDraft({ ...draft, id: draft.id, bbox: b, name: draft.name || `Area ${lat.toFixed(3)}, ${lon.toFixed(3)}` }); setMode('none'); }
    else if (mode === 'draw') {
      if (!corner) { setCorner([lat, lon]); return; }
      const b: BBox = [Math.min(corner[0], lat), Math.min(corner[1], lon), Math.max(corner[0], lat), Math.max(corner[1], lon)];
      setDraft({ ...draft, bbox: b, name: draft.name || 'New area' }); setCorner(null); setMode('none');
    } else if (mode === 'measure' && net) {
      if (!measure.a) { setMeasure({ a: [lat, lon] }); return; }
      try { const r = await geo.route(net, measure.a, [lat, lon]); setMeasure({ a: measure.a, route: { ...r, b: [lat, lon] } }); } catch (e) { setErr(errText(e)); setMeasure({}); }
    }
  };
  const save = async () => {
    if (!draft.bbox) return;
    setErr(null);
    try {
      const body = { name: draft.name, bbox: draft.bbox, profile: draft.profile, origin: draft.origin };
      const a = draft.id ? await geo.updateArea(draft.id, body) : await geo.createArea(body);
      setDraft({ name: '', bbox: null, profile: draft.profile }); setCurrent(a.area_id); onChanged();
    } catch (e) { setErr(errText(e)); }
  };
  const edit = (a: Area) => { setDraft({ id: a.area_id, name: a.name, bbox: a.bbox, profile: a.profile }); setFocus({ key: `e${a.area_id}${a.updated_at}`, bbox: a.bbox }); };
  const remove = async (a: Area) => { setErr(null); try { await geo.deleteArea(a.area_id); onChanged(); } catch (e) { setErr(errText(e)); } };
  const download = async () => {
    if (!current) return;
    setErr(null);
    try { const r = await geo.areaNetwork(current.area_id); if (r.cached) onChanged(); else setJob(r.job); } catch (e) { setErr(errText(e)); }
  };

  const points: MapPoint[] = useMemo(() => [
    ...(corner ? [{ lat: corner[0], lon: corner[1], color: COLORS.area, label: 'first corner' }] : []),
    ...(measure.a ? [{ lat: measure.a[0], lon: measure.a[1], color: COLORS.route, label: 'A' }] : []),
    ...(measure.route ? [{ lat: measure.route.b[0], lon: measure.route.b[1], color: COLORS.route, label: 'B' }] : []),
  ], [corner, measure]);
  const lines: MapLine[] = measure.route ? [{ coords: measure.route.coords, color: COLORS.route, weight: 4, label: `${km(measure.route.length_m)} · ${dur(measure.route.time_s)}` }] : [];
  const others = areas.filter((a) => a.area_id !== draft.id && a.area_id !== current?.area_id).map((a) => ({ bbox: a.bbox, color: '#94a3b8' }));
  const shownBox = draft.bbox ? { bbox: draft.bbox, color: tooBig ? '#c62828' : COLORS.area, onChange: (b: BBox) => setDraft({ ...draft, bbox: b }) }
    : current ? { bbox: current.bbox, color: COLORS.area } : null;
  const hint = mode === 'point' ? 'Click the map: a 5 × 5 km box is centred on the point.' : mode === 'draw' ? (corner ? 'Click the opposite corner.' : 'Click a first corner.')
    : mode === 'measure' ? (measure.a ? 'Click the destination.' : 'Click the origin.') : draft.bbox ? 'Drag the corner handles to resize, the centre handle to move.' : '';

  return <div className="split">
    <div>
      <form className="row gap" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) search(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={cfg.geocoder ? 'City, locality or region' : 'Place search is off — draw on the map'} aria-label="place search" disabled={!cfg.geocoder} className="grow" />
        <button className="btn" disabled={!cfg.geocoder || searching || q.trim().length < 2}><Search size={13} /> {searching ? 'Searching…' : 'Search'}</button>
      </form>
      {results && results.length > 0 && <ul className="results" aria-label="search results">{results.map((r, i) =>
        <li key={i} tabIndex={0} onClick={() => choose(r)} onKeyDown={(e) => e.key === 'Enter' && choose(r)}>{r.name}<span className="muted small"> · {r.kind} · {num(km2(r.bbox), 0)} km²</span></li>)}</ul>}
      {cfg.geocoder && <p className="small muted">Search by Nominatim, © OpenStreetMap contributors. One search at a time; results are cached.</p>}
      <div className="row gap actions">
        <button className={`btn sm ${mode === 'point' ? 'primary' : ''}`} onClick={() => { setMode(mode === 'point' ? 'none' : 'point'); setCorner(null); }}><MousePointerClick size={12} /> Pick on map</button>
        <button className={`btn sm ${mode === 'draw' ? 'primary' : ''}`} onClick={() => { setMode(mode === 'draw' ? 'none' : 'draw'); setCorner(null); }}><Square size={12} /> Draw box</button>
        {net && <button className={`btn sm ${mode === 'measure' ? 'primary' : ''}`} onClick={() => { setMode(mode === 'measure' ? 'none' : 'measure'); setMeasure({}); }}><Ruler size={12} /> Measure route</button>}
      </div>
      {hint && <p className="small muted">{hint}</p>}
      {measure.route && <p className="note"><b>{km(measure.route.length_m)}</b> · <b>{dur(measure.route.time_s)}</b> free-flow · snapped {num(measure.route.snap_m[0], 0)} m / {num(measure.route.snap_m[1], 0)} m</p>}

      {draft.bbox && <div className="form">
        <h3>{draft.id ? `Edit “${editing?.name ?? draft.name}”` : 'New area'}</h3>
        <label>Name <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="area name" /></label>
        <label>Road profile <select value={draft.profile} onChange={(e) => setDraft({ ...draft, profile: e.target.value })} aria-label="road profile">
          {cfg.profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        <div className="mapping">
          {(['South', 'West', 'North', 'East'] as const).map((k, i) => <label key={k} className="row gap" style={{ display: 'contents' }}><span className="small">{k}</span>
            <input type="number" step={0.001} value={draft.bbox![i]} aria-label={`bbox ${k.toLowerCase()}`} onChange={(e) => { const b = [...draft.bbox!] as BBox; b[i] = Number(e.target.value); setDraft({ ...draft, bbox: b }); }} /></label>)}
        </div>
        <p className={`small ${tooBig ? 'bad' : 'muted'}`}>{num(km2(draft.bbox), 0)} km² · {deg2(draft.bbox).toFixed(3)} / {prof.max_bbox_deg2} deg² {tooBig && '— too large for this profile: shrink the box or use main roads'}</p>
        <div className="row gap"><button className="btn primary" disabled={tooBig || draft.name.trim().length < 2} onClick={save}><Save size={13} /> {draft.id ? 'Save changes' : 'Save area'}</button>
          <button className="btn" onClick={() => setDraft({ name: '', bbox: null, profile: draft.profile })}>Cancel</button></div>
      </div>}

      <h3>My areas</h3>
      {areas.length === 0 ? <p className="muted">No area yet: search a place or draw a box.</p> :
        <div className="table-scroll"><table aria-label="areas"><thead><tr><th>Area</th><th>Profile</th><th>km²</th><th>Network</th><th /></tr></thead>
          <tbody>{areas.map((a) => <tr key={a.area_id} className={current?.area_id === a.area_id ? 'hl' : ''}>
            <td><b>{a.name}</b></td><td className="small">{a.profile}</td><td>{num(a.km2, 0)}</td>
            <td className="small">{a.network_id ? <span className="badge ok">ready</span> : a.cached_network ? <span className="badge">stored</span> : <span className="badge warn">not downloaded</span>}</td>
            <td><div className="row gap"><button className="btn sm" onClick={() => setCurrent(a.area_id)}>Use</button><button className="btn sm" onClick={() => edit(a)}>Edit</button>
              <button className="btn icon" aria-label={`delete ${a.name}`} title="Delete the area (a downloaded network stays available)" onClick={() => remove(a)}><Trash2 size={12} /></button></div></td></tr>)}</tbody></table></div>}

      {current && <div className="form">
        <h3><Crosshair size={14} /> {current.name}</h3>
        {current.network_id && cov ? <>
          <div><span className="stat"><b>{cov.nodes.toLocaleString()}</b> nodes</span><span className="stat"><b>{cov.edges.toLocaleString()}</b> edges</span><span className="stat"><b>{num(cov.road_km, 0)}</b> km of road</span></div>
          <p className="small muted">{cov.provenance.profile_label ?? cov.provenance.profile} · OSM data {cov.provenance.source.osm_timestamp ?? '—'} · retrieved {cov.provenance.source.retrieved_at} · <span className="mono">{current.network_id}</span></p>
        </> : <>
          <p className="small muted">{current.cached_network ? 'A network for this box and profile is already stored.' : `One Overpass request (fair use, one download at a time${cfg.can_fetch ? '' : '; administrators only on this installation'}). Data © OpenStreetMap contributors, ODbL.`}</p>
          <button className="btn primary" disabled={(!cfg.can_fetch && !current.cached_network) || (!!job && job.state === 'running')} onClick={download}><Download size={13} /> {current.cached_network ? 'Use stored network' : 'Download road network'}</button>
        </>}
        {job && <JobProgress job={job} setErr={setErr} onFinished={(j) => { setJob(j); onChanged(); }} />}
      </div>}
    </div>
    <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} rects={others} box={shownBox} coverage={!draft.bbox && cov ? { cells: cov.cells, step: cov.cell_deg } : null}
      points={points} lines={lines} focus={focus} onClick={mode === 'none' ? undefined : onMap} cursor={mode === 'none' ? undefined : 'crosshair'} height={520} />
  </div>;
}
