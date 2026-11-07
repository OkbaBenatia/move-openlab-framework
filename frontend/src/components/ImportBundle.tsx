import { useState } from 'react';
import { ShieldCheck, Upload } from 'lucide-react';
import { call, type Json } from '../api/client';
import { errText, sh } from './common';

export function ImportBundle({ onImported, setErr }: { onImported: (id: string) => void; setErr: (s: string | null) => void }) {
  const [rep, setRep] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (f: File) => {
    setBusy(true); setErr(null); setRep(null);
    const fd = new FormData(); fd.append('file', f);
    try { setRep(await call('/import', { method: 'POST', body: fd })); } catch (e) { setErr(`Bundle rejected: ${errText(e)}`); } finally { setBusy(false); }
  };
  return <div>
    <p className="muted">An experiment bundle is verified completely before anything is stored: manifest digest, every file hash, every instance hash,
      every campaign checksum, the lineage and the problem specification. Bundles never contain code; nothing is executed on import.</p>
    <label className="btn"><Upload size={13} /> Choose a bundle (.zip)<input type="file" accept=".zip" hidden aria-label="bundle file" disabled={busy}
      onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
    {rep && <><h3><ShieldCheck size={14} /> Integrity and provenance verified</h3>
      <table className="kv"><tbody>
        <tr><th>Bundle SHA-256</th><td className="mono">{rep.bundle_sha256}</td></tr>
        <tr><th>Manifest SHA-256</th><td className="mono">{rep.manifest_sha256}</td></tr>
        <tr><th>Exported by</th><td>{rep.exported_by} · installation <span className="mono">{rep.exporter_installation}</span></td></tr>
        <tr><th>Files checked</th><td>{rep.files_checked}</td></tr>
        <tr><th>Instances verified</th><td>{rep.instances_verified} (content hashes recomputed)</td></tr>
        <tr><th>Campaigns verified</th><td>{rep.campaigns_verified.map((c: Json) => <div key={c.campaign_id} className="mono small">{c.kind} {c.campaign_id} · {sh(c.checksum, 16)}</div>)}</td></tr>
        <tr><th>Executable code</th><td>none — methods are resolved from this installation</td></tr>
        <tr><th>Methods available here</th><td>{rep.methods.map((m: Json) => <div key={m.method_id} className="small">{m.method_id}@{m.version}: {m.available_locally ? 'available' : `not available — ${m.reason}`}</div>)}</td></tr>
      </tbody></table>
      <button className="btn primary" onClick={() => onImported(rep.root_campaign_id)}>Open imported campaign</button></>}
  </div>;
}
