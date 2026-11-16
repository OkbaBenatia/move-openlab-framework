import { useCallback, useEffect, useState } from 'react';
import { Check, CheckCircle2, Download, FileCheck2, GitCompareArrows, PackageOpen, Puzzle, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { download, post, type Json, type MethodRef } from '../api/client';
import { JobProgress } from '../components/JobProgress';
import { errText } from '../components/common';
import { t, tr } from '../i18n';
import { lab, type ExpItem, type SampleState } from './api';

type Step = 'download' | 'import' | 'verify' | 'reproduce' | 'compare' | 'method' | 'extend';
/** The steps of the guide, read while rendering so that their labels follow the interface language. */
const steps = (): [Step, string][] => [['download', t('sample.download')], ['import', t('sample.import')], ['verify', t('sample.verify')], ['reproduce', tr('Reproduce')],
  ['compare', t('sample.compareRepro')], ['method', t('sample.addMethod')], ['extend', tr('Extend · compare again · export')]];

/** "Try an imported experiment": the public sample bundle through the real path — download, import (full verification),
 *  independent re-execution, reproducibility, then your own method on the same frozen experiment. Every result shown here
 *  comes from the server; nothing is simulated. */
export function ImportGuide({ sample, experiments, methods, onClose, onOpen, onCompare, onAddMethod, reload, setErr }: {
  sample: SampleState; experiments: ExpItem[]; methods: MethodRef[]; onClose: () => void; onOpen: (cid: string) => void;
  onCompare: (a: string, b: string) => void; onAddMethod: () => void; reload: () => Promise<unknown>; setErr: (s: string | null) => void;
}) {
  const STEPS = steps();
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
      <div className="row gap drawer-head"><PackageOpen size={18} /><h2 className="grow">{t('sample.title')}</h2><button className="btn icon ghost" aria-label={tr('close')} onClick={onClose}><X size={16} /></button></div>
      <div className="guide-grid">
        <ol className="rail" aria-label={tr('steps')}>{STEPS.map(([s, label]) => <li key={s} className={done[s] ? 'done' : s === current ? 'current' : ''}><span className="dotnum">{done[s] ? <Check size={13} /> : STEPS.findIndex(([x]) => x === s) + 1}</span>{label}</li>)}</ol>
        <div className="guide-body">
          <section className="sec"><h3>{sample.title}</h3>
            <p className="small muted">{tr('A frozen experiment exported by “Researcher A” from the Montbéliard demonstration: {scenarios} scenarios, {runs} runs, bundle format {format}. Its cross-installation check (import, re-execution, extension) last succeeded on {date}.',
              { scenarios: sample.scenarios ?? '', runs: sample.runs ?? '', format: sample.format ?? '', date: sample.check ? new Date(sample.check.checked_at).toLocaleDateString() : '—' })}</p>
            <div className="row gap"><button className="btn" onClick={() => act(() => download('/lab/sample/bundle', sample.filename ?? 'sample.zip'))}><Download size={14} /> {t('sample.download')}</button>
              <span className="small muted mono">{sample.filename} · {((sample.bytes ?? 0) / 1e6).toFixed(2)} MB · SHA-256 {sample.sha256?.slice(0, 12)}…</span></div></section>
          <section className="sec"><h3><ShieldCheck size={16} /> {t('ev.integrity')}</h3>
            {!report ? <p className="small muted">{tr('Verifying…')}</p> : <ul className="checks">
              <li><CheckCircle2 size={15} /> <b>{tr('Archive and manifest')}</b><span>{tr('manifest digest matches · {n} files, each checksum matches', { n: report.files_checked })}</span></li>
              <li><CheckCircle2 size={15} /> <b>{tr('Scenarios')}</b><span>{tr("{n} scenario files pass the problem's integrity checks", { n: report.instances_verified })}</span></li>
              <li><CheckCircle2 size={15} /> <b>{tr('Replay geometry')}</b><span>{tr('{n} route files belong to the scenarios', { n: report.geometry_verified })}</span></li>
              <li><CheckCircle2 size={15} /> <b>{tr('Experiment record')}</b><span>{tr('{n} record checksum and lineage · fingerprints recomputed', { n: report.campaigns_verified.length })}</span></li>
              <li><CheckCircle2 size={15} /> <b>{tr('Problem and validator')}</b><span>{tr('same specification and validator as this installation')}</span></li>
              <li><CheckCircle2 size={15} /> <b>{tr('No executable code')}</b><span>{tr('{n} of {m} methods available here', { n: report.methods.filter((m: Json) => m.available_locally).length, m: report.methods.length })}</span></li></ul>}
            <p className="tiny muted">{tr('Integrity says the bundle is complete and unaltered. It does not re-run anything: reproducibility is the next step.')}</p>
            {!imported ? <button className="btn primary" disabled={busy || !report} onClick={doImport}><FileCheck2 size={14} /> {t('sample.import')}</button>
              : <div className="row gap"><span className="badge ok"><Check size={12} /> {tr('Imported')}</span><button className="btn sm" onClick={() => onOpen(root)}>{tr('Open in the workspace')}</button></div>}</section>
          {imported && <section className="sec"><h3><RotateCcw size={16} /> {t('ev.reproducibility')}</h3>
            {job && <JobProgress job={job} setErr={setErr} unit="runs" onFinished={() => { setJob(null); reload(); }} />}
            {!reproItem && !job && <button className="btn primary" disabled={busy} onClick={reproduce}><RotateCcw size={14} /> {t('sample.reproduce')}</button>}
            {rr && <p className={`note ${rr.reproduced ? 'ok' : 'warn'}`}><b>{rr.reproduced ? `${t('ev.reproduced')}: ${tr('{n} of {m} results equal', { n: rr.cells, m: rr.cells })}` : tr('{n} of {m} results differ', { n: rr.agreement.different, m: rr.cells })}</b>
              {' '}· {tr('identical solutions in {n} of {m}. Rule: every validated metric must be equal; runtimes are reported, not required to match.', { n: rr.agreement.identical_solution, m: rr.cells })}</p>}
            {reproItem && <div className="row gap"><button className="btn" onClick={() => onCompare(root, reproItem.campaign_id)}><GitCompareArrows size={14} /> {t('sample.compareRepro')}</button>
              <button className="btn sm" onClick={() => onOpen(reproItem.campaign_id)}>{tr('Open the reproduction')}</button></div>}</section>}
          {reproItem?.status === 'completed' && <section className="sec"><h3><Puzzle size={16} /> {tr('Your method on the same frozen experiment')}</h3>
            {plugins.length === 0 ? <><p className="small muted">{tr('Register a method first; it then runs on exactly the same scenarios and is checked by the same validator.')}</p>
              <button className="btn" onClick={onAddMethod}><Puzzle size={14} /> {t('sample.addMethod')}</button></>
              : !extItem ? <button className="btn primary" disabled={busy || !!job} onClick={extend}><Puzzle size={14} /> {tr('Extend with {methods}', { methods: plugins.map((m) => m.name).join(', ') })}</button>
                : <div className="row gap"><button className="btn primary" onClick={() => onCompare(root, extItem.campaign_id)}><GitCompareArrows size={14} /> {tr('Compare again')}</button>
                  <button className="btn" onClick={() => act(() => download(`/campaigns/${extItem.campaign_id}/export`, 'move_openlab_extension.zip'))}><Download size={14} /> {tr('Export the extension')}</button>
                  <button className="btn sm" onClick={() => onOpen(extItem.campaign_id)}>{tr('Open')}</button></div>}</section>}
        </div>
      </div>
    </div>
  </div>;
}
