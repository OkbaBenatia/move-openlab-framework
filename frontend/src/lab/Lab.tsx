import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, GitCompareArrows, PackageOpen, Play, Plus, X } from 'lucide-react';
import { call, download, post, type Json } from '../api/client';
import { TraceDrawer } from '../components/TraceDrawer';
import { ErrorNote, errText } from '../components/common';
import { COLORS, LeafletMap, type MapPoint } from '../geo/LeafletMap';
import { geo } from '../geo/api';
import { instanceLayers } from '../geo/GeoWorkbench';
import { t } from '../i18n';
import { Wizard } from '../mobility/Wizard';
import { AddMethod } from './AddMethod';
import { ComparePicker } from './ComparePicker';
import type { Section } from '../router';
import { lab, rowKey, scopeMethods, type Experiment, type LabState } from './api';
import { Charts } from './Charts';
import { ALL_AREAS } from './ExperimentPicker';
import { ImportGuide } from './ImportGuide';
import { MAP, planLayers, planPositions } from './layers';
import { ReplayBar, useReplay } from './ReplayBar';
import { ResultPanel, methodKey, type RunOptions, type Scope } from './ResultPanel';
import { NewExperimentPanel, ScenarioPanel } from './ScenarioPanel';
import { NEW, TopBar } from './TopBar';
import { Tour } from './Tour';
import { RIDE, useLabData, useMethods } from './useLabData';

export const OPEN_WIZARD = 'move-openlab.open-wizard';
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

/** The Workspace: choose or load an experiment, inspect it on the map, run methods, see validated results in an explicit
 *  scope, compare, replay, share. The Generate wizard, the comparison selection, Add method and the sample-bundle guide
 *  open over it. */
export function Lab({ cid, go, tourKey = 0 }: { cid: string; go: (s: Section, arg?: string, replace?: boolean) => void; tourKey?: number }) {
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { cfg, areas, datasets, experiments, lib, problems, reloadExperiments, reloadLists } = useLabData(setErr);
  const [st, setSt] = useState<LabState | null>(null);
  const [areaFilter, setAreaFilter] = useState(ALL_AREAS);
  const [exp, setExp] = useState<Experiment | null>(null);
  const [hash, setHash] = useState('');
  const [inst, setInst] = useState<Json | null>(null);
  const [selected, setSelected] = useState('');
  const [plan, setPlan] = useState<Json | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [job, setJob] = useState<Json | null>(null);
  const [jobTarget, setJobTarget] = useState('');
  const [opts, setOpts] = useState<RunOptions>({ repetitions: 3, variant: '' });
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState(`Experiment ${stamp()}`);
  const [picker, setPicker] = useState(false);
  const [addMethod, setAddMethod] = useState(false);
  const [guide, setGuide] = useState(false);
  const [methodsKey, setMethodsKey] = useState(0);
  const [replaying, setReplaying] = useState(false);
  const [tour, setTour] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [trace, setTrace] = useState<string | null>(null);
  const [lastJob, setLastJob] = useState<string | null>(null);
  const [panel, setPanel] = useState<'left' | 'right' | null>(null);
  const [scope, setScope] = useState<Scope>('scenario');
  const [focus, setFocus] = useState<{ key: string; bbox: [number, number, number, number] } | null>(null);
  const isNew = cid === NEW;
  const problemId = exp?.campaign.problem_id ?? RIDE;
  const methods = useMethods(problemId, setErr, methodsKey);
  const problem = problems.find((p) => p.spec.problem_id === problemId);
  const replay = useReplay(plan, replaying);
  const [busy, setBusy] = useState(false);
  const act = useCallback(async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(errText(e)); } }, []);
  const busyRef = useRef(false);                 // synchronous guard: a double click starts one run only
  const once = (fn: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    return act(fn).finally(() => { busyRef.current = false; setBusy(false); });
  };

  // first use: the demonstration is imported once into this workspace and opened; new accounts start on its area
  useEffect(() => {
    act(async () => {
      let s = await lab.state();
      if (s.demo.available && (!s.demo.installed || s.demo.area == null)) {
        setNotice('Loading the demonstration experiment…');
        try { await lab.installDemo(); s = await lab.state(); reloadLists(); } catch (e) { setErr(errText(e)); } finally { setNotice(null); }
      }
      const list = await reloadExperiments();
      const last = list.find((x) => x.campaign_id === s.preferences.last_experiment && !x.hidden)
        ?? list.find((x) => x.demo && x.kind === 'baseline' && !x.hidden) ?? list[list.length - 1];
      setAreaFilter(last?.area ?? list.find((x) => x.demo)?.area ?? ALL_AREAS);
      if (!cid && last) go('workspace', last.campaign_id, true);
      setSt(s);
      try { if (sessionStorage.getItem(OPEN_WIZARD)) { sessionStorage.removeItem(OPEN_WIZARD); setWizard(true); } } catch { /* storage unavailable */ }
    });
  }, []);                                                                    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tourKey > 0) setTour(true); }, [tourKey]);
  // the Workspace always shows an experiment: without one in the address, reopen the last one (or the demonstration)
  useEffect(() => {
    if (cid || !st || !experiments.length) return;
    const last = experiments.find((x) => x.campaign_id === st.preferences.last_experiment && !x.hidden)
      ?? experiments.find((x) => x.demo && x.kind === 'baseline' && !x.hidden) ?? experiments[experiments.length - 1];
    if (last) go('workspace', last.campaign_id, true);
  }, [cid, st, experiments, go]);

  // responses for an experiment that is no longer the current one are ignored
  const cidRef = useRef(cid);
  cidRef.current = cid;
  const loadExp = useCallback((id: string) => lab.experiment(id).then((e) => {
    if (cidRef.current !== id) return;
    setExp(e);
    lab.prefs({ last_experiment: id }).catch(() => { /* preference only */ });
    setHash((h) => (e.scenarios.some((s) => s.instance_hash === h) ? h : e.scenarios[0]?.instance_hash ?? ''));
    setChecked(scopeMethods(e));
    const rows = e.results?.rows ?? [];
    const pick = rows.find((r) => r.campaign_id === id && r.method_id === e.results?.reference?.method_id) ?? rows.find((r) => r.campaign_id === id) ?? rows[0];
    setSelected((k) => (rows.some((r) => rowKey(r) === k) ? k : pick ? rowKey(pick) : ''));
  }).catch((x) => { if (cidRef.current === id) { setExp(null); setErr(errText(x)); } }), []);
  useEffect(() => {
    setReplaying(false); setPlan(null);
    if (!cid || isNew) { setExp(null); setInst(null); return; }
    loadExp(cid);
  }, [cid, isNew, loadExp]);
  useEffect(() => { if (isNew) setChecked(methods.filter((m) => m.source === 'builtin').map(methodKey)); }, [isNew, methods]);
  useEffect(() => { if (problem?.variants.length && !opts.variant) setOpts((o) => ({ ...o, variant: problem.variants.find((v) => v.instance_level)?.id ?? problem.variants[0].id })); }, [problem, opts.variant]);
  useEffect(() => {
    let live = true;
    setInst(null);
    if (hash && exp?.campaign.problem_id === RIDE) geo.instance(hash).then((i) => live && setInst(i)).catch((e) => live && setErr(errText(e)));
    return () => { live = false; };
  }, [hash, exp?.campaign.problem_id]);
  useEffect(() => {
    let live = true;
    setPlan(null);
    const run = exp?.runs.find((r) => r.instance_hash === hash && rowKey(r) === selected);
    if (exp && run && exp.campaign.problem_id === RIDE) geo.playback(run.campaign_id, run.run_id).then((p) => live && setPlan(p)).catch((e) => live && setErr(errText(e)));
    return () => { live = false; };
  }, [exp, hash, selected]);

  const hiddenIds = useMemo(() => st?.preferences.hidden_ids ?? [], [st]);
  const current = experiments.find((x) => x.campaign_id === cid) ?? null;
  const area = areas.find((a) => a.name === areaFilter) ?? null;
  const shownLib = useMemo(() => (area ? lib.filter((s) => s.network_id === area.network_id) : lib).filter((s) => !hiddenIds.includes(s.scenario_id)), [lib, area, hiddenIds]);
  const toggleHidden = () => act(async () => {
    const next = hiddenIds.includes(cid) ? hiddenIds.filter((x) => x !== cid) : [...hiddenIds, cid];
    setSt(await lab.prefs({ hidden_ids: next })); await reloadExperiments();
  });

  // map layers: routes of the selected method, else the scenario's participants, else the chosen area
  const { points, lines } = useMemo(() => (plan ? planLayers(plan) : instanceLayers(inst, false)), [plan, inst]);
  const dynamic: MapPoint[] = replaying && plan ? planPositions(plan, replay.t) : [];
  const rects = isNew && area ? [{ bbox: area.bbox, color: COLORS.area }] : [];

  // run: new experiment -> create; draft -> execute; locked -> re-execute (same methods) or extend (added methods)
  const execute = async (target: string) => { const j = await post(`/campaigns/${target}/execute`); setJobTarget(target); setJob(j); };
  const derive = (kind: 'reproduce' | 'extend') => once(async () => {
    const added = checked.filter((k) => !(exp ? scopeMethods(exp) : []).includes(k)).map((k) => k.split('@'));
    const r = kind === 'extend' ? await post(`/campaigns/${cid}/extend`, { methods: added }) : await post(`/campaigns/${cid}/reproduce`);
    await execute(r.campaign_id);
  });
  const run = () => {
    setNotice(null);                                  // a notice about the previous step is stale once a run starts
    if (isNew) return once(async () => {
      const c = await post('/campaigns', { problem_id: RIDE, title, scenario_params: { instance_hashes: picked }, methods: checked.map((k) => k.split('@')), repetitions: opts.repetitions, timeout_s: 120 });
      await execute(c.campaign_id);
    });
    if (!exp) return;
    if (exp.campaign.locked) return derive(checked.some((k) => !scopeMethods(exp).includes(k)) ? 'extend' : 'reproduce');
    if (exp.campaign.status === 'draft') return once(() => execute(cid));
  };
  const runBlocked = !!job || busy || (isNew ? !picked.length || !checked.length : !exp || (!exp.campaign.locked && exp.campaign.status !== 'draft'));
  const runTitle = isNew ? 'Choose scenarios and methods' : exp?.campaign.locked ? 'Re-executes this frozen experiment (or extends it with the methods you added)' : exp && exp.campaign.status === 'completed' ? 'Lock the results first' : '';
  const jobDone = (j: Json) => {
    setJob(null); setLastJob(j.job_id); reloadExperiments().catch(() => { /* list refresh only */ });
    const now = cidRef.current;
    if (jobTarget && jobTarget !== now) go('workspace', jobTarget); else if (now && now !== NEW) loadExp(now);
  };
  const exportBundle = () => act(async () => {
    if (!exp) return;
    if (!exp.campaign.locked) {
      if (!window.confirm('Export locks this experiment: its results can no longer change. Continue?')) return;
      await post(`/campaigns/${cid}/lock`); await loadExp(cid);
    }
    await download(`/campaigns/${cid}/export`, `move_openlab_${exp.campaign.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}.zip`);
  });
  const importBundle = (f: File) => act(async () => {
    const fd = new FormData(); fd.append('file', f);
    try {
      const rep = await call('/import', { method: 'POST', body: fd });
      await reloadExperiments(); reloadLists();
      setNotice(`${t('ev.integrity')}: ${rep.files_checked} files from ${rep.exported_by}, no executable code. Run again to reproduce it here.`);
      go('workspace', rep.root_campaign_id);
    } catch (e) { throw new Error(`Bundle rejected: ${errText(e)}`); }
  });
  const variant = () => once(async () => { const r = await post(`/campaigns/${cid}/variant`, { variant: opts.variant }); await execute(r.campaign_id); });
  const parentTitle = exp?.campaign.parent ? experiments.find((x) => x.campaign_id === exp.campaign.parent!.campaign_id)?.title ?? null : null;
  const geographic = !exp || exp.campaign.problem_id === RIDE;
  const traceId = job ? null : exp?.job_id ?? lastJob;
  const variantOf = (id: string) => experiments.find((x) => x.parent === id && x.kind === 'variant' && !x.hidden);
  const showStart = !!st && !st.preferences.start_dismissed && !!current?.demo && !!exp?.results;
  const dismissStart = () => lab.prefs({ start_dismissed: true }).then(setSt).catch(() => { /* preference only */ });
  if (!cfg) return <ErrorNote text={err} />;

  return <div className="lab">
    <TopBar experiments={experiments} current={current} areaFilter={areaFilter} setAreaFilter={setAreaFilter} setExp={(id) => go('workspace', id)}
      onGenerate={() => setWizard(true)} onRun={run} runLabel={exp?.campaign.locked ? 'again' : 'run'} runDisabled={runBlocked} runTitle={runTitle}
      onCompare={() => setPicker(true)} canCompare={!!exp?.results} comparePrimary={!!exp?.results && !isNew && exp.campaign.status !== 'draft'}
      onImportFile={importBundle} onTrySample={() => setGuide(true)} sampleAvailable={!!st?.sample.available}
      onExport={exportBundle} canExport={!!exp && (exp.campaign.locked || exp.campaign.status === 'completed')}
      onPanel={(p) => setPanel(panel === p ? null : p)} onLibrary={() => go('data', 'library')} />
    {(err || notice) && <div className="lab-notes">{err && <ErrorNote text={err} />}{notice && <p className="note ok row gap" role="status">{notice}<span className="grow" /><button className="btn sm" onClick={() => setNotice(null)}>OK</button></p>}</div>}
    <div className="lab-grid">
      <aside className={`lab-left ${panel === 'left' ? 'open' : ''}`} data-tour="scenario" aria-label="scenario">
        {isNew ? <NewExperimentPanel lib={shownLib} picked={picked} setPicked={setPicked} title={title} setTitle={setTitle} onGenerate={() => setWizard(true)} onRun={run} canRun={!runBlocked} runTitle={runTitle} />
          : exp ? <ScenarioPanel exp={exp} hash={hash} setHash={setHash} inst={inst} plan={plan} parentTitle={parentTitle} onDetails={() => go('experiments', `c:${cid}`)}
            hidden={hiddenIds.includes(cid)} onHide={toggleHidden}
            onFocus={(la, lo) => { setPanel(null); setFocus({ key: `${la},${lo},${Date.now()}`, bbox: [la - 0.004, lo - 0.006, la + 0.004, lo + 0.006] }); }} />
          : <p className="muted panel-body">{st ? 'Choose an experiment.' : 'Loading…'}</p>}
      </aside>
      <main className="lab-centre" data-tour="map">
        {geographic ? <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={points} lines={lines} rects={rects} dynamic={dynamic}
          fitKey={isNew ? `new:${areaFilter}` : `${cid}|${hash}|${inst ? 1 : 0}${plan ? 'p' : ''}`} focus={focus} height="100%" />
          : <div className="panel-body">{exp?.results ? <Charts metrics={exp.problem.metrics} rows={exp.results.rows} title={exp.campaign.title} /> : <p className="muted">This problem has no map; results appear here as charts once the experiment has run.</p>}</div>}
        {showStart && <div className="mapcard start-card" role="region" aria-label="start here">
          <div className="row gap"><span className="start-ico"><BadgeCheck size={18} /></span>
            <div className="grow"><b>{t('ws.start.title')}</b><div className="small muted">Demand sampled from RPC 2026-10 observed trips · Montbéliard road network · {exp!.methods.length} methods · {exp!.validation.runs} runs, each validated</div></div>
            <button className="btn icon ghost sm" aria-label="dismiss" onClick={dismissStart}><X size={14} /></button></div>
          <div className="row gap start-actions">
            {variantOf(cid) && <button className="btn primary sm" onClick={() => go('compare', `${cid}|${variantOf(cid)!.campaign_id}`)}><GitCompareArrows size={14} /> {t('ws.start.compare')}</button>}
            <button className="btn sm" onClick={() => setWizard(true)}><Plus size={14} /> {t('ws.start.generate')}</button>
            <button className="btn sm" disabled={!st?.sample.available} onClick={() => setGuide(true)}><PackageOpen size={14} /> {t('ws.start.import')}</button>
            <button className="btn sm ghost" onClick={() => { dismissStart(); setTour(true); }}>Quick tour</button></div></div>}
        {geographic && plan && <div className="mapcard legend" aria-label="legend">
          <span><i className="lg-line" style={{ borderColor: MAP.shared }} />Shared ride</span><span><i className="lg-dash" style={{ borderColor: MAP.alone }} />Drives alone</span>
          <span><i className="dot" style={{ background: MAP.stop }} />Pick-up / drop-off</span><span><i className="dot hollow" style={{ borderColor: MAP.unmatched }} />Not matched</span></div>}
        {geographic && plan && !replaying && <button className="mapcard replay-pill" onClick={() => setReplaying(true)} data-tour="replay"><Play size={14} /> Replay routes</button>}
        {replaying && plan && <ReplayBar plan={plan} replay={replay} onClose={() => setReplaying(false)} />}
      </main>
      <aside className={`lab-right ${panel === 'right' ? 'open' : ''}`} aria-label="results">
        <ResultPanel exp={isNew ? null : exp} methods={methods} checked={checked} setChecked={setChecked} job={job} onJobDone={jobDone} setErr={setErr}
          selected={selected} setSelected={setSelected}
          onLock={() => act(async () => { await post(`/campaigns/${cid}/lock`); await loadExp(cid); await reloadExperiments(); })}
          opts={opts} setOpts={setOpts} variants={(problem?.variants ?? []).filter((v) => v.instance_level)} onVariant={variant}
          onWhy={() => exp?.comparability && go('experiments', `sem:${exp.comparability.reference}|${cid}`)}
          onTrace={traceId ? () => setTrace(traceId) : null} onAddMethod={() => setAddMethod(true)} hash={hash} scope={scope} setScope={setScope} />
      </aside>
    </div>
    {picker && exp && <ComparePicker a={cid} onClose={() => setPicker(false)} onCompare={(ids) => go('compare', `${cid}|${ids.join(',')}`)} />}
    {addMethod && <AddMethod problemId={problemId} onClose={() => setAddMethod(false)} onChanged={() => setMethodsKey((k) => k + 1)} setErr={setErr} />}
    {guide && st?.sample.available && <ImportGuide sample={st.sample} experiments={experiments} methods={methods} onClose={() => { setGuide(false); lab.state().then(setSt).catch(() => { /* */ }); }}
      onOpen={(id) => { setGuide(false); go('workspace', id); }} onCompare={(a, b) => { setGuide(false); go('compare', `${a}|${b}`); }}
      onAddMethod={() => setAddMethod(true)} reload={reloadExperiments} setErr={setErr} />}
    {trace && <TraceDrawer jobId={trace} onClose={() => setTrace(null)} />}
    {wizard && <Wizard cfg={cfg} areas={areas.filter((a) => !hiddenIds.includes(a.area_id))} datasets={datasets.filter((d) => !hiddenIds.includes(d.dataset_key))} methods={methods}
      areaId={area?.area_id ?? areas.find((a) => a.name === current?.area)?.area_id} setErr={setErr} reloadAreas={reloadLists} onAddMethod={() => setAddMethod(true)}
      onClose={() => setWizard(false)}
      onSaved={(rec) => { setWizard(false); reloadLists(); setPicked([rec.instance_hash]); setNotice('Scenario saved. Choose the methods on the right and press Run.'); go('workspace', NEW); }}
      onRun={(r) => { setWizard(false); setNotice(null); reloadLists(); setJobTarget(r.campaign_id); setJob(r.job); reloadExperiments().then(() => go('workspace', r.campaign_id)).catch(() => go('workspace', r.campaign_id)); }} />}
    {tour && <Tour onClose={(never) => { setTour(false); if (never) lab.prefs({ tour_dismissed: true }).catch(() => { /* preference only */ }); }} />}
  </div>;
}
