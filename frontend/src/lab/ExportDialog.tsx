import { useEffect, useState } from 'react';
import { CheckCircle2, Download, FileJson, Lock, PackageCheck, X } from 'lucide-react';
import { call, download, post, type Json } from '../api/client';
import { errText } from '../components/common';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'experiment';
const kindLabel: Record<string, string> = { baseline: 'Baseline', variant: 'Controlled variant', reproduction: 'Re-execution', extended: 'Extension', 'threshold-study': 'Threshold study' };

/** Export: says exactly what the bundle will contain before anything is written. The sections the importer needs to
 *  verify and reproduce the experiment are always included (and shown as such); replay geometry and the separate
 *  evidence report are optional. Export locks an unlocked experiment first (its results can no longer change). */
export function ExportDialog({ cid, title, onClose, onDone, setErr }: { cid: string; title: string; onClose: () => void; onDone: () => void; setErr: (s: string | null) => void }) {
  const [p, setP] = useState<Json | null>(null);
  const [geometry, setGeometry] = useState(true);
  const [evidence, setEvidence] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ file: string; bytes: number; sha256: string | null; evidence: boolean } | null>(null);
  useEffect(() => { call(`/lab/export/${cid}`).then((r) => { setP(r); setGeometry(r.geometry.available > 0); }).catch((e) => setErr(errText(e))); }, [cid, setErr]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const runs = p ? p.campaigns.reduce((n: number, c: Json) => n + c.runs, 0) : 0;
  const accepted = p ? p.campaigns.reduce((n: number, c: Json) => n + c.accepted, 0) : 0;
  const go = async () => {
    setErr(null); setBusy(true);
    try {
      if (!p!.locked) await post(`/campaigns/${cid}/lock`);
      const file = `move_openlab_${slug(title)}.zip`;
      const r = await download(`/campaigns/${cid}/export?geometry=${geometry}`, file);
      if (evidence) await download(`/lab/experiments/${cid}/evidence`, `move_openlab_${slug(title)}_evidence.json`);
      setDone({ file, bytes: r?.bytes ?? 0, sha256: r?.sha256 ?? null, evidence }); onDone();
    } catch (e) { setErr(`Export failed: ${errText(e)}`); } finally { setBusy(false); }
  };
  const Row = ({ on, fixed, title: tt, text, count, onChange }: { on: boolean; fixed?: boolean; title: string; text: string; count?: string; onChange?: (v: boolean) => void }) =>
    <label className={`exrow ${fixed ? 'fixed' : ''}`}><input type="checkbox" checked={on} disabled={fixed} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="grow"><b>{tt}</b>{count && <span className="badge">{count}</span>}{fixed && <span className="req"><Lock size={11} /> required</span>}<span className="small muted block">{text}</span></span></label>;
  return <div className="overlay" role="dialog" aria-label="export experiment" onClick={onClose}>
    <div className="drawer exportd" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><PackageCheck size={18} /><div className="grow"><h2>Export experiment</h2>
        <div className="small muted">A portable bundle (.zip) that another researcher can verify, reproduce and compare — records only, no executable code</div></div>
        <button className="btn icon ghost" aria-label="close" onClick={onClose}><X size={16} /></button></div>
      {!p ? <p className="muted small">Preparing the summary…</p> : done ? <section className="sec">
        <p className="note ok row gap" role="status"><CheckCircle2 size={16} /><span><b>Bundle saved: {done.file}</b> · {(done.bytes / 1e6).toFixed(2)} MB{done.sha256 ? ` · SHA-256 ${done.sha256.slice(0, 12)}…` : ''}
          {done.evidence && <><br />Evidence report saved next to it (JSON).</>}</span></p>
        <p className="small muted">The receiver opens it with <b>Import</b>: every checksum and fingerprint is verified before anything is stored, then the experiment can be
          reproduced and compared. This experiment is now locked.</p>
        <div className="row gap"><span className="grow" /><button className="btn primary" onClick={onClose}>Done</button></div></section> : <>
        <section className="sec exsum"><h3>{title}</h3>
          <dl className="facts">
            <dt>Records</dt><dd>{p.campaigns.map((c: Json) => `${kindLabel[c.kind] ?? c.kind}${c.campaign_id === cid ? '' : ' (lineage)'}`).join(' · ')}</dd>
            <dt>Problem</dt><dd>{p.problem.title} · validator {p.problem.validator_version}</dd>
            <dt>Scenarios</dt><dd>{p.scenarios.length} frozen scenario{p.scenarios.length === 1 ? '' : 's'}{p.scenarios[0]?.name ? ` (${p.scenarios.slice(0, 2).map((s: Json) => s.name).join(' · ')}${p.scenarios.length > 2 ? ' · …' : ''})` : ''}</dd>
            <dt>Area and data</dt><dd>{p.networks.length ? `OpenStreetMap road network${p.networks[0].osm_timestamp ? ` of ${p.networks[0].osm_timestamp.slice(0, 10)}` : ''}` : 'no road network'}{p.datasets.length ? ` · ${p.datasets.map((d: Json) => d.release ? `RPC ${d.release}` : d.provider).join(', ')}` : ''}</dd>
            <dt>Methods</dt><dd>{p.methods.map((m: Json) => `${m.method_id} ${m.version}`).join(' · ')}</dd>
            <dt>Runs</dt><dd>{accepted} of {runs} accepted by the independent validator</dd></dl>
          {!p.locked && <p className="note warn small row gap"><Lock size={13} /> Export locks this experiment first: its results can no longer change (its scenarios and records stay as they are).</p>}</section>
        <section className="sec"><h3>What the bundle contains</h3>
          <div className="exlist">
            <Row on fixed title="Manifest and integrity" text="Format, checksum of every file, experiment and semantic fingerprints. The importer checks all of it before storing anything." />
            <Row on fixed title="Experiment records and lineage" count={`${p.campaigns.length}`} text="Configuration, methods, repetitions and every run, with the records it derives from (a variant carries its baseline)." />
            <Row on fixed title="Scenario definitions" count={`${p.scenarios.length}`} text="Frozen drivers, riders, time windows and travel times — exactly what the methods solved." />
            <Row on fixed title="Run results and validator evidence" count={`${runs} runs`} text="Each run's decisions, the validator's verdict and recomputed metrics, timings." />
            <Row on fixed title="Area, road network and mobility data references" text="Area box, OpenStreetMap network id and date, RPC release, licences and attribution — references, not the raw data." />
            <Row on fixed title="Vehicle and emission parameters" count={p.vehicles ? `${p.vehicles} profiles` : undefined} text={p.emissions.length ? 'Every vehicle profile with its sources, and the CO₂ calculation and baseline of each record.' : 'No vehicle data in these scenarios.'} />
            <Row on={geometry} title="Replay geometry" count={`${p.geometry.available} of ${p.geometry.scenarios}`} onChange={setGeometry}
              text={p.geometry.available ? 'Road polylines of the routes, so the receiver can replay them without downloading the road network. Optional.' : 'Not available for these scenarios.'} />
            <Row on={evidence} title="Evidence report (separate JSON file)" onChange={setEvidence}
              text="Validation, reproducibility, semantic comparability, fingerprints and results in one readable file to keep next to the bundle. Not needed to verify it." />
          </div></section>
        <div className="row gap drawer-foot"><FileJson size={14} className="muted" /><span className="small muted grow">No code is exported: methods are identified by id, version and code digest.</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={go}><Download size={14} /> {busy ? 'Exporting…' : p.locked ? 'Export bundle' : 'Lock and export'}</button></div>
      </>}
    </div>
  </div>;
}
