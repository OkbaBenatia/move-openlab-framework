import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, FileArchive, FileCheck2, PackageOpen, RotateCcw, Upload, X, XCircle } from 'lucide-react';
import { call, type Json } from '../api/client';
import { errText } from '../components/common';
import { t } from '../i18n';
import { BASELINE_LABEL, SCOPE_LABEL } from '../mobility/api';

type Step = 'choose' | 'inspect' | 'contents' | 'verify' | 'confirm';
const STEPS: [Step, string][] = [['choose', 'Choose file'], ['inspect', 'Inspect package'], ['contents', 'What will be imported'],
  ['verify', 'Integrity and compatibility'], ['confirm', 'Confirm import']];
const kindLabel: Record<string, string> = { baseline: 'Baseline', variant: 'Controlled variant', reproduction: 'Re-execution', extended: 'Extension', 'threshold-study': 'Threshold study' };
const presence: Record<string, [string, string]> = { new: ['New here', 'ok'], identical: ['Already here (identical)', ''], different: ['Conflict', 'bad'] };

/** Import, in stages: choose a bundle, inspect it on the server (complete verification, nothing written), see what it
 *  contains and what importing would do here, then confirm. Nothing is stored before "Import experiment". */
export function ImportDialog({ onClose, onImported, onReproduce, sampleAvailable, setErr }: {
  onClose: () => void; onImported: (rootId: string, note: string) => void; onReproduce: (cid: string) => void; sampleAvailable: boolean; setErr: (s: string | null) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [rep, setRep] = useState<Json | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const inspect = async (f: File) => {
    setFile(f); setRep(null); setFailure(null); setErr(null); setBusy('inspect');
    const fd = new FormData(); fd.append('file', f);
    try { setRep(await call('/lab/inspect', { method: 'POST', body: fd })); }
    catch (e) { setFailure(errText(e)); } finally { setBusy(''); }
  };
  const sample = async () => {
    setBusy('inspect');
    try {
      const r = await fetch('/api/lab/sample/bundle', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`${r.status}`);
      await inspect(new File([await r.blob()], 'move-openlab-sample-montbeliard.zip', { type: 'application/zip' }));
    } catch (e) { setFailure(errText(e)); setBusy(''); }
  };
  const confirm = async () => {
    if (!file || !rep) return;
    setBusy('import');
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await call('/import', { method: 'POST', body: fd });
      onImported(r.root_campaign_id, `${t('ev.integrity')}: ${r.files_checked} files from ${r.exported_by}, no executable code. Use Run again to reproduce it here.`);
    } catch (e) { setErr(`Import refused: ${errText(e)}`); } finally { setBusy(''); }
  };
  const root = rep?.campaigns_verified.find((c: Json) => c.campaign_id === rep.root_campaign_id);
  const current: Step = !file ? 'choose' : busy === 'inspect' ? 'inspect' : rep ? 'confirm' : 'inspect';
  const done = (s: Step) => STEPS.findIndex(([x]) => x === s) < STEPS.findIndex(([x]) => x === current) || (!!rep && s !== 'confirm');
  const ok = (v: boolean) => (v ? <CheckCircle2 size={15} className="ok-text" /> : <XCircle size={15} className="bad-text" />);
  return <div className="overlay" role="dialog" aria-label="import experiment" onClick={onClose}>
    <div className="drawer guide importd" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><PackageOpen size={18} /><div className="grow"><h2>Import experiment</h2>
        <div className="small muted">Check a bundle completely, see what it contains, then decide. Nothing is stored before you confirm.</div></div>
        <button className="btn icon ghost" aria-label="close" onClick={onClose}><X size={16} /></button></div>
      <div className="guide-grid">
        <ol className="rail" aria-label="import steps">{STEPS.map(([s, label], i) => <li key={s} className={done(s) ? 'done' : s === current ? 'current' : ''}>
          <span className="dotnum">{done(s) ? <Check size={13} /> : i + 1}</span>{label}</li>)}</ol>
        <div className="guide-body">
          <section className="sec"><h3><FileArchive size={16} /> Bundle file</h3>
            <div className={`dropzone ${file ? 'has' : ''}`} onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) inspect(f); }}>
              {file ? <span className="row gap"><FileArchive size={16} /><b className="mono small">{file.name}</b><span className="small muted">{(file.size / 1e6).toFixed(2)} MB</span></span>
                : <span className="small muted">Drop a MOVE OpenLab bundle (.zip) here, or choose it.</span>}
              <span className="row gap"><button className="btn sm" onClick={() => input.current?.click()}><Upload size={13} /> {file ? 'Choose another file' : 'Choose a bundle file'}</button>
                {sampleAvailable && !file && <button className="btn sm ghost" onClick={sample}>Use the public sample bundle</button>}</span>
              <input ref={input} type="file" accept=".zip" hidden aria-label="bundle file to inspect" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) inspect(f); }} />
            </div>
            {busy === 'inspect' && <p className="small muted">Inspecting: checking every checksum, fingerprint and record… nothing is stored.</p>}
            {failure && <p className="note bad small" role="alert"><b>This bundle cannot be imported.</b> {failure}</p>}</section>
          {rep && <>
            <section className="sec"><h3>Package</h3>
              <dl className="facts">
                <dt>Experiment</dt><dd><b>{root?.title}</b> · {kindLabel[root?.kind] ?? root?.kind}</dd>
                <dt>Exported by</dt><dd>{rep.exported_by}{rep.created_at ? ` · ${new Date(rep.created_at).toLocaleString()}` : ''} · installation {String(rep.exporter_installation).slice(0, 12)}</dd>
                <dt>Format</dt><dd>{rep.format} · {(rep.bytes / 1e6).toFixed(2)} MB · SHA-256 <span className="mono">{rep.bundle_sha256.slice(0, 16)}…</span></dd>
                <dt>Problem</dt><dd>{rep.problem_title ?? rep.problem_id}</dd></dl></section>
            <section className="sec"><h3>What will be imported</h3>
              <table className="compact" aria-label="records in the bundle"><thead><tr><th>Record</th><th>Kind</th><th className="n">Runs accepted</th><th>Here</th></tr></thead>
                <tbody>{rep.campaigns_verified.map((c: Json) => <tr key={c.campaign_id}><td>{c.title}</td><td className="small">{kindLabel[c.kind] ?? c.kind}{c.relation ? ` · ${c.relation}` : ''}</td>
                  <td className="n">{c.accepted} / {c.runs}</td><td><span className={`badge ${presence[rep.present[c.campaign_id]]?.[1] ?? ''}`}>{presence[rep.present[c.campaign_id]]?.[0]}</span></td></tr>)}</tbody></table>
              <dl className="facts">
                <dt>Scenarios</dt><dd>{rep.instances_verified} frozen scenario{rep.instances_verified === 1 ? '' : 's'}{rep.scenarios?.length ? ` (${rep.scenarios.slice(0, 2).map((s: Json) => s.name ?? s.instance_id).join(' · ')}${rep.scenarios.length > 2 ? ' · …' : ''})` : ''}</dd>
                <dt>Area and road network</dt><dd>{rep.networks.length ? rep.networks.map((n: Json) => `OpenStreetMap${n.osm_timestamp ? ` ${n.osm_timestamp.slice(0, 10)}` : ''} · ${n.profile ?? 'car'} profile${n.licence?.id ? ` · ${n.licence.id}` : ''}`).join('; ') : 'none (no geography)'}</dd>
                <dt>Mobility data</dt><dd>{rep.datasets.length ? rep.datasets.map((d: Json) => `${d.provider === 'rpc' || d.release ? `RPC ${d.release}` : d.provider}${d.licence?.name ? ` · ${d.licence.name}` : ''}`).join('; ') : 'synthetic or placed participants'}</dd>
                <dt>Methods</dt><dd>{rep.methods.map((m: Json) => <span key={`${m.method_id}${m.version}`} className={`badge ${m.available_locally ? 'ok' : 'warn'}`} title={m.reason ?? 'available on this installation'}>{m.method_id} {m.version}{m.available_locally ? '' : ' · not here'}</span>)}</dd>
                <dt>Vehicles and CO₂</dt><dd>{rep.vehicles ? `${rep.vehicles} vehicle profiles` : 'no vehicle data'}{rep.emissions?.length ? ` · CO₂: ${SCOPE_LABEL[rep.emissions[0].scope] ?? rep.emissions[0].scope}, baseline ${(BASELINE_LABEL[rep.emissions[0].baseline] ?? rep.emissions[0].baseline).toLowerCase()}` : ''}</dd>
                <dt>Replay geometry</dt><dd>{rep.geometry_verified ? `${rep.geometry_verified} route files` : 'none'}</dd>
                <dt>Evidence report</dt><dd>{rep.evidence ? `included · matches the bundle${rep.evidence.generated_by ? ` · by ${rep.evidence.generated_by}` : ''}` : 'not included'}</dd></dl></section>
            <section className="sec"><h3><FileCheck2 size={16} /> Integrity and compatibility</h3>
              <ul className="checks">
                <li>{ok(true)} <b>{t('ev.integrity')}</b><span>{rep.files_checked} files, each checksum matches; manifest digest matches</span></li>
                <li>{ok(true)} <b>Records and lineage</b><span>{rep.campaigns_verified.length} record checksum{rep.campaigns_verified.length === 1 ? '' : 's'} · fingerprints recomputed</span></li>
                <li>{ok(true)} <b>Problem and validator</b><span>same specification and validator as this installation</span></li>
                <li>{ok(true)} <b>No executable code</b><span>methods are identified by id, version and code digest</span></li>
                <li>{ok(rep.importable)} <b>Importable</b><span>{rep.importable ? (rep.adds ? `${rep.adds} new record${rep.adds === 1 ? '' : 's'} will be added; nothing is overwritten` : 'already in your workspace — nothing to add') : 'a different record with the same identifier exists here'}</span></li>
                <li>{ok(rep.reproducible_here)} <b>Reproducible here</b><span>{rep.reproducible_here ? 'every method is available: Run again re-executes it on these frozen scenarios' : 'some methods are missing here (see Methods)'}</span></li>
                <li>{ok(true)} <b>Comparable</b><span>{rep.comparable}</span></li></ul>
              {rep.warnings.map((w: string) => <p key={w} className="note warn small row gap"><AlertTriangle size={13} /> {w}</p>)}</section>
            <div className="row gap drawer-foot"><span className="small muted grow">Integrity says the bundle is complete and unaltered; reproducing it is the next step.</span>
              <button className="btn" onClick={onClose}>Cancel</button>
              {rep.adds === 0 && rep.importable ? <button className="btn primary" disabled={!!busy || !rep.reproducible_here} onClick={() => onReproduce(rep.root_campaign_id)}><RotateCcw size={14} /> Reproduce it here</button>
                : <button className="btn primary" disabled={!!busy || !rep.importable} onClick={confirm}><FileCheck2 size={14} /> {busy === 'import' ? 'Importing…' : 'Import experiment'}</button>}</div>
          </>}
        </div>
      </div>
    </div>
  </div>;
}
