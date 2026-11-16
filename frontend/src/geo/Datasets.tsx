import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, FileUp, Trash2, Eye, EyeOff } from 'lucide-react';
import type { HideProps } from './GeoWorkbench';
import type { Json } from '../api/client';
import { errText, num } from '../components/common';
import { JobProgress } from '../components/JobProgress';
import { tr } from '../i18n';
import { COLORS, LeafletMap, type MapLine, type MapPoint } from './LeafletMap';
import { geo, type Area, type GeoConfig } from './api';

const FIELDS: [string, string][] = [['origin_lat', 'Origin latitude'], ['origin_lon', 'Origin longitude'], ['destination_lat', 'Destination latitude'],
  ['destination_lon', 'Destination longitude'], ['departure', 'Departure time'], ['date', 'Date (optional)'], ['role', 'Role (optional)']];
const GEO_FIELDS: [string, string][] = [['departure', 'Departure time'], ['date', 'Date (optional)'], ['role', 'Role (optional)']];

/** Trip datasets: shared RPC open-data subsets (France) and the researcher's own CSV / GeoJSON uploads. */
export function Datasets({ cfg, areas, current, setErr, onChanged, onUse, hiddenIds, showHidden, onToggleHidden }: { cfg: GeoConfig; areas: Area[]; current: Area | null; setErr: (s: string | null) => void; onChanged: () => void; onUse: (datasetKey: string) => void } & HideProps) {
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
      <h3>{tr('Datasets')}</h3>
      {!list ? <p className="muted">{tr('Loading…')}</p> : list.shared.length + list.mine.length === 0 ? <p className="muted">{tr('No dataset yet.')}</p> :
        <div className="table-scroll"><table aria-label={tr('datasets')}><thead><tr><th>{tr('Dataset')}</th><th>{tr('Source')}</th><th>{tr('Trips')}</th><th /></tr></thead>
          <tbody>{[...list.mine, ...list.shared].filter((d: Json) => showHidden || !hiddenIds.includes(d.dataset_key)).map((d: Json) => <tr key={d.dataset_key} className={sel?.report?.dataset_key === d.dataset_key ? 'hl' : hiddenIds.includes(d.dataset_key) ? 'dim' : ''}>
            <td><b>{d.provider === 'rpc' ? `RPC ${d.release} · ${areas.find((a) => a.bbox.join() === d.area.bbox.map((x: number) => Number(x.toFixed(5))).join())?.name ?? d.name.split(' · ')[1]}` : d.name}</b>
              {d.provider === 'rpc' && <div className="small muted">{tr(d.licence)}</div>}</td>
            <td className="small">{d.provider === 'rpc' ? tr('RPC open data · shared') : tr('{format} upload · private', { format: d.provider.toUpperCase() })}</td><td>{d.rows_kept}</td>
            <td><div className="row gap"><button className="btn sm" onClick={() => open(d.dataset_key)}>{tr('Open')}</button>
              <button className="btn sm" title={tr('Start Generate with this mobility data in the Workspace')} onClick={() => onUse(d.dataset_key)}>{tr('Use')}</button>
              <button className="btn icon" aria-label={hiddenIds.includes(d.dataset_key) ? tr('show {name}', { name: d.name }) : tr('hide {name}', { name: d.name })} title={hiddenIds.includes(d.dataset_key) ? tr('Show in lists') : tr('Hide from lists (nothing is deleted)')} onClick={() => onToggleHidden(d.dataset_key)}>{hiddenIds.includes(d.dataset_key) ? <Eye size={12} /> : <EyeOff size={12} />}</button>
              {d.provider !== 'rpc' && <button className="btn icon" aria-label={tr('delete {name}', { name: d.name })} onClick={() => remove(d.dataset_key)}><Trash2 size={12} /></button>}</div></td></tr>)}</tbody></table></div>}
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
    <tr><th>{tr('Trips')}</th><td>{c.trips}{c.roles && ` · ${tr('{drivers} drivers, {riders} riders', { drivers: c.roles.driver, riders: c.roles.rider })}`}</td></tr>
    <tr><th>{tr('Dates')}</th><td>{c.dates ? tr('{from} → {to} ({n} days)', { from: c.dates[0], to: c.dates[1], n: c.distinct_dates }) : tr('time of day only')}</td></tr>
    <tr><th>{tr('Departures by hour')}</th><td><Hours h={c.departures_by_hour} /></td></tr>
    <tr><th>{tr('Provenance')}</th><td className="small">{r.provider === 'rpc' || r.release ? `${r.attribution} · sha256 ${r.source.sha256.slice(0, 16)}` : `${r.source.filename} · ${num(r.source.bytes / 1024, 0)} KB · sha256 ${r.source.sha256.slice(0, 16)} · ${tr(r.licence)}`}</td></tr>
    <tr><th>{tr('Validation')}</th><td className="small">{tr('{kept} kept of {read} read', { kept: r.rows_kept ?? r.rows_valid, read: r.rows_read })}{Object.keys(r.rejected ?? {}).length ? ` · ${tr('rejected: {list}', { list: Object.entries(r.rejected as Record<string, number>).map(([k, v]) => `${tr(k.replaceAll('_', ' '))} ${v}`).join(' · ') })}` : ''}</td></tr>
  </tbody></table>;
}

function Hours({ h }: { h: number[] }) {
  const top = Math.max(1, ...h);
  return <div className="hours" title={tr('departures per hour, 00–23 h')}>{h.map((v, i) => <span key={i} style={{ height: `${(100 * v) / top}%` }} title={`${i} h: ${v}`} />)}</div>;
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
    try { const r = await geo.ingest(rel, area.area_id); if (r.cached) { setMsg(tr('Already stored: {n} trips.', { n: r.dataset.rows_kept })); onDone(); } else setJob(r.job); } catch (e) { setErr(errText(e)); }
  };
  const info = releases?.find((r) => r.release === rel);
  return <details>
    <summary>{tr('RPC open carpooling data (France)')}</summary>
    <p className="small muted">{tr('Registre de Preuve de Covoiturage, data.gouv.fr, Licence Ouverte (Etalab). France only. The monthly file is streamed once; only trips starting and ending in the area are kept, without identifiers.')}</p>
    {releases === null ? <button className="btn sm" onClick={load}>{tr('List releases')}</button> : <div className="form">
      <div className="row gap"><label>{tr('Release')} <select value={rel} onChange={(e) => setRel(e.target.value)} aria-label={tr('release')}>{releases.map((r) => <option key={r.release} value={r.release}>{r.release} · {(r.filesize / 1e6).toFixed(0)} MB</option>)}</select></label>
        <label>{tr('Area')} <select value={area?.area_id ?? ''} onChange={(e) => setAreaId(e.target.value)} aria-label={tr('rpc area')}>{areas.map((a) => <option key={a.area_id} value={a.area_id}>{a.name}</option>)}</select></label></div>
      {info && <p className="small muted">{tr('Updated {date} · {size} MB to stream', { date: String(info.last_modified).slice(0, 10), size: (info.filesize / 1e6).toFixed(0) })}{cfg.can_fetch ? '' : ` · ${tr('administrators only on this installation')}`}.</p>}
      <button className="btn primary" disabled={!rel || !area || (!!job && job.state === 'running')} onClick={run}><Download size={13} /> {tr('Import for this area')}</button>
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
    if (maxBytes && f.size > maxBytes) { setErr(tr('file larger than {n} MB', { n: Math.round(maxBytes / 2 ** 20) })); return; }
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
    <summary>{tr('Upload CSV or GeoJSON')}</summary>
    <p className="small muted">{tr('Private to your workspace. CSV: one trip per row with origin and destination coordinates and a departure time. GeoJSON: a FeatureCollection of LineString (origin → destination) or two-point MultiPoint features, WGS-84 longitude/latitude.')}</p>
    <label className="btn"><FileUp size={13} /> {tr('Choose file')}<input type="file" accept=".csv,.txt,.tsv,.geojson,.json" hidden aria-label={tr('dataset file')} onChange={(e) => pick(e.target.files?.[0] ?? null)} /></label>
    {file && <span className="small"> {file.name} · {num(file.size / 1024, 0)} KB</span>}
    {info && <div className="form">
      <p className="small muted">{pid === 'csv' ? tr('{encoding} · delimiter “{delimiter}” · about {rows} rows · {columns} columns', { encoding: info.encoding, delimiter: info.delimiter === '\t' ? tr('tab') : info.delimiter, rows: info.rows_estimate, columns: info.columns.length })
        : `${tr('{n} features', { n: info.features })} · ${Object.entries(info.geometry_types as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(' · ')}`}</p>
      {pid === 'csv' && <label>{tr('Delimiter')} <select value={opts.delimiter} onChange={(e) => { setOpts({ ...opts, delimiter: e.target.value }); pick(file, e.target.value); }} aria-label={tr('delimiter')}>
        {[',', ';', '\t', '|'].map((d) => <option key={d} value={d}>{d === '\t' ? tr('tab') : d}</option>)}</select></label>}
      <div className="mapping" role="group" aria-label={tr('column mapping')}>{fields.map(([k, label]) => <Fragment key={k}><label className="small" htmlFor={`map-${k}`}>{tr(label)}</label>
        <select id={`map-${k}`} value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })}><option value="">—</option>{choices.map((c) => <option key={c} value={c}>{c}</option>)}</select></Fragment>)}</div>
      <div className="row gap"><label>{tr('Time format')} <select value={opts.time_format} onChange={(e) => setOpts({ ...opts, time_format: e.target.value })} aria-label={tr('time format')}>
        <option value="auto">{tr('detect')}</option><option value="iso">{tr('ISO 8601 date-time')}</option><option value="time">{tr('time of day HH:MM')}</option><option value="epoch">{tr('Unix seconds (UTC)')}</option></select></label>
        {mapping.date && <label>{tr('Date format')} <select value={opts.date_format} onChange={(e) => setOpts({ ...opts, date_format: e.target.value })} aria-label={tr('date format')}>{['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'].map((d) => <option key={d}>{d}</option>)}</select></label>}
        <label>{tr('Check against area')} <select value={areaId} onChange={(e) => setOpts({ ...opts, area_id: e.target.value })} aria-label={tr('check area')}><option value="">—</option>{areas.map((a) => <option key={a.area_id} value={a.area_id}>{a.name}</option>)}</select></label></div>
      {pid === 'csv' && info.preview?.length > 0 && <details><summary className="small">{tr('Preview')}</summary><div className="table-scroll"><table><thead><tr>{info.columns.map((c: string) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{info.preview.map((r: string[], i: number) => <tr key={i}>{r.map((v, j) => <td key={j} className="small">{v}</td>)}</tr>)}</tbody></table></div></details>}
      <button className="btn" disabled={busy} onClick={() => send(false)}><CheckCircle2 size={13} /> {tr('Validate')}</button>
    </div>}
    {report && <div className="form" aria-label={tr('validation report')}>
      <p><b>{report.rows_valid}</b> {tr('valid of {n} rows', { n: report.rows_read })}{rejected > 0 && <> · <span className="bad">{tr('{n} rejected', { n: rejected })}</span></>}
        {report.coverage.inside_area != null && <> · {tr('{n} inside “{name}”', { n: report.coverage.inside_area, name: report.checked_area?.name ?? '' })}</>}
        {report.coverage.dates && <> · {report.coverage.dates[0]} → {report.coverage.dates[1]}</>} · {tr('times read as {format}', { format: report.parsing.time_format })}</p>
      {rejected > 0 && <div className="table-scroll"><table aria-label={tr('rejections')}><thead><tr><th>{tr('Reason')}</th><th>{tr('Rows')}</th></tr></thead><tbody>
        {Object.entries(report.rejected as Record<string, number>).map(([k, v]) => <tr key={k}><td>{tr(k)}</td><td>{v}</td></tr>)}</tbody></table>
        <p className="small muted">{tr('Examples: {list}', { list: (report.examples as Json[]).slice(0, 6).map((e) => `${tr('row {n}', { n: e.row })}${e.value != null ? ` (${e.value})` : ''}`).join(', ') })}</p></div>}
      {report.problems.map((p: string) => <p key={p} className="note warn">{p}</p>)}
      {report.coverage.trips > 0 && <Hours h={report.coverage.departures_by_hour} />}
      <div className="row gap"><label>{tr('Name')} <input value={opts.name} onChange={(e) => setOpts({ ...opts, name: e.target.value })} aria-label={tr('dataset name')} /></label>
        <button className="btn primary" disabled={busy || report.problems.length > 0 || opts.name.trim().length < 2} onClick={() => send(true, rejected > 0)}>
          {rejected > 0 ? tr('Save {n} valid trips, drop {rejected}', { n: report.rows_valid, rejected }) : tr('Save {n} trips', { n: report.rows_valid })}</button></div>
    </div>}
  </details>;
}
