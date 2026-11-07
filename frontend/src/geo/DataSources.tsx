import { useEffect, useState } from 'react';
import { Download, Route } from 'lucide-react';
import type { Json } from '../api/client';
import { errText } from '../components/common';
import { JobProgress } from '../components/JobProgress';
import { COLORS, LeafletMap } from './LeafletMap';
import { geo, type GeoConfig } from './api';

/** Road networks (OpenStreetMap via Overpass) and open carpooling data (RPC). Fetching and ingesting are administrator
 *  actions run as background jobs; every user can inspect provenance, licences and cleaning reports. */
export function DataSources({ cfg, setErr, onChanged }: { cfg: GeoConfig; setErr: (s: string | null) => void; onChanged: () => void }) {
  const [view, setView] = useState<[number, number, number, number] | null>(null);
  const [name, setName] = useState('');
  const [bbox, setBbox] = useState('');
  const [job, setJob] = useState<Json | null>(null);
  const [releases, setReleases] = useState<Json[] | null>(null);
  const [rel, setRel] = useState('');
  const [areaSel, setArea] = useState('');
  const area = cfg.networks.some((n) => n.network_id === areaSel) ? areaSel : (cfg.networks[0]?.network_id ?? '');  // networks may appear after mount
  useEffect(() => { geo.releases().then((r) => { setReleases(r.releases); setRel(r.releases[0]?.release ?? ''); }).catch(() => setReleases([])); }, []);
  const parseBox = (): number[] | null => { const v = bbox.split(/[\s,]+/).filter(Boolean).map(Number); return v.length === 4 && v.every((x) => !Number.isNaN(x)) ? v : null; };
  const fetchNet = async () => { const b = parseBox(); if (!b) { setErr('bounding box: south, west, north, east'); return; } setErr(null); try { setJob(await geo.fetchNetwork(name, b)); } catch (e) { setErr(errText(e)); } };
  const ingest = async () => { const n = cfg.networks.find((x) => x.network_id === area); if (!n) { setErr('choose an area (road network) first'); return; } setErr(null); try { setJob(await geo.ingest(rel, n.area.name, n.area.bbox)); } catch (e) { setErr(errText(e)); } };
  const relInfo = releases?.find((r) => r.release === rel);
  return <div className="split">
    <div>
      <h3><Route size={14} /> Road networks</h3>
      {cfg.networks.length === 0 ? <p className="muted">None installed.</p> :
        <div className="table-scroll"><table aria-label="road networks"><thead><tr><th>Area</th><th>Nodes · edges</th><th>OSM data</th><th>Retrieved</th><th>Network id</th></tr></thead>
          <tbody>{cfg.networks.map((n) => <tr key={n.network_id}><td><b>{n.area.name}</b><div className="mono small">{n.area.bbox.join(', ')}</div></td>
            <td>{n.nodes} · {n.edges}</td><td className="small">{n.source.osm_timestamp ?? '—'}</td><td className="small">{n.source.retrieved_at}</td>
            <td className="mono small" title={`raw response sha256 ${n.source.raw_sha256}`}>{n.network_id}</td></tr>)}</tbody></table></div>}
      {cfg.can_manage && <div className="form">
        <p className="small muted">Fetch a road network (one Overpass API request, fair-use limits apply; at most 0.25 square degrees). Data © OpenStreetMap contributors, ODbL.</p>
        <label>Area name <input value={name} onChange={(e) => setName(e.target.value)} aria-label="area name" /></label>
        <label>Bounding box (south, west, north, east) <input value={bbox} onChange={(e) => setBbox(e.target.value)} aria-label="bounding box" /></label>
        <div className="row gap"><button className="btn" disabled={!view} onClick={() => view && setBbox(view.join(', '))}>Use the map view</button>
          <button className="btn primary" disabled={!!job && job.state === 'running' || name.length < 2} onClick={fetchNet}><Download size={13} /> Fetch road network</button></div></div>}
      <h3><Download size={14} /> Open carpooling data (RPC)</h3>
      <p className="small muted">Registre de Preuve de Covoiturage, data.gouv.fr — Licence Ouverte / Open Licence (Etalab). Records are anonymised by the publisher; ingestion keeps only journeys starting and ending inside the chosen area, drops identifiers and stores a cleaning report. The full monthly file is streamed once and not stored.</p>
      {cfg.datasets.length > 0 && <div className="table-scroll"><table aria-label="datasets"><thead><tr><th>Area · release</th><th>Kept / read</th><th>Rejected</th><th>Source SHA-256</th></tr></thead>
        <tbody>{cfg.datasets.map((d) => <tr key={d.dataset_key}><td><b>{d.area.name}</b> · {d.release}<div className="small muted">{d.attribution}</div></td>
          <td>{d.rows_kept} / {d.rows_read}</td><td className="small">{Object.entries(d.rejected as Record<string, number>).filter(([k]) => k !== 'outside_area').map(([k, v]) => `${k.replaceAll('_', ' ')}: ${v}`).join(' · ') || '—'}</td>
          <td className="mono small">{d.source.sha256.slice(0, 16)}</td></tr>)}</tbody></table></div>}
      {cfg.can_manage && cfg.networks.length > 0 && <div className="form">
        <div className="row gap"><label>Release <select value={rel} onChange={(e) => setRel(e.target.value)} aria-label="release">{(releases ?? []).map((r) => <option key={r.release} value={r.release}>{r.release} · {(r.filesize / 1e6).toFixed(0)} MB</option>)}</select></label>
          <label>Area <select value={area} onChange={(e) => setArea(e.target.value)} aria-label="ingest area">{cfg.networks.map((n) => <option key={n.network_id} value={n.network_id}>{n.area.name}</option>)}</select></label></div>
        {relInfo && <p className="small muted">Streams {(relInfo.filesize / 1e6).toFixed(0)} MB from data.gouv.fr (updated {String(relInfo.last_modified).slice(0, 10)}).</p>}
        <button className="btn primary" disabled={!rel || (!!job && job.state === 'running')} onClick={ingest}><Download size={13} /> Ingest release</button></div>}
      {releases === null && <p className="small muted">Loading releases…</p>}
      {job && <JobProgress job={job} setErr={setErr} unit={job.kind === 'rpc-ingest' ? 'bytes' : undefined} onFinished={(j) => { setJob(j); onChanged(); }} />}
    </div>
    <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} rects={[...cfg.networks.map((n) => ({ bbox: n.area.bbox, color: COLORS.area })), ...(parseBox() ? [{ bbox: parseBox() as [number, number, number, number], color: COLORS.rider }] : [])]} fitKey={String(cfg.networks.length)} onBounds={setView} />
  </div>;
}
