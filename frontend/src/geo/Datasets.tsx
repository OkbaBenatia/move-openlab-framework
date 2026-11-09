import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, FileUp, Trash2, Eye, EyeOff } from 'lucide-react';
import type { HideProps } from './GeoWorkbench';
import type { Json } from '../api/client';
import { errText, num } from '../components/common';
import { JobProgress } from '../components/JobProgress';
import { COLORS, LeafletMap, type MapLine, type MapPoint } from './LeafletMap';
import { geo, type Area, type GeoConfig } from './api';

const FIELDS: [string, string][] = [['origin_lat', 'Origin latitude'], ['origin_lon', 'Origin longitude'], ['destination_lat', 'Destination latitude'],
  ['destination_lon', 'Destination longitude'], ['departure', 'Departure time'], ['date', 'Date (optional)'], ['role', 'Role (optional)']];
const GEO_FIELDS: [string, string][] = [['departure', 'Departure time'], ['date', 'Date (optional)'], ['role', 'Role (optional)']];

/** Trip datasets: shared RPC open-data subsets (France) and the researcher's own CSV / GeoJSON uploads. */
export function Datasets({ cfg, areas, current, setErr, onChanged, hiddenIds, showHidden, onToggleHidden }: { cfg: GeoConfig; areas: Area[]; current: Area | null; setErr: (s: string | null) => void; onChanged: () => void } & HideProps) {
  const [list, setList] = useState<Json | null>(null);
  const [sel, setSel] = useState<Json | null>(null);
  const load = useCallback(() => { geo.datasets().then(setList).catch((e) => setErr(errText(e))); }, [setErr]);
  useEffect(load, [load]);
  const open = (key: string) => geo.dataset(key).then(setSel).catch((e) => setErr(errText(e)));
  const remove = async (key: string) => { setErr(null); try { await geo.deleteDataset(key); if (sel?.report.dataset_key === key) setSel(null); load(); onChanged(); } catch (e) { setErr(errText(e)); } };
  const changed = () => { load(); onChanged(); };
  const layers = useMemo(() => {
    const points: MapPoint[] = [], lines: MapLine[] = [];
    for (const t of (sel?.sample ?? []) as Json[]) {
      const c = t.role === 'driver' ? COLORS.driver : t.role === 'rider' ? COLORS.rider : COLORS.route;
      points.push({ lat: t.start_lat, lon: t.start_lon, color: c, radius: 3 });
      lines.push({ coords: [[t.start_lat, t.start_lon], [t.end_lat, t.end_lon]], color: c, weight: 1, opacity: 0.35 });
    }
    return { points, lines };
  }, [sel]);
  const ext = sel?.coverage?.extent as [number, number, number, number] | undefined;
  return <div className="split">
    <div>
      <h3>Datasets</h3>
      {!list ? <p className="muted">Loading…</p> : list.shared.length + list.mine.length === 0 ? <p className="muted">No dataset yet.</p> :
        <div className="table-scroll"><table aria-label="datasets"><thead><tr><th>Dataset</th><th>Source</th><th>Trips</th><th /></tr></thead>
          <tbody>{[...list.mine, ...list.shared].filter((d: Json) => showHidden || !hiddenIds.includes(d.dataset_key)).map((d: Json) => <tr key={d.dataset_key} className={sel?.report?.dataset_key === d.dataset_key ? 'hl' : hiddenIds.includes(d.dataset_key) ? 'dim' : ''}>
            <td><b>{d.provider === 'rpc' ? `RPC ${d.release} · ${areas.find((a) => a.bbox.join() === d.area.bbox.map((x: number) => Number(x.toFixed(5))).join())?.name ?? d.name.split(' · ')[1]}` : d.name}</b>
              {d.provider === 'rpc' && <div className="small muted">{d.licence}</div>}</td>
            <td className="small">{d.provider === 'rpc' ? 'RPC open data · shared' : `${d.provider.toUpperCase()} upload · private`}</td><td>{d.rows_kept}</td>
            <td><div className="row gap"><button className="btn sm" onClick={() => open(d.dataset_key)}>Open</button>
              <button className="btn icon" aria-label={hiddenIds.includes(d.dataset_key) ? `show ${d.name}` : `hide ${d.name}`} title={hiddenIds.includes(d.dataset_key) ? 'Show in lists' : 'Hide from lists (nothing is deleted)'} onClick={() => onToggleHidden(d.dataset_key)}>{hiddenIds.includes(d.dataset_key) ? <Eye size={12} /> : <EyeOff size={12} />}</button>
              {d.provider !== 'rpc' && <button className="btn icon" aria-label={`delete ${d.name}`} onClick={() => remove(d.dataset_key)}><Trash2 size={12} /></button>}</div></td></tr>)}</tbody></table></div>}
      {sel && <DatasetSummary sel={sel} />}
      <Rpc areas={areas} current={current} cfg={cfg} setErr={setErr} onDone={changed} />
      <Upload areas={areas} current={current} setErr={setErr} onSaved={(key) => { changed(); open(key); }} maxBytes={list?.max_upload_bytes ?? 0} />
    </div>
    <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={layers.points} lines={layers.lines}
      rects={current ? [{ bbox: current.bbox, color: COLORS.area }] : []} fitKey={sel?.report?.dataset_key ?? `area-${current?.area_id}`} focus={ext ? { key: `d${sel?.report?.dataset_key}`, bbox: ext } : null} />
  </div>;
}

function DatasetSummary({ sel }: { sel: Json }) {
  const r = sel.report, c = sel.coverage;
  return <table className="kv"><tbody>
    <tr><th>Trips</th><td>{c.trips}{c.roles && ` · ${c.roles.driver} drivers, ${c.roles.rider} riders`}</td></tr>
    <tr><th>Dates</th><td>{c.dates ? `${c.dates[0]} → ${c.dates[1]} (${c.distinct_dates} days)` : 'time of day only'}</td></tr>
    <tr><th>Departures by hour</th><td><Hours h={c.departures_by_hour} /></td></tr>
    <tr><th>Provenance</th><td className="small">{r.provider === 'rpc' || r.release ? `${r.attribution} · sha256 ${r.source.sha256.slice(0, 16)}` : `${r.source.filename} · ${num(r.source.bytes / 1024, 0)} KB · sha256 ${r.source.sha256.slice(0, 16)} · ${r.licence}`}</td></tr>
    <tr><th>Validation</th><td className="small">{r.rows_kept ?? r.rows_valid} kept of {r.rows_read} read{Object.keys(r.rejected ?? {}).length ? ` · rejected: ${Object.entries(r.rejected as Record<string, number>).map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`).join(' · ')}` : ''}</td></tr>
  </tbody></table>;
}

function Hours({ h }: { h: number[] }) {
  const top = Math.max(1, ...h);
  return <div className="hours" title="departures per hour, 00–23 h">{h.map((v, i) => <span key={i} style={{ height: `${(100 * v) / top}%` }} title={`${i} h: ${v}`} />)}</div>;
}

function Rpc({ areas, current, cfg, setErr, onDone }: { areas: Area[]; current: Area | null; cfg: GeoConfig; setErr: (s: string | null) => void; onDone: () => void }) {
  const [releases, setReleases] = useState<Json[] | null>(null);
  const [rel, setRel] = useState('');
  const [areaId, setAreaId] = useState('');
  const [job, setJob] = useState<Json | null>(null);
  const [msg, setMsg] = useState('');
  const area = areas.find((a) => a.area_id === areaId) ?? current;
  const load = () => geo.releases().then((r) => { setReleases(r.releases); setRel(r.releases[0]?.release ?? ''); }).catch((e) => { setReleases([]); setErr(errText(e)); });
  const run = async () => {
    if (!area) return;
    setErr(null); setMsg('');
    try { const r = await geo.ingest(rel, area.area_id); if (r.cached) { setMsg(`Already stored: ${r.dataset.rows_kept} trips.`); onDone(); } else setJob(r.job); } catch (e) { setErr(errText(e)); }
  };
  const info = releases?.find((r) => r.release === rel);
  return <details>
    <summary>RPC open carpooling data (France)</summary>
    <p className="small muted">Registre de Preuve de Covoiturage, data.gouv.fr, Licence Ouverte (Etalab). France only. The monthly file is streamed once; only trips starting and ending in the area are kept, without identifiers.</p>
    {releases === null ? <button className="btn sm" onClick={load}>List releases</button> : <div className="form">
      <div className="row gap"><label>Release <select value={rel} onChange={(e) => setRel(e.target.value)} aria-label="release">{releases.map((r) => <option key={r.release} value={r.release}>{r.release} · {(r.filesize / 1e6).toFixed(0)} MB</option>)}</select></label>
        <label>Area <select value={area?.area_id ?? ''} onChange={(e) => setAreaId(e.target.value)} aria-label="rpc area">{areas.map((a) => <option key={a.area_id} value={a.area_id}>{a.name}</option>)}</select></label></div>
      {info && <p className="small muted">Updated {String(info.last_modified).slice(0, 10)} · {(info.filesize / 1e6).toFixed(0)} MB to stream{cfg.can_fetch ? '' : ' · administrators only on this installation'}.</p>}
      <button className="btn primary" disabled={!rel || !area || (!!job && job.state === 'running')} onClick={run}><Download size={13} /> Import for this area</button>
      {msg && <p className="note ok">{msg}</p>}
    </div>}
    {job && <JobProgress job={job} setErr={setErr} unit="bytes" onFinished={(j) => { setJob(j); onDone(); }} />}
  </details>;
}

function Upload({ areas, current, setErr, onSaved, maxBytes }: { areas: Area[]; current: Area | null; setErr: (s: string | null) => void; onSaved: (key: string) => void; maxBytes: number }) {
  const [file, setFile] = useState<File | null>(null);
  const [pid, setPid] = useState<'csv' | 'geojson'>('csv');
  const [info, setInfo] = useState<Json | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [opts, setOpts] = useState({ time_format: 'auto', date_format: 'YYYY-MM-DD', delimiter: '', name: '', area_id: '' });
  const [report, setReport] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const areaId = opts.area_id || current?.area_id || '';
  const pick = async (f: File | null, delimiter = '') => {
    setFile(f); setInfo(null); setReport(null); setErr(null);
    if (!f) return;
    const kind = /\.(geo)?json$/i.test(f.name) ? 'geojson' : 'csv';
    setPid(kind);
    if (maxBytes && f.size > maxBytes) { setErr(`file larger than ${Math.round(maxBytes / 2 ** 20)} MB`); return; }
    try {
      const i = await geo.inspect(kind, f, delimiter || undefined);
      setInfo(i); setMapping(i.suggested_mapping ?? {});
      setOpts((o) => ({ ...o, delimiter: i.delimiter ?? '', name: o.name || f.name.replace(/\.[^.]+$/, '').slice(0, 80) }));
    } catch (e) { setErr(errText(e)); }
  };
  const send = async (save: boolean, accept = false) => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const r = await geo.importDataset(pid, file, { mapping: JSON.stringify(mapping), name: opts.name, time_format: opts.time_format, date_format: opts.date_format,
        delimiter: pid === 'csv' ? opts.delimiter : undefined, area_id: areaId || undefined, save, accept_rejections: accept });
      setReport(r.report);
      if (r.saved) { setFile(null); setInfo(null); setReport(null); onSaved(r.report.dataset_key); }
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const fields = pid === 'csv' ? FIELDS : GEO_FIELDS;
  const choices: string[] = info ? (pid === 'csv' ? info.columns : info.properties) : [];
  const rejected = report ? Object.values(report.rejected as Record<string, number>).reduce((a, b) => a + b, 0) : 0;
  return <details open>
    <summary>Upload CSV or GeoJSON</summary>
    <p className="small muted">Private to your workspace. CSV: one trip per row with origin and destination coordinates and a departure time. GeoJSON: a FeatureCollection of LineString (origin → destination) or two-point MultiPoint features, WGS-84 longitude/latitude.</p>
    <label className="btn"><FileUp size={13} /> Choose file<input type="file" accept=".csv,.txt,.tsv,.geojson,.json" hidden aria-label="dataset file" onChange={(e) => pick(e.target.files?.[0] ?? null)} /></label>
    {file && <span className="small"> {file.name} · {num(file.size / 1024, 0)} KB</span>}
    {info && <div className="form">
      <p className="small muted">{pid === 'csv' ? `${info.encoding} · delimiter “${info.delimiter === '\t' ? 'tab' : info.delimiter}” · about ${info.rows_estimate} rows · ${info.columns.length} columns`
        : `${info.features} features · ${Object.entries(info.geometry_types as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(' · ')}`}</p>
      {pid === 'csv' && <label>Delimiter <select value={opts.delimiter} onChange={(e) => { setOpts({ ...opts, delimiter: e.target.value }); pick(file, e.target.value); }} aria-label="delimiter">
        {[',', ';', '\t', '|'].map((d) => <option key={d} value={d}>{d === '\t' ? 'tab' : d}</option>)}</select></label>}
      <div className="mapping" role="group" aria-label="column mapping">{fields.map(([k, label]) => <Fragment key={k}><label className="small" htmlFor={`map-${k}`}>{label}</label>
        <select id={`map-${k}`} value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })}><option value="">—</option>{choices.map((c) => <option key={c} value={c}>{c}</option>)}</select></Fragment>)}</div>
      <div className="row gap"><label>Time format <select value={opts.time_format} onChange={(e) => setOpts({ ...opts, time_format: e.target.value })} aria-label="time format">
        <option value="auto">detect</option><option value="iso">ISO 8601 date-time</option><option value="time">time of day HH:MM</option><option value="epoch">Unix seconds (UTC)</option></select></label>
        {mapping.date && <label>Date format <select value={opts.date_format} onChange={(e) => setOpts({ ...opts, date_format: e.target.value })} aria-label="date format">{['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'].map((d) => <option key={d}>{d}</option>)}</select></label>}
        <label>Check against area <select value={areaId} onChange={(e) => setOpts({ ...opts, area_id: e.target.value })} aria-label="check area"><option value="">—</option>{areas.map((a) => <option key={a.area_id} value={a.area_id}>{a.name}</option>)}</select></label></div>
      {pid === 'csv' && info.preview?.length > 0 && <details><summary className="small">Preview</summary><div className="table-scroll"><table><thead><tr>{info.columns.map((c: string) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{info.preview.map((r: string[], i: number) => <tr key={i}>{r.map((v, j) => <td key={j} className="small">{v}</td>)}</tr>)}</tbody></table></div></details>}
      <button className="btn" disabled={busy} onClick={() => send(false)}><CheckCircle2 size={13} /> Validate</button>
    </div>}
    {report && <div className="form" aria-label="validation report">
      <p><b>{report.rows_valid}</b> valid of {report.rows_read} rows{rejected > 0 && <> · <span className="bad">{rejected} rejected</span></>}
        {report.coverage.inside_area != null && <> · {report.coverage.inside_area} inside “{report.checked_area?.name}”</>}
        {report.coverage.dates && <> · {report.coverage.dates[0]} → {report.coverage.dates[1]}</>} · times read as {report.parsing.time_format}</p>
      {rejected > 0 && <div className="table-scroll"><table aria-label="rejections"><thead><tr><th>Reason</th><th>Rows</th></tr></thead><tbody>
        {Object.entries(report.rejected as Record<string, number>).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
        <p className="small muted">Examples: {(report.examples as Json[]).slice(0, 6).map((e) => `row ${e.row}${e.value != null ? ` (${e.value})` : ''}`).join(', ')}</p></div>}
      {report.problems.map((p: string) => <p key={p} className="note warn">{p}</p>)}
      {report.coverage.trips > 0 && <Hours h={report.coverage.departures_by_hour} />}
      <div className="row gap"><label>Name <input value={opts.name} onChange={(e) => setOpts({ ...opts, name: e.target.value })} aria-label="dataset name" /></label>
        <button className="btn primary" disabled={busy || report.problems.length > 0 || opts.name.trim().length < 2} onClick={() => send(true, rejected > 0)}>
          {rejected > 0 ? `Save ${report.rows_valid} valid trips, drop ${rejected}` : `Save ${report.rows_valid} trips`}</button></div>
    </div>}
  </details>;
}
