import { useEffect, useState } from 'react';
import { CheckCircle2, Download, FileJson, Lock, PackageCheck, X } from 'lucide-react';
import { call, download, post, type Json } from '../api/client';
import { errText } from '../components/common';
import { t, tr } from '../i18n';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'experiment';
const kindLabel: Record<string, string> = { baseline: 'Baseline', variant: 'Controlled variant', reproduction: 'Re-execution', extended: 'Extension', 'threshold-study': 'Threshold study' };

/** Export: says exactly what the bundle will contain before anything is written. The sections the importer needs to
 *  verify and reproduce the experiment are always included (and shown as such); replay geometry and the evidence
 *  report are optional and go inside the same ZIP — one download. The report alone (JSON) is an explicit action.
 *  Export locks an unlocked experiment first (its results can no longer change). */
export function ExportDialog({ cid, title, onClose, onDone, setErr }: { cid: string; title: string; onClose: () => void; onDone: () => void; setErr: (s: string | null) => void }) {
  const [p, setP] = useState<Json | null>(null);
  const [geometry, setGeometry] = useState(true);
  const [evidence, setEvidence] = useState(true);
  // imported ML evaluation evidence: the documents (recomputable by the receiver), references only, or nothing
  const [ml, setMl] = useState<'full' | 'reference' | 'none'>('full');
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
      const r = await download(`/campaigns/${cid}/export?geometry=${geometry}&evidence=${evidence}&ml_evidence=${ml}`, file);
      setDone({ file, bytes: r?.bytes ?? 0, sha256: r?.sha256 ?? null, evidence }); onDone();
    } catch (e) { setErr(tr('Export failed: {reason}', { reason: errText(e) })); } finally { setBusy(false); }
  };
  // the report as its own file: only on request
  const saveReport = () => download(`/lab/experiments/${cid}/evidence`, `move_openlab_${slug(title)}_evidence.json`).catch((e) => setErr(tr('Download failed: {reason}', { reason: errText(e) })));
  const Row = ({ on, fixed, title: tt, text, count, onChange }: { on: boolean; fixed?: boolean; title: string; text: string; count?: string; onChange?: (v: boolean) => void }) =>
    <label className={`exrow ${fixed ? 'fixed' : ''}`}><input type="checkbox" checked={on} disabled={fixed} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="grow"><b>{tt}</b>{count && <span className="badge">{count}</span>}{fixed && <span className="req"><Lock size={11} /> {tr('required')}</span>}<span className="small muted block">{text}</span></span></label>;
  const [receiverBefore, receiverAfter = ''] = tr('The receiver opens it with {import}: every checksum and fingerprint is verified before anything is stored, then the experiment can be reproduced and compared. This experiment is now locked.').split('{import}');
  return <div className="overlay" role="dialog" aria-label={tr('export experiment')} onClick={onClose}>
    <div className="drawer exportd" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><PackageCheck size={18} /><div className="grow"><h2>{tr('Export experiment')}</h2>
        <div className="small muted">{tr('A portable bundle (.zip) that another researcher can verify, reproduce and compare — records only, no executable code')}</div></div>
        <button className="btn icon ghost" aria-label={tr('close')} onClick={onClose}><X size={16} /></button></div>
      {!p ? <p className="muted small">{tr('Preparing the summary…')}</p> : done ? <section className="sec">
        <p className="note ok row gap" role="status"><CheckCircle2 size={16} /><span><b>{tr('Bundle saved: {file}', { file: done.file })}</b> · {(done.bytes / 1e6).toFixed(2)} MB{done.sha256 ? ` · SHA-256 ${done.sha256.slice(0, 12)}…` : ''}
          {done.evidence && <><br />{tr('The evidence report is inside it (evidence/report.json).')}</>}</span></p>
        <p className="small muted">{receiverBefore}<b>{t('ws.import')}</b>{receiverAfter}</p>
        <div className="row gap"><button className="btn sm ghost" onClick={saveReport}><FileJson size={13} /> {tr('Evidence report alone (JSON)')}</button><span className="grow" /><button className="btn primary" onClick={onClose}>{tr('Done')}</button></div></section> : <>
        <section className="sec exsum"><h3>{title}</h3>
          <dl className="facts">
            <dt>{tr('Records')}</dt><dd>{p.campaigns.map((c: Json) => `${tr(kindLabel[c.kind] ?? c.kind)}${c.campaign_id === cid ? '' : ` ${tr('(lineage)')}`}`).join(' · ')}</dd>
            <dt>{tr('Problem')}</dt><dd>{p.problem.title} · {tr('validator {version}', { version: p.problem.validator_version })}</dd>
            <dt>{tr('Scenarios')}</dt><dd>{p.scenarios.length === 1 ? tr('{n} frozen scenario', { n: p.scenarios.length }) : tr('{n} frozen scenarios', { n: p.scenarios.length })}{p.scenarios[0]?.name ? ` (${p.scenarios.slice(0, 2).map((s: Json) => s.name).join(' · ')}${p.scenarios.length > 2 ? ' · …' : ''})` : ''}</dd>
            <dt>{tr('Area and data')}</dt><dd>{p.networks.length ? (p.networks[0].osm_timestamp ? tr('OpenStreetMap road network of {date}', { date: p.networks[0].osm_timestamp.slice(0, 10) }) : tr('OpenStreetMap road network')) : tr('no road network')}{p.datasets.length ? ` · ${p.datasets.map((d: Json) => d.release ? `RPC ${d.release}` : d.provider).join(', ')}` : ''}</dd>
            <dt>{tr('Methods')}</dt><dd>{p.methods.map((m: Json) => `${m.method_id} ${m.version}`).join(' · ')}</dd>
            <dt>{tr('Runs')}</dt><dd>{tr('{n} of {m} accepted by the independent validator', { n: accepted, m: runs })}</dd></dl>
          {!p.locked && <p className="note warn small row gap"><Lock size={13} /> {tr('Export locks this experiment first: its results can no longer change (its scenarios and records stay as they are).')}</p>}</section>
        <section className="sec"><h3>{tr('What the bundle contains')}</h3>
          <div className="exlist">
            <Row on fixed title={tr('Manifest and integrity')} text={tr('Format, checksum of every file, experiment and semantic fingerprints. The importer checks all of it before storing anything.')} />
            <Row on fixed title={tr('Experiment records and lineage')} count={`${p.campaigns.length}`} text={tr('Configuration, methods, repetitions and every run, with the records it derives from (a variant carries its baseline).')} />
            <Row on fixed title={tr('Scenario definitions')} count={`${p.scenarios.length}`} text={tr('Frozen drivers, riders, time windows and travel times — exactly what the methods solved.')} />
            <Row on fixed title={tr('Run results and validator evidence')} count={tr('{n} runs', { n: runs })} text={tr("Each run's decisions, the validator's verdict and recomputed metrics, timings.")} />
            <Row on fixed title={tr('Area, road network and mobility data references')} text={tr('Area box, OpenStreetMap network id and date, RPC release, licences and attribution — references, not the raw data.')} />
            <Row on fixed title={tr('Vehicle and emission parameters')} count={p.vehicles ? tr('{n} profiles', { n: p.vehicles }) : undefined} text={p.emissions.length ? tr('Every vehicle profile with its sources, and the CO₂ calculation and baseline of each record.') : tr('No vehicle data in these scenarios.')} />
            <Row on={geometry} title={tr('Replay geometry')} count={tr('{n} of {m}', { n: p.geometry.available, m: p.geometry.scenarios })} onChange={setGeometry}
              text={p.geometry.available ? tr('Road polylines of the routes, so the receiver can replay them without downloading the road network. Optional.') : tr('Not available for these scenarios.')} />
            <Row on={evidence} title={tr('Evidence report')} onChange={setEvidence}
              text={tr('Inside the ZIP (evidence/report.json): validation, reproducibility, semantic comparability, fingerprints and results in one readable file. Checked against the bundle on import; not needed to verify it.')} />
            {(p.ml_evaluations?.documents ?? 0) + (p.ml_evaluations?.references ?? 0) > 0 && <div className="exrow ml-export" role="group" aria-label={tr('ML evaluation evidence')}>
              <span className="grow"><b>{tr('ML evaluation evidence')}</b><span className="badge">{tr('{n} documents', { n: p.ml_evaluations.documents + p.ml_evaluations.references })}</span>
                <span className="small muted block">{tr('Imported predictions and labels of the learned methods, with their dataset, split, population, decision, model and feature-pipeline provenance and the metric definitions.')}</span>
                <span className="seg ml-export-seg">{(['full', 'reference', 'none'] as const).map((m) => <button key={m} type="button" className={ml === m ? 'on' : ''} aria-pressed={ml === m} onClick={() => setMl(m)}>
                  {m === 'full' ? tr('Include the evidence') : m === 'reference' ? tr('References only') : tr('Leave out')}</button>)}</span>
                <span className="small block">{ml === 'full' ? tr('The receiver re-validates the evidence and recomputes every figure (confusion matrix, metrics, threshold curve).')
                  : ml === 'reference' ? tr('Only provenance, decision, metric definitions, recorded figures and SHA-256: the receiver sees them marked as not recomputable. Use this when the predictions or labels may not be shared.')
                  : tr('The receiver gets no ML evaluation for these records.')}</span>
                {p.ml_evaluations.references > 0 && <span className="small warn-text block">{tr('{n} of them came to you as references only: they can only be passed on as references.', { n: p.ml_evaluations.references })}</span>}
                {ml !== 'none' && <span className="tiny muted block">{tr('An installation older than this version cannot read a bundle with this section; it says so and imports nothing.')}</span>}</span></div>}
          </div></section>
        <div className="row gap drawer-foot"><FileJson size={14} className="muted" /><span className="small muted grow">{tr('No code is exported: methods are identified by id, version and code digest.')}</span>
          <button className="btn" onClick={onClose}>{tr('Cancel')}</button>
          <button className="btn primary" disabled={busy} onClick={go}><Download size={14} /> {busy ? tr('Exporting…') : p.locked ? tr('Export bundle') : tr('Lock and export')}</button></div>
      </>}
    </div>
  </div>;
}
