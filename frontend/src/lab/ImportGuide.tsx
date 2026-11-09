import { useCallback, useEffect, useState } from 'react';
import { Check, CheckCircle2, Download, FileCheck2, GitCompareArrows, PackageOpen, Puzzle, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { download, post, type Json, type MethodRef } from '../api/client';
import { JobProgress } from '../components/JobProgress';
import { errText } from '../components/common';
import { t } from '../i18n';
import { lab, type ExpItem, type SampleState } from './api';

type Step = 'download' | 'import' | 'verify' | 'reproduce' | 'compare' | 'method' | 'extend';
const STEPS: [Step, string][] = [['download', t('sample.download')], ['import', t('sample.import')], ['verify', t('sample.verify')], ['reproduce', 'Reproduce'],
  ['compare', t('sample.compareRepro')], ['method', t('sample.addMethod')], ['extend', 'Extend · compare again · export']];

/** "Try an imported experiment": the public sample bundle through the real path — download, import (full verification),
 *  independent re-execution, reproducibility, then your own method on the same frozen experiment. Every result shown here
 *  comes from the server; nothing is simulated. */
export function ImportGuide({ sample, experiments, methods, onClose, onOpen, onCompare, onAddMethod, reload, setErr }: {
  sample: SampleState; experiments: ExpItem[]; methods: MethodRef[]; onClose: () => void; onOpen: (cid: string) => void;
  onCompare: (a: string, b: string) => void; onAddMethod: () => void; reload: () => Promise<unknown>; setErr: (s: string | null) => void;
}) {
  const [report, setReport] = useState<Json | null>(null);
  const [imported, setImported] = useState(!!sample.imported);
  const [job, setJob] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const [repro, setRepro] = useState<Json | null>(null);
  const root = sample.campaign_id ?? '';
  const reproItem = experiments.filter((x) => x.parent === root && x.kind === 'reproduction').slice(-1)[0];
  // the extension derives from the imported original: it is locked (frozen), so your method runs on exactly its scenarios
  const extItem = experiments.filter((x) => x.parent === root && x.kind === 'extended').slice(-1)[0];
  const plugins = methods.filter((m) => m.source === 'plugin');
  const act = useCallback(async (fn: () => Promise<unknown>) => { setErr(null); setBusy(true); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } }, [setErr]);
  useEffect(() => { act(() => post('/lab/sample/verify').then(setReport)); }, [act]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.addm')) onClose(); };   // Add method above closes first
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => { if (reproItem) lab.experiment(reproItem.campaign_id).then(setRepro).catch(() => { /* optional */ }); }, [reproItem?.campaign_id, reproItem?.status]);   // eslint-disable-line react-hooks/exhaustive-deps
  const doImport = () => act(async () => { const r = await post('/lab/sample'); setReport(r); setImported(true); await reload(); });
  const reproduce = () => act(async () => { const r = await post(`/campaigns/${root}/reproduce`); setJob(await post(`/campaigns/${r.campaign_id}/execute`)); });
  const extend = () => act(async () => {
    const r = await post(`/campaigns/${root}/extend`, { methods: plugins.map((m) => [m.method_id, m.version]) });
    setJob(await post(`/campaigns/${r.campaign_id}/execute`));
  });
  const done: Record<Step, boolean> = { download: false, import: imported, verify: !!report?.ok, reproduce: !!reproItem && reproItem.status === 'completed',
    compare: !!repro?.reproduction, method: plugins.length > 0, extend: !!extItem && extItem.status === 'completed' };
  const current = STEPS.find(([s]) => s !== 'download' && !done[s])?.[0] ?? 'extend';
  const rr = repro?.reproduction;
  return <div className="overlay" role="dialog" aria-label={t('sample.title')} onClick={onClose}>
    <div className="drawer guide" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><PackageOpen size={18} /><h2 className="grow">{t('sample.title')}</h2><button className="btn icon ghost" aria-label="close" onClick={onClose}><X size={16} /></button></div>
      <div className="guide-grid">
        <ol className="rail" aria-label="steps">{STEPS.map(([s, label]) => <li key={s} className={done[s] ? 'done' : s === current ? 'current' : ''}><span className="dotnum">{done[s] ? <Check size={13} /> : STEPS.findIndex(([x]) => x === s) + 1}</span>{label}</li>)}</ol>
        <div className="guide-body">
          <section className="sec"><h3>{sample.title}</h3>
            <p className="small muted">A frozen experiment exported by “Researcher A” from the Montbéliard demonstration: {sample.scenarios} scenarios, {sample.runs} runs, bundle format {sample.format}.
              Its cross-installation check (import, re-execution, extension) last succeeded on {sample.check ? new Date(sample.check.checked_at).toLocaleDateString() : '—'}.</p>
            <div className="row gap"><button className="btn" onClick={() => act(() => download('/lab/sample/bundle', sample.filename ?? 'sample.zip'))}><Download size={14} /> {t('sample.download')}</button>
              <span className="small muted mono">{sample.filename} · {((sample.bytes ?? 0) / 1e6).toFixed(2)} MB · SHA-256 {sample.sha256?.slice(0, 12)}…</span></div></section>
          <section className="sec"><h3><ShieldCheck size={16} /> {t('ev.integrity')}</h3>
            {!report ? <p className="small muted">Verifying…</p> : <ul className="checks">
              <li><CheckCircle2 size={15} /> <b>Archive and manifest</b><span>manifest digest matches · {report.files_checked} files, each checksum matches</span></li>
              <li><CheckCircle2 size={15} /> <b>Scenarios</b><span>{report.instances_verified} scenario files pass the problem's integrity checks</span></li>
              <li><CheckCircle2 size={15} /> <b>Replay geometry</b><span>{report.geometry_verified} route files belong to the scenarios</span></li>
              <li><CheckCircle2 size={15} /> <b>Experiment record</b><span>{report.campaigns_verified.length} record checksum and lineage · fingerprints recomputed</span></li>
              <li><CheckCircle2 size={15} /> <b>Problem and validator</b><span>same specification and validator as this installation</span></li>
              <li><CheckCircle2 size={15} /> <b>No executable code</b><span>{report.methods.filter((m: Json) => m.available_locally).length} of {report.methods.length} methods available here</span></li></ul>}
            <p className="tiny muted">Integrity says the bundle is complete and unaltered. It does not re-run anything: reproducibility is the next step.</p>
            {!imported ? <button className="btn primary" disabled={busy || !report} onClick={doImport}><FileCheck2 size={14} /> {t('sample.import')}</button>
              : <div className="row gap"><span className="badge ok"><Check size={12} /> Imported</span><button className="btn sm" onClick={() => onOpen(root)}>Open in the workspace</button></div>}</section>
          {imported && <section className="sec"><h3><RotateCcw size={16} /> {t('ev.reproducibility')}</h3>
            {job && <JobProgress job={job} setErr={setErr} unit="runs" onFinished={() => { setJob(null); reload(); }} />}
            {!reproItem && !job && <button className="btn primary" disabled={busy} onClick={reproduce}><RotateCcw size={14} /> {t('sample.reproduce')}</button>}
            {rr && <p className={`note ${rr.reproduced ? 'ok' : 'warn'}`}><b>{rr.reproduced ? `${t('ev.reproduced')}: ${rr.cells} of ${rr.cells} results equal` : `${rr.agreement.different} of ${rr.cells} results differ`}</b>
              {' '}· identical solutions in {rr.agreement.identical_solution} of {rr.cells}. Rule: every validated metric must be equal; runtimes are reported, not required to match.</p>}
            {reproItem && <div className="row gap"><button className="btn" onClick={() => onCompare(root, reproItem.campaign_id)}><GitCompareArrows size={14} /> {t('sample.compareRepro')}</button>
              <button className="btn sm" onClick={() => onOpen(reproItem.campaign_id)}>Open the reproduction</button></div>}</section>}
          {reproItem?.status === 'completed' && <section className="sec"><h3><Puzzle size={16} /> Your method on the same frozen experiment</h3>
            {plugins.length === 0 ? <><p className="small muted">Register a method first; it then runs on exactly the same scenarios and is checked by the same validator.</p>
              <button className="btn" onClick={onAddMethod}><Puzzle size={14} /> {t('sample.addMethod')}</button></>
              : !extItem ? <button className="btn primary" disabled={busy || !!job} onClick={extend}><Puzzle size={14} /> Extend with {plugins.map((m) => m.name).join(', ')}</button>
                : <div className="row gap"><button className="btn primary" onClick={() => onCompare(root, extItem.campaign_id)}><GitCompareArrows size={14} /> Compare again</button>
                  <button className="btn" onClick={() => act(() => download(`/campaigns/${extItem.campaign_id}/export`, 'move_openlab_extension.zip'))}><Download size={14} /> Export the extension</button>
                  <button className="btn sm" onClick={() => onOpen(extItem.campaign_id)}>Open</button></div>}</section>}
        </div>
      </div>
    </div>
  </div>;
}
