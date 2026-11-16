import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Crosshair, Download, Eye, EyeOff, MousePointerClick, Ruler, Save, Search, Square, Trash2 } from 'lucide-react';
import type { Json } from '../api/client';
import { errText, num } from '../components/common';
import { JobProgress } from '../components/JobProgress';
import { tr } from '../i18n';
import { COLORS, LeafletMap, type BBox, type MapLine, type MapPoint } from './LeafletMap';
import { dur, geo, km, type Area, type GeoConfig } from './api';
import type { HideProps } from './GeoWorkbench';

type Mode = 'none' | 'point' | 'draw' | 'measure';
const deg2 = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);
const km2 = (b: BBox) => { const lat = ((b[0] + b[2]) / 2) * Math.PI / 180; return (b[2] - b[0]) * 111.2 * (b[3] - b[1]) * 111.2 * Math.cos(lat); };
const around = (lat: number, lon: number, halfKm = 2.5): BBox => {
  const dl = halfKm / 111.2, dn = halfKm / (111.2 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [lat - dl, lon - dn, lat + dl, lon + dn].map((x) => Number(x.toFixed(5))) as BBox;
};

/** Named areas of the workspace: place search, map selection, box drawing and resizing, road-network profile,
 *  network download (background job) with coverage, distances and travel times. */
export function Areas({ cfg, areas, current, workingId, setCurrent, onUse, setErr, onChanged, hiddenIds, onToggleHidden }: {
  cfg: GeoConfig; areas: Area[]; current: Area | null; workingId: string; setCurrent: (id: string) => void; onUse: (id: string) => void; setErr: (s: string | null) => void; onChanged: () => void;
} & HideProps) {
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

  const auto = !!cfg.geocoding?.autocomplete, minChars = cfg.geocoding?.min_chars ?? 2;
  const timer = useRef<number | null>(null);
  const search = async (text = q) => {
    setErr(null); setSearching(true);
    try { const r = await geo.geocode(text); setResults(r.results); if (!r.results.length && !auto) setErr(tr('no place found for “{text}”', { text })); } catch (e) { if (!auto) setErr(errText(e)); setResults(null); } finally { setSearching(false); }
  };
  const choose = (r: Json) => {
    let b = r.bbox as BBox;
    if (deg2(b) > prof.max_bbox_deg2) b = around(r.lat, r.lon, 4);   // regions and countries: start from the centre
    setDraft({ id: undefined, name: String(r.name).split(',')[0].slice(0, 80), bbox: b, profile: draft.profile, origin: { search: q, name: r.name, kind: r.kind } });
    setFocus({ key: `r${r.lat},${r.lon},${Date.now()}`, bbox: b }); setResults(null);
  };
  const onMap = async (lat: number, lon: number) => {
    if (mode === 'point') { const b = around(lat, lon); setDraft({ ...draft, id: draft.id, bbox: b, name: draft.name || tr('Area {lat}, {lon}', { lat: lat.toFixed(3), lon: lon.toFixed(3) }) }); setMode('none'); }
    else if (mode === 'draw') {
      if (!corner) { setCorner([lat, lon]); return; }
      const b: BBox = [Math.min(corner[0], lat), Math.min(corner[1], lon), Math.max(corner[0], lat), Math.max(corner[1], lon)];
      setDraft({ ...draft, bbox: b, name: draft.name || tr('New area') }); setCorner(null); setMode('none');
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
  const edit = (a: Area) => { setDraft({ id: a.area_id, name: a.name, bbox: a.bbox, profile: a.profile }); setFocus({ key: `e${a.area_id},${Date.now()}`, bbox: a.bbox }); };
  const remove = async (a: Area) => { setErr(null); try { await geo.deleteArea(a.area_id); onChanged(); } catch (e) { setErr(errText(e)); } };
  const download = async () => {
    if (!current) return;
    setErr(null);
    try { const r = await geo.areaNetwork(current.area_id); if (r.cached) onChanged(); else setJob(r.job); } catch (e) { setErr(errText(e)); }
  };

  const points: MapPoint[] = useMemo(() => [
    ...(corner ? [{ lat: corner[0], lon: corner[1], color: COLORS.area, label: tr('first corner') }] : []),
    ...(measure.a ? [{ lat: measure.a[0], lon: measure.a[1], color: COLORS.route, label: 'A' }] : []),
    ...(measure.route ? [{ lat: measure.route.b[0], lon: measure.route.b[1], color: COLORS.route, label: 'B' }] : []),
  ], [corner, measure]);
  const lines: MapLine[] = measure.route ? [{ coords: measure.route.coords, color: COLORS.route, weight: 4, label: `${km(measure.route.length_m)} · ${dur(measure.route.time_s)}` }] : [];
  const others = areas.filter((a) => a.area_id !== draft.id && a.area_id !== current?.area_id).map((a) => ({ bbox: a.bbox, color: '#94a3b8' }));
  const shownBox = draft.bbox ? { bbox: draft.bbox, color: tooBig ? '#c62828' : COLORS.area, onChange: (b: BBox) => setDraft({ ...draft, bbox: b }) }
    : current ? { bbox: current.bbox, color: COLORS.area } : null;
  const hint = mode === 'point' ? tr('Click the map: a 5 × 5 km box is centred on the point.') : mode === 'draw' ? (corner ? tr('Click the opposite corner.') : tr('Click a first corner.'))
    : mode === 'measure' ? (measure.route ? tr('Click another destination from A, or switch the mode off.') : measure.a ? tr('Click the destination.') : tr('Click the origin.')) : draft.bbox ? tr('Drag the corner handles to resize, the centre handle to move.') : '';

  return <div className="split">
    <div>
      <form className="row gap" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= minChars) search(); }}>
        <input value={q} onChange={(e) => { setQ(e.target.value); if (auto) { if (timer.current) window.clearTimeout(timer.current); if (e.target.value.trim().length >= minChars) timer.current = window.setTimeout(() => search(e.target.value), 450); } }}
          placeholder={cfg.geocoder ? tr('City, locality or region') : tr('Place search is off — draw on the map')} aria-label={tr('place search')} disabled={!cfg.geocoder} className="grow" />
        <button className="btn" disabled={!cfg.geocoder || searching || q.trim().length < minChars}><Search size={13} /> {searching ? tr('Searching…') : tr('Search')}</button>
      </form>
      {results && results.length > 0 && <ul className="results" aria-label={tr('search results')}>{results.map((r, i) =>
        <li key={i} tabIndex={0} onClick={() => choose(r)} onKeyDown={(e) => e.key === 'Enter' && choose(r)}>{r.name}<span className="muted small"> · {r.kind} · {num(km2(r.bbox), 0)} km²</span></li>)}</ul>}
      {cfg.geocoder && <p className="small muted">{tr(cfg.geocoding?.attribution ?? 'Search: © OpenStreetMap contributors')}.{auto ? '' : ` ${tr('Press Enter to search; results are cached.')}`}</p>}
      <div className="row gap actions">
        <button className={`btn sm ${mode === 'point' ? 'primary' : ''}`} onClick={() => { setMode(mode === 'point' ? 'none' : 'point'); setCorner(null); }}><MousePointerClick size={12} /> {tr('Pick on map')}</button>
        <button className={`btn sm ${mode === 'draw' ? 'primary' : ''}`} onClick={() => { setMode(mode === 'draw' ? 'none' : 'draw'); setCorner(null); }}><Square size={12} /> {tr('Draw box')}</button>
        {net && <button className={`btn sm ${mode === 'measure' ? 'primary' : ''}`} onClick={() => { setMode(mode === 'measure' ? 'none' : 'measure'); setMeasure({}); }}><Ruler size={12} /> {tr('Measure route')}</button>}
      </div>
      {hint && <p className="small muted">{hint}</p>}
      {measure.route && <p className="note"><b>{km(measure.route.length_m)}</b> · <b>{dur(measure.route.time_s)}</b> {tr('free-flow')} · {tr('snapped {a} m / {b} m', { a: num(measure.route.snap_m[0], 0), b: num(measure.route.snap_m[1], 0) })}</p>}

      {draft.bbox && <div className="form">
        <h3>{draft.id ? tr('Edit “{name}”', { name: editing?.name ?? draft.name }) : tr('New area')}</h3>
        <label>{tr('Name')} <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label={tr('area name')} /></label>
        <label>{tr('Road profile')} <select value={draft.profile} onChange={(e) => setDraft({ ...draft, profile: e.target.value })} aria-label={tr('road profile')}>
          {cfg.profiles.map((p) => <option key={p.id} value={p.id}>{tr(p.label)}</option>)}</select></label>
        <div className="mapping">
          {(['South', 'West', 'North', 'East'] as const).map((k, i) => <Fragment key={k}><label className="small" htmlFor={`bbox-${k}`}>{tr(k)}</label>
            <input id={`bbox-${k}`} type="number" step={0.001} value={draft.bbox![i]} aria-label={tr(`bbox ${k.toLowerCase()}`)} onChange={(e) => { const b = [...draft.bbox!] as BBox; b[i] = Number(e.target.value); setDraft({ ...draft, bbox: b }); }} /></Fragment>)}
        </div>
        <p className={`small ${tooBig ? 'bad' : 'muted'}`}>{num(km2(draft.bbox), 0)} km² · {deg2(draft.bbox).toFixed(3)} / {prof.max_bbox_deg2} deg² {tooBig && tr('— too large for this profile: shrink the box or use main roads')}</p>
        <div className="row gap"><button className="btn primary" disabled={tooBig || draft.name.trim().length < 2} onClick={save}><Save size={13} /> {draft.id ? tr('Save changes') : tr('Save area')}</button>
          <button className="btn" onClick={() => setDraft({ name: '', bbox: null, profile: draft.profile })}>{tr('Cancel')}</button></div>
      </div>}

      <h3>{tr('My areas')}</h3>
      {areas.length === 0 ? <p className="muted">{tr('No area yet: search a place or draw a box.')}</p> :
        <div className="table-scroll"><table aria-label={tr('areas')}><thead><tr><th>{tr('Area')}</th><th>{tr('Profile')}</th><th>km²</th><th>{tr('Network')}</th><th /></tr></thead>
          <tbody>{areas.map((a) => <tr key={a.area_id} className={current?.area_id === a.area_id ? 'hl' : hiddenIds.includes(a.area_id) ? 'dim' : ''}>
            <td><b>{a.name}</b></td><td className="small">{a.profile}</td><td>{num(a.km2, 0)}</td>
            <td className="small">{a.network_id ? <span className="badge ok">{tr('ready')}</span> : a.cached_network ? <span className="badge">{tr('stored')}</span> : <span className="badge warn">{tr('not downloaded')}</span>}</td>
            <td><div className="row gap">{workingId === a.area_id ? <span className="badge ok" title={tr('Your working area: the Workspace and Generate start here')}><CheckCircle2 size={11} /> {tr('In use')}</span>
              : <button className="btn sm" title={tr('Make this your working area (Workspace and Generate)')} onClick={() => onUse(a.area_id)}>{tr('Use')}</button>}<button className="btn sm" onClick={() => edit(a)}>{tr('Edit')}</button>
              <button className="btn icon" aria-label={hiddenIds.includes(a.area_id) ? tr('show {name}', { name: a.name }) : tr('hide {name}', { name: a.name })} title={hiddenIds.includes(a.area_id) ? tr('Show in lists') : tr('Hide from lists (nothing is deleted)')} onClick={() => onToggleHidden(a.area_id)}>{hiddenIds.includes(a.area_id) ? <Eye size={12} /> : <EyeOff size={12} />}</button>
              <button className="btn icon" aria-label={tr('delete {name}', { name: a.name })} title={tr('Delete the area (a downloaded network stays available)')} onClick={() => remove(a)}><Trash2 size={12} /></button></div></td></tr>)}</tbody></table></div>}

      {current && <div className="form">
        <h3><Crosshair size={14} /> {current.name}</h3>
        {current.network_id && cov ? <>
          <div><span className="stat"><b>{cov.nodes.toLocaleString()}</b> {tr('nodes')}</span><span className="stat"><b>{cov.edges.toLocaleString()}</b> {tr('edges')}</span><span className="stat"><b>{num(cov.road_km, 0)}</b> {tr('km of road')}</span></div>
          <p className="small muted">{tr(cov.provenance.profile_label ?? cov.provenance.profile)} · {tr('OSM data {date}', { date: cov.provenance.source.osm_timestamp ?? '—' })} · {tr('retrieved {date}', { date: cov.provenance.source.retrieved_at })} · <span className="mono">{current.network_id}</span></p>
        </> : <>
          <p className="small muted">{current.cached_network ? tr('A network for this box and profile is already stored.') : cfg.can_fetch ? tr('One Overpass request (fair use, one download at a time). Data © OpenStreetMap contributors, ODbL.')
            : tr('One Overpass request (fair use, one download at a time; administrators only on this installation). Data © OpenStreetMap contributors, ODbL.')}</p>
          <button className="btn primary" disabled={(!cfg.can_fetch && !current.cached_network) || (!!job && job.state === 'running')} onClick={download}><Download size={13} /> {current.cached_network ? tr('Use stored network') : tr('Download road network')}</button>
        </>}
        {job && <JobProgress job={job} setErr={setErr} onFinished={(j) => { setJob(j); onChanged(); }} />}
      </div>}
    </div>
    <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} rects={others} box={shownBox} coverage={!draft.bbox && cov ? { cells: cov.cells, step: cov.cell_deg } : null}
      points={points} lines={lines} focus={focus} onClick={mode === 'none' ? undefined : onMap} cursor={mode === 'none' ? undefined : 'crosshair'} height={520} />
  </div>;
}
