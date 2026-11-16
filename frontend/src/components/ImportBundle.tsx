import { useState } from 'react';
import { ShieldCheck, Upload } from 'lucide-react';
import { call, type Json } from '../api/client';
import { tr } from '../i18n';
import { errText, sh } from './common';

export function ImportBundle({ onImported, setErr }: { onImported: (id: string) => void; setErr: (s: string | null) => void }) {
  const [rep, setRep] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (f: File) => {
    setBusy(true); setErr(null); setRep(null);
    const fd = new FormData(); fd.append('file', f);
    try { setRep(await call('/import', { method: 'POST', body: fd })); } catch (e) { setErr(tr('Bundle rejected: {error}', { error: errText(e) })); } finally { setBusy(false); }
  };
  return <div>
    <p className="muted">{tr('Bundles are verified completely before anything is stored, and never contain code.')}</p>
    <label className="btn"><Upload size={13} /> {tr('Choose a bundle (.zip)')}<input type="file" accept=".zip" hidden aria-label={tr('bundle file')} disabled={busy}
      onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
    {rep && <><h3><ShieldCheck size={14} /> {tr('Integrity and provenance verified')}</h3>
      <table className="kv"><tbody>
        <tr><th>{tr('Exported by')}</th><td>{rep.exported_by} · {tr('installation')} <span className="mono">{rep.exporter_installation}</span></td></tr>
        <tr><th>{tr('Files checked')}</th><td>{rep.files_checked}</td></tr>
        <tr><th>{tr('Instances verified')}</th><td>{rep.instances_verified} {tr('(content hashes recomputed)')}</td></tr>
        <tr><th>{tr('Campaigns verified')}</th><td>{rep.campaigns_verified.map((c: Json) => <div key={c.campaign_id} className="small" title={`${c.campaign_id} · ${sh(c.checksum, 16)}`}>{c.title ?? c.campaign_id}</div>)}</td></tr>
        <tr><th>{tr('Executable code')}</th><td>{tr('none — methods are resolved from this installation')}</td></tr>
        <tr><th>{tr('Methods available here')}</th><td>{rep.methods.map((m: Json) => <div key={m.method_id} className="small">{m.method_id}@{m.version}: {m.available_locally ? tr('available') : tr('not available — {reason}', { reason: m.reason })}</div>)}</td></tr>
      </tbody></table>
      <details className="small"><summary>{tr('Details')}</summary><p className="mono wrap-anywhere">bundle {rep.bundle_sha256}<br />manifest {rep.manifest_sha256}<br />format {rep.format}</p></details>
      <button className="btn primary" onClick={() => onImported(rep.root_campaign_id)}>{tr('Open imported campaign')}</button></>}
  </div>;
}
