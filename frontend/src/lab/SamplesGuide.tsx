import { useCallback, useEffect, useState } from 'react';
import { Check, Database, Download, FileCheck2, FlaskConical, Map as MapIcon, PackageOpen, Play, ShieldCheck, X } from 'lucide-react';
import { download, post, type Json } from '../api/client';
import { errText } from '../components/common';
import { t, tr } from '../i18n';
import type { SampleScenarioState, SampleState } from './api';
import { ScenarioPackageChecks, ScenarioPackageFacts, ScenarioPackageNote } from './ScenarioPackageReport';
import { shortSha, sizeLabel } from './samplePackages';

/** "Import ▾ → Try a sample": the two public sample packages, side by side.
 *  — Sample scenario: one frozen scenario of the Montbéliard demonstration (scenario package). Download it, import it
 *    through the normal scenario-package import (every check shown), then open it in a new experiment: choose methods, Run.
 *  — Sample experiment: an exported experiment with its validated results (experiment bundle). Its steps — download,
 *    verify, import, open, compare, reproduce — are the existing guide "Try an imported experiment".
 *  Nothing here is simulated: every report comes from the server. */
export function SamplesGuide({ scenario, experiment, onClose, onTryExperiment, onOpenNew, onTryTrips, reload, setErr }: {
  scenario: SampleScenarioState | null | undefined; experiment: SampleState | null | undefined; onClose: () => void; onTryExperiment: () => void;
  onOpenNew: (instanceHash: string, name: string, networkId: string | null) => void; onTryTrips?: () => void; reload: () => void; setErr: (s: string | null) => void;
}) {
  const [report, setReport] = useState<Json | null>(null);
  const [imported, setImported] = useState<Json | null>(null);
  const [busy, setBusy] = useState('');
  const act = useCallback(async (what: string, fn: () => Promise<unknown>) => { setErr(null); setBusy(what); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(''); } }, [setErr]);
  useEffect(() => { if (scenario?.available) act('verify', () => post('/lab/sample/scenario/verify').then(setReport)); }, [act, scenario?.available]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const inLibrary = !!(imported?.scenario_id || scenario?.scenario_id || report?.in_library);
  const rep = imported ?? report;
  const doImport = () => act('import', async () => { const r = await post('/lab/sample/scenario'); setImported(r); setReport(r); reload(); });
  const open = () => rep && onOpenNew(rep.scenario.instance_hash, rep.scenario.name, rep.scenario.network_id ?? null);
  return <div className="overlay" role="dialog" aria-label={tr('Try a sample')} onClick={onClose}>
    <div className="drawer samples-guide" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><PackageOpen size={18} /><div className="grow"><h2>{tr('Try a sample')}</h2>
        <div className="small muted">{tr('Two public packages to try MOVE OpenLab without your own data: a scenario to run methods on, and an experiment with validated results to reproduce.')}</div></div>
        <button className="btn icon ghost" aria-label={tr('close')} onClick={onClose}><X size={16} /></button></div>
      <div className="sample-cards">
        <section className="card sample-card" data-sample="scenario" aria-label={tr('Sample scenario')}>
          <div className="row gap"><MapIcon size={16} /><h3 className="grow">{tr('Sample scenario')}</h3><span className="badge">{tr('scenario package')}</span></div>
          {!scenario?.available ? <p className="small muted">{tr('The sample scenario is not available in this installation.')}</p> : <>
            <p className="small muted">{tr('{name}: {d} drivers and {r} riders of the public Montbéliard demonstration, frozen with its travel times and route geometry. Import it, then choose methods and run them: every run is checked by the independent validator.',
              { name: scenario.title ?? '', d: scenario.drivers ?? 0, r: scenario.riders ?? 0 })}</p>
            <div className="row gap wrap"><button className="btn" disabled={!!busy} onClick={() => act('download', () => download('/lab/sample/scenario', scenario.filename ?? 'sample_scenario.zip'))}><Download size={14} /> {tr('Download sample scenario')}</button>
              <span className="tiny muted mono" title={scenario.sha256}>{scenario.filename} · {sizeLabel(scenario.bytes)} · SHA-256 {shortSha(scenario.sha256)}</span></div>
            <h4 className="row gap"><ShieldCheck size={14} /> {t('ev.integrity')}</h4>
            {!rep ? <p className="small muted">{busy === 'verify' ? tr('Verifying…') : tr('Not verified yet.')}</p> : <>
              <ScenarioPackageChecks rep={rep} />
              <details className="pkg-more"><summary className="small">{tr('Provenance and licences')}</summary><ScenarioPackageFacts rep={rep} /></details>
              <ScenarioPackageNote rep={rep} /></>}
            <div className="row gap wrap">
              {!inLibrary ? <button className="btn primary" disabled={!!busy || !report} onClick={doImport}><FileCheck2 size={14} /> {busy === 'import' ? tr('Importing…') : tr('Import the sample scenario')}</button>
                : <span className="badge ok"><Check size={12} /> {imported?.already_present === false ? tr('Imported into your scenario library') : tr('In your scenario library')}</span>}
              <button className="btn" disabled={!inLibrary || !rep} onClick={open}><Play size={14} /> {tr('Open it in a new experiment')}</button></div>
            <p className="tiny muted">{tr('In the new experiment: tick the scenario (left), tick the methods (right), press Run. Results, routes and validation appear in the Workspace.')}</p></>}
        </section>
        <section className="card sample-card" data-sample="experiment" aria-label={tr('Sample experiment')}>
          <div className="row gap"><FlaskConical size={16} /><h3 className="grow">{tr('Sample experiment')}</h3><span className="badge">{tr('experiment bundle')}</span></div>
          {!experiment?.available ? <p className="small muted">{t('sample.unavailable')}</p> : <>
            <p className="small muted">{tr('{title}: an experiment exported by another researcher, with {runs} validated runs on {n} frozen scenarios. Its results are imported and archived — shown as imported, never as executed here — until you reproduce them.',
              { title: experiment.title ?? '', runs: experiment.runs ?? 0, n: experiment.scenarios ?? 0 })}</p>
            <div className="row gap wrap"><button className="btn" onClick={() => act('download-b', () => download('/lab/sample/bundle', experiment.filename ?? 'sample_experiment.zip'))}><Download size={14} /> {t('sample.download')}</button>
              <span className="tiny muted mono" title={experiment.sha256}>{experiment.filename} · {sizeLabel(experiment.bytes)} · SHA-256 {shortSha(experiment.sha256)}</span></div>
            <ol className="sample-steps small">
              <li>{t('sample.download')}</li><li>{t('sample.verify')}</li><li>{t('sample.import')}</li><li>{tr('Open in the workspace')}</li>
              <li>{t('ws.compare')}</li><li>{t('sample.reproduce')}</li><li>{t('sample.compareRepro')}</li></ol>
            <div className="row gap wrap"><button className="btn primary" onClick={onTryExperiment}><PackageOpen size={14} /> {t('sample.title')}</button>
              {experiment.imported && <span className="badge ok"><Check size={12} /> {tr('Imported')}</span>}</div></>}
        </section>
      </div>
      {onTryTrips && <p className="tiny muted row gap wrap samples-foot"><Database size={13} /> {tr('Mobility data instead of a scenario? The sample trip dataset is a CSV file to generate scenarios from.')}
        <button className="btn link small" onClick={onTryTrips}>{tr('Try the sample trip dataset')}</button></p>}
    </div>
  </div>;
}
