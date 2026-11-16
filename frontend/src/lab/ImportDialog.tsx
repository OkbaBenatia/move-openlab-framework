import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, FileArchive, FileCheck2, PackageOpen, RotateCcw, Upload, X, XCircle } from 'lucide-react';
import { call, type Json } from '../api/client';
import { errText } from '../components/common';
import { t, tr } from '../i18n';
import { BASELINE_LABEL, SCOPE_LABEL } from '../mobility/api';
import { isScenarioReport } from './samplePackages';
import { ScenarioPackageChecks, ScenarioPackageFacts, ScenarioPackageNote } from './ScenarioPackageReport';

type Step = 'choose' | 'inspect' | 'contents' | 'verify' | 'confirm';
const STEPS: [Step, string][] = [['choose', 'Choose file'], ['inspect', 'Inspect package'], ['contents', 'What will be imported'],
  ['verify', 'Integrity and compatibility'], ['confirm', 'Confirm import']];
const kindLabel: Record<string, string> = { baseline: 'Baseline', variant: 'Controlled variant', reproduction: 'Re-execution', extended: 'Extension', 'threshold-study': 'Threshold study' };
const presence: Record<string, [string, string]> = { new: ['New here', 'ok'], identical: ['Already here (identical)', ''], different: ['Conflict', 'bad'] };

/** Import, in stages: choose a file, inspect it on the server (complete verification, nothing written), see what it
 *  contains and what importing would do here, then confirm. Nothing is stored before "Import experiment". The server
 *  reads the manifest: an experiment bundle keeps this path; a scenario package (move-openlab-scenario/1) is verified by
 *  the scenario importer and, on "Import scenario", lands in the scenario library. */
export function ImportDialog({ onClose, onImported, onReproduce, onScenarioImported, sampleAvailable, setErr }: {
  onClose: () => void; onImported: (rootId: string, note: string) => void; onReproduce: (cid: string) => void;
  onScenarioImported?: (rep: Json) => void; sampleAvailable: boolean; setErr: (s: string | null) => void;
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
  const isScenario = isScenarioReport(rep);
  const confirmScenario = async () => {
    if (!file || !rep) return;
    setBusy('import');
    const fd = new FormData(); fd.append('file', file);
    try { const r = await call('/geo/scenario-packages/import', { method: 'POST', body: fd }); onScenarioImported?.(r); }
    catch (e) { setErr(tr('Import refused: {reason}', { reason: errText(e) })); } finally { setBusy(''); }
  };
  const confirm = async () => {
    if (!file || !rep) return;
    if (isScenario) return confirmScenario();
    setBusy('import');
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await call('/import', { method: 'POST', body: fd });
      onImported(r.root_campaign_id, `${t('ev.integrity')}: ${tr('{n} files from {name}, no executable code. Use Run again to reproduce it here.', { n: r.files_checked, name: r.exported_by })}`);
    } catch (e) { setErr(tr('Import refused: {reason}', { reason: errText(e) })); } finally { setBusy(''); }
  };
  const root = rep?.campaigns_verified?.find((c: Json) => c.campaign_id === rep.root_campaign_id);
  const current: Step = !file ? 'choose' : busy === 'inspect' ? 'inspect' : rep ? 'confirm' : 'inspect';
  const done = (s: Step) => STEPS.findIndex(([x]) => x === s) < STEPS.findIndex(([x]) => x === current) || (!!rep && s !== 'confirm');
  const ok = (v: boolean) => (v ? <CheckCircle2 size={15} className="ok-text" /> : <XCircle size={15} className="bad-text" />);
  return <div className="overlay" role="dialog" aria-label={tr('import experiment')} onClick={onClose}>
    <div className="drawer guide importd" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><PackageOpen size={18} /><div className="grow"><h2>{isScenario ? tr('Import scenario') : tr('Import experiment')}</h2>
        <div className="small muted">{tr('Check a bundle completely, see what it contains, then decide. Nothing is stored before you confirm.')}</div></div>
        <button className="btn icon ghost" aria-label={tr('close')} onClick={onClose}><X size={16} /></button></div>
      <div className="guide-grid">
        <ol className="rail" aria-label={tr('import steps')}>{STEPS.map(([s, label], i) => <li key={s} className={done(s) ? 'done' : s === current ? 'current' : ''}>
          <span className="dotnum">{done(s) ? <Check size={13} /> : i + 1}</span>{tr(label)}</li>)}</ol>
        <div className="guide-body">
          <section className="sec"><h3><FileArchive size={16} /> {tr('Bundle file')}</h3>
            <div className={`dropzone ${file ? 'has' : ''}`} onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) inspect(f); }}>
              {file ? <span className="row gap"><FileArchive size={16} /><b className="mono small">{file.name}</b><span className="small muted">{(file.size / 1e6).toFixed(2)} MB</span></span>
                : <span className="small muted">{tr('Drop an experiment bundle or a scenario package (.zip) here, or choose it.')}</span>}
              <span className="row gap"><button className="btn sm" onClick={() => input.current?.click()}><Upload size={13} /> {file ? tr('Choose another file') : tr('Choose a bundle file')}</button>
                {sampleAvailable && !file && <button className="btn sm ghost" onClick={sample}>{tr('Use the public sample bundle')}</button>}</span>
              <input ref={input} type="file" accept=".zip" hidden aria-label={tr('bundle file to inspect')} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) inspect(f); }} />
            </div>
            {busy === 'inspect' && <p className="small muted">{tr('Inspecting: checking every checksum, fingerprint and record… nothing is stored.')}</p>}
            {failure && <p className="note bad small" role="alert"><b>{tr('This bundle cannot be imported.')}</b> {failure}</p>}</section>
          {rep && isScenario && <>
            <section className="sec"><h3>{tr('Scenario package')}</h3><ScenarioPackageFacts rep={rep} /></section>
            <section className="sec"><h3><FileCheck2 size={16} /> {tr('Integrity and compatibility')}</h3><ScenarioPackageChecks rep={rep} /><ScenarioPackageNote rep={rep} />
              {rep.in_library && <p className="note small">{tr('Already in your scenario library: importing again adds nothing.')}</p>}</section>
            <div className="row gap drawer-foot"><span className="small muted grow">{tr('The scenario goes to your scenario library; then choose it in a new experiment with the methods to run.')}</span>
              <button className="btn" onClick={onClose}>{tr('Cancel')}</button>
              <button className="btn primary" disabled={!!busy} onClick={confirm}><FileCheck2 size={14} /> {busy === 'import' ? tr('Importing…') : tr('Import scenario')}</button></div>
          </>}
          {rep && !isScenario && <>
            <section className="sec"><h3>{tr('Package')}</h3>
              <dl className="facts">
                <dt>{tr('Experiment')}</dt><dd><b>{root?.title}</b> · {tr(String(kindLabel[root?.kind] ?? root?.kind ?? ''))}</dd>
                <dt>{tr('Exported by')}</dt><dd>{rep.exported_by}{rep.created_at ? ` · ${new Date(rep.created_at).toLocaleString()}` : ''} · {tr('installation {id}', { id: String(rep.exporter_installation).slice(0, 12) })}</dd>
                <dt>{tr('Format')}</dt><dd>{rep.format} · {(rep.bytes / 1e6).toFixed(2)} MB · SHA-256 <span className="mono">{rep.bundle_sha256.slice(0, 16)}…</span></dd>
                <dt>{tr('Problem')}</dt><dd>{rep.problem_title ?? rep.problem_id}</dd></dl></section>
            <section className="sec"><h3>{tr('What will be imported')}</h3>
              <table className="compact" aria-label={tr('records in the bundle')}><thead><tr><th>{tr('Record')}</th><th>{tr('Kind')}</th><th className="n">{tr('Runs accepted')}</th><th>{tr('Here')}</th></tr></thead>
                <tbody>{rep.campaigns_verified.map((c: Json) => <tr key={c.campaign_id}><td>{c.title}</td><td className="small">{tr(kindLabel[c.kind] ?? c.kind)}{c.relation ? ` · ${tr(String(c.relation))}` : ''}</td>
                  <td className="n">{c.accepted} / {c.runs}</td><td><span className={`badge ${presence[rep.present[c.campaign_id]]?.[1] ?? ''}`}>{tr(presence[rep.present[c.campaign_id]]?.[0] ?? '')}</span></td></tr>)}</tbody></table>
              <dl className="facts">
                <dt>{tr('Scenarios')}</dt><dd>{rep.instances_verified === 1 ? tr('{n} frozen scenario', { n: rep.instances_verified }) : tr('{n} frozen scenarios', { n: rep.instances_verified })}{rep.scenarios?.length ? ` (${rep.scenarios.slice(0, 2).map((s: Json) => s.name ?? s.instance_id).join(' · ')}${rep.scenarios.length > 2 ? ' · …' : ''})` : ''}</dd>
                <dt>{tr('Area and road network')}</dt><dd>{rep.networks.length ? rep.networks.map((n: Json) => `OpenStreetMap${n.osm_timestamp ? ` ${n.osm_timestamp.slice(0, 10)}` : ''} · ${tr('{profile} profile', { profile: n.profile ?? 'car' })}${n.licence?.id ? ` · ${n.licence.id}` : ''}`).join('; ') : tr('none (no geography)')}</dd>
                <dt>{tr('Mobility data')}</dt><dd>{rep.datasets.length ? rep.datasets.map((d: Json) => `${d.provider === 'rpc' || d.release ? `RPC ${d.release}` : d.provider}${d.licence?.name ? ` · ${d.licence.name}` : ''}`).join('; ') : tr('synthetic or placed participants')}</dd>
                <dt>{tr('Methods')}</dt><dd>{rep.methods.map((m: Json) => <span key={`${m.method_id}${m.version}`} className={`badge ${m.available_locally ? 'ok' : 'warn'}`} title={m.reason ?? tr('available on this installation')}>{m.method_id} {m.version}{m.available_locally ? '' : ` · ${tr('not here')}`}</span>)}</dd>
                <dt>{tr('Vehicles and CO₂')}</dt><dd>{rep.vehicles ? tr('{n} vehicle profiles', { n: rep.vehicles }) : tr('no vehicle data')}{rep.emissions?.length ? ` · ${tr('CO₂: {scope}, baseline {baseline}', { scope: tr(SCOPE_LABEL[rep.emissions[0].scope] ?? rep.emissions[0].scope), baseline: tr(BASELINE_LABEL[rep.emissions[0].baseline] ?? rep.emissions[0].baseline).toLowerCase() })}` : ''}</dd>
                <dt>{tr('Replay geometry')}</dt><dd>{rep.geometry_verified ? tr('{n} route files', { n: rep.geometry_verified }) : tr('none')}</dd>
                <dt>{tr('Evidence report')}</dt><dd>{rep.evidence ? `${tr('included · matches the bundle')}${rep.evidence.generated_by ? ` · ${tr('by {name}', { name: rep.evidence.generated_by })}` : ''}` : tr('not included')}</dd>
                <dt>{tr('ML evaluation evidence')}</dt><dd data-ml-import={rep.ml_evaluations ? `${rep.ml_evaluations.recomputed}/${rep.ml_evaluations.references}` : 'none'}>{!rep.ml_evaluations ? tr('not included')
                  : [rep.ml_evaluations.recomputed ? tr(rep.ml_evaluations.recomputed === 1 ? '{n} document re-validated, every figure recomputed and identical' : '{n} documents re-validated, every figure recomputed and identical', { n: rep.ml_evaluations.recomputed }) : '',
                    rep.ml_evaluations.references ? tr(rep.ml_evaluations.references === 1 ? '{n} reference only: figures as recorded by the exporter, not recomputable here' : '{n} references only: figures as recorded by the exporter, not recomputable here', { n: rep.ml_evaluations.references }) : ''].filter(Boolean).join(' · ')}</dd></dl></section>
            <section className="sec"><h3><FileCheck2 size={16} /> {tr('Integrity and compatibility')}</h3>
              <ul className="checks">
                <li>{ok(true)} <b>{t('ev.integrity')}</b><span>{tr('{n} files, each checksum matches; manifest digest matches', { n: rep.files_checked })}</span></li>
                <li>{ok(true)} <b>{tr('Records and lineage')}</b><span>{rep.campaigns_verified.length === 1 ? tr('{n} record checksum · fingerprints recomputed', { n: rep.campaigns_verified.length }) : tr('{n} record checksums · fingerprints recomputed', { n: rep.campaigns_verified.length })}</span></li>
                <li>{ok(true)} <b>{tr('Problem and validator')}</b><span>{tr('same specification and validator as this installation')}</span></li>
                <li>{ok(true)} <b>{tr('No executable code')}</b><span>{tr('methods are identified by id, version and code digest')}</span></li>
                <li>{ok(rep.importable)} <b>{tr('Importable')}</b><span>{rep.importable ? (rep.adds ? (rep.adds === 1 ? tr('{n} new record will be added; nothing is overwritten', { n: rep.adds }) : tr('{n} new records will be added; nothing is overwritten', { n: rep.adds })) : tr('already in your workspace — nothing to add')) : tr('a different record with the same identifier exists here')}</span></li>
                <li>{ok(rep.reproducible_here)} <b>{tr('Reproducible here')}</b><span>{rep.reproducible_here ? tr('every method is available: Run again re-executes it on these frozen scenarios') : tr('some methods are missing here (see Methods)')}</span></li>
                <li>{ok(true)} <b>{tr('Comparable')}</b><span>{tr(String(rep.comparable ?? ''))}</span></li></ul>
              {rep.warnings.map((w: string) => <p key={w} className="note warn small row gap"><AlertTriangle size={13} /> {tr(w)}</p>)}</section>
            <div className="row gap drawer-foot"><span className="small muted grow">{tr('Integrity says the bundle is complete and unaltered; reproducing it is the next step.')}</span>
              <button className="btn" onClick={onClose}>{tr('Cancel')}</button>
              {rep.adds === 0 && rep.importable ? <button className="btn primary" disabled={!!busy || !rep.reproducible_here} onClick={() => onReproduce(rep.root_campaign_id)}><RotateCcw size={14} /> {tr('Reproduce it here')}</button>
                : <button className="btn primary" disabled={!!busy || !rep.importable} onClick={confirm}><FileCheck2 size={14} /> {busy === 'import' ? tr('Importing…') : tr('Import experiment')}</button>}</div>
          </>}
        </div>
      </div>
    </div>
  </div>;
}
