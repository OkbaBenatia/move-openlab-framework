import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, GitCompareArrows, Maximize2, Minimize2, PackageOpen, Play, Plus, X } from 'lucide-react';
import { call, post, type Json } from '../api/client';
import { CarIcon } from '../components/DomainIcons';
import { TraceDrawer } from '../components/TraceDrawer';
import { ErrorNote, errText } from '../components/common';
import { COLORS, LeafletMap, type MapPoint, type MapView } from '../geo/LeafletMap';
import { geo } from '../geo/api';
import { instanceLayers } from '../geo/GeoWorkbench';
import { t } from '../i18n';
import { Wizard, type WizardProps } from '../mobility/Wizard';
import { BASELINE_LABEL, SCOPE_LABEL } from '../mobility/api';
import { AddMethod } from './AddMethod';
import { ComparePicker } from './ComparePicker';
import { toRoute } from './compareSelection';
import type { Section } from '../router';
import { lab, rowKey, scopeMethods, type Experiment, type LabState, type WorkspaceView } from './api';
import { Charts } from './Charts';
import { ALL_AREAS } from './ExperimentPicker';
import { ExportDialog } from './ExportDialog';
import { ImportDialog } from './ImportDialog';
import { ImportGuide } from './ImportGuide';
import { MAP, planLayers, planPositions, powertrainsOf } from './layers';
import { GLYPH_STYLE, POWERTRAIN_GLYPH, legendIcon } from '../geo/LeafletMap';
import { ReplayBar, useReplay } from './ReplayBar';
import { ResultPanel, methodKey, type RunOptions, type Scope } from './ResultPanel';
import { NewExperimentPanel, ScenarioPanel } from './ScenarioPanel';
import { NEW, TopBar } from './TopBar';
import { Tour } from './Tour';
import { OPEN_NEW, OPEN_WIZARD, takeHandOff } from './handoff';
import { RIDE, useLabData, useMethods } from './useLabData';

export { OPEN_WIZARD } from './handoff';
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

/** The Workspace: choose or load an experiment, inspect it on the map, run methods, see validated results in an explicit
 *  scope, compare, replay, share. The Generate wizard, the comparison selection, Add method and the sample-bundle guide
 *  open over it. */
export function Lab({ cid, go, tourRequest = 0, onTourShown }: { cid: string; go: (s: Section, arg?: string, replace?: boolean) => void; tourRequest?: number; onTourShown?: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // a notice belongs to the experiment it was written for; opening another experiment clears it
  const noticeFor = useRef<string | null>(null);
  const notify = (text: string, forCid: string) => { noticeFor.current = forCid; setNotice(text); };
  useEffect(() => { if (noticeFor.current !== cid) { noticeFor.current = null; setNotice((n) => (n?.startsWith('Loading') ? n : null)); } }, [cid]);
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
  const [wizardData, setWizardData] = useState<{ area_id?: string; dataset_key?: string } | null>(null);
  const [wizardInitial, setWizardInitial] = useState<WizardProps['initial']>(null);
  const [title, setTitle] = useState(`Experiment ${stamp()}`);
  const [picker, setPicker] = useState(false);
  const [addMethod, setAddMethod] = useState(false);
  const [guide, setGuide] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  // expanded map: the header and side panels give way to the map; the action bar stays, panels open as overlays
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle('map-expanded', expanded);
    if (!expanded) return () => document.documentElement.classList.remove('map-expanded');
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.overlay, .wizard, .tour, [role=menu], .picker-panel')) setExpanded(false); };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); document.documentElement.classList.remove('map-expanded'); };
  }, [expanded]);
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

  // the account's state is read once per visit; the saved Workspace view (scenario, methods, result, map) comes with it
  const firstState = useMemo(() => lab.state(), []);
  const restored = useRef<string | null>(null);            // the experiment whose saved view has been applied
  const [mapView, setMapView] = useState<MapView | null>(null);
  const [restoreView, setRestoreView] = useState<{ key: string; view: MapView } | null>(null);
  const methodsRef = useRef<string[]>([]);
  // first use: the demonstration is imported once into this workspace and opened; new accounts start on its area
  useEffect(() => {
    act(async () => {
      let s = await firstState;
      if (s.demo.available && (!s.demo.installed || s.demo.area == null)) {
        setNotice('Loading the demonstration experiment…');
        try { await lab.installDemo(); s = await lab.state(); reloadLists(); } catch (e) { setErr(errText(e)); } finally { setNotice(null); }
      }
      const list = await reloadExperiments();
      const last = list.find((x) => x.campaign_id === s.preferences.last_experiment && !x.hidden)
        ?? list.find((x) => x.demo && x.kind === 'baseline' && !x.hidden) ?? list[list.length - 1];
      // the working area chosen in the Library (Use) or with the area filter wins over the last experiment's area
      // (a hidden area never becomes the working area by itself: an older preference may point to one)
      const working = s.preferences.area_id && !s.preferences.hidden_ids.includes(s.preferences.area_id)
        ? (await geo.areas().catch(() => ({ areas: [] }))).areas.find((a: Json) => a.area_id === s.preferences.area_id) : null;
      setAreaFilter(working?.name ?? last?.area ?? list.find((x) => x.demo)?.area ?? ALL_AREAS);
      const fresh = takeHandOff<{ hashes: string[]; label: string }>(OPEN_NEW);
      if (fresh?.hashes?.length) { setPicked(fresh.hashes); notify(`${fresh.label} selected for a new experiment. Choose the methods on the right and press Run.`, NEW); go('workspace', NEW, true); }
      else if (!cid && last) go('workspace', last.campaign_id, true);
      setSt(s);
      const w = takeHandOff<{ area_id?: string; dataset_key?: string }>(OPEN_WIZARD);
      if (w) { setWizardData(w); setWizard(true); }
    });
  }, []);                                                                    // eslint-disable-line react-hooks/exhaustive-deps
  // the tour opens only when asked (Help → Quick tour, or the start card); the request is acknowledged at once
  useEffect(() => { if (tourRequest > 0) { setTour(true); onTourShown?.(); } }, [tourRequest, onTourShown]);
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
  const loadExp = useCallback((id: string) => Promise.all([lab.experiment(id), firstState.catch(() => null)]).then(([e, s0]) => {
    if (cidRef.current !== id) return;
    setExp(e);
    // an experiment that is still running (started elsewhere, e.g. Library › Benchmarks, or before a reload): follow its job
    if (e.campaign.status === 'running' && e.job_id) call<Json>(`/jobs/${e.job_id}`).then((j) => { if (cidRef.current === id && j.state === 'running') { setJobTarget(id); setJob((cur) => cur ?? j); } }).catch(() => { /* progress only */ });
    lab.prefs({ last_experiment: id }).catch(() => { /* preference only */ });
    // coming back to the experiment of the saved view restores what was shown (only what still exists in it)
    const v: WorkspaceView | null = restored.current !== id && s0?.preferences.workspace?.campaign_id === id ? s0.preferences.workspace : null;
    const rows = e.results?.rows ?? [];
    const hasHash = (h: string) => e.scenarios.some((s) => s.instance_hash === h);
    const pick = rows.find((r) => r.campaign_id === id && r.method_id === e.results?.reference?.method_id) ?? rows.find((r) => r.campaign_id === id) ?? rows[0];
    if (v) {
      const own = scopeMethods(e), keep = v.methods.filter((k) => own.includes(k) || methodsRef.current.includes(k));
      const h = hasHash(v.instance_hash) ? v.instance_hash : e.scenarios[0]?.instance_hash ?? '';
      setHash(h); setChecked(keep.length ? keep : own); setScope(v.scope);
      setSelected(rows.some((r) => rowKey(r) === v.result) ? v.result : pick ? rowKey(pick) : '');
      setRestoreView(v.map && h === v.instance_hash ? { key: `${id}|${h}`, view: v.map } : null);
    } else {
      setHash((h) => (hasHash(h) ? h : e.scenarios[0]?.instance_hash ?? ''));
      setChecked(scopeMethods(e));
      setSelected((k) => (rows.some((r) => rowKey(r) === k) ? k : pick ? rowKey(pick) : ''));
    }
    restored.current = id;
  }).catch((x) => { if (cidRef.current === id) { setExp(null); setErr(errText(x)); } }), [firstState]);
  methodsRef.current = methods.map(methodKey);
  // the view is saved for the account as the researcher works (after the restore, so a visit never erases it)
  useEffect(() => {
    if (!exp || isNew || exp.campaign.campaign_id !== cid || restored.current !== cid) return;
    const t = window.setTimeout(() => lab.prefs({ workspace: { campaign_id: cid, instance_hash: hash, methods: checked, result: selected, scope, map: mapView } })
      .catch(() => { /* preference only */ }), 700);
    return () => window.clearTimeout(t);
  }, [exp, cid, isNew, hash, checked, selected, scope, mapView]);
  // the researcher's own moves become the view kept for this scenario (later refits of the same scenario keep it)
  const onMapView = useCallback((v: MapView) => { setMapView(v); setRestoreView((r) => (r ? { ...r, view: v } : r)); }, []);
  // a restored map view belongs to its scenario: another scenario (or experiment) is fitted as usual
  useEffect(() => { setRestoreView((r) => (r && r.key !== `${cid}|${hash}` ? null : r)); }, [cid, hash]);
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
  // choosing an area in the picker makes it the working area (kept for the account, shared with the Library)
  const chooseArea = (name: string) => {
    setAreaFilter(name);
    const a = areas.find((x) => x.name === name);
    lab.prefs({ area_id: a?.area_id ?? '' }).then(setSt).catch(() => { /* preference only */ });
  };
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
  // why Run cannot start now, in one actionable sentence (shown when pressed, instead of a silently disabled button)
  const runWhyNot = isNew ? (!picked.length ? 'Choose at least one scenario (left), or Generate one.' : !checked.length ? 'Tick at least one method (right).' : null)
    : !exp ? 'Choose an experiment.' : !exp.campaign.locked && exp.campaign.status === 'completed' ? 'Lock the results first (below the results); Run again then re-executes the frozen experiment.'
    : !exp.campaign.locked && exp.campaign.status !== 'draft' ? 'This experiment is still running.' : null;
  const adding = !!exp?.campaign.locked && checked.some((k) => !scopeMethods(exp).includes(k));
  const runTitle = isNew ? 'Choose scenarios and methods' : exp?.campaign.locked ? 'Re-executes this frozen experiment (or extends it with the methods you added)' : exp && exp.campaign.status === 'completed' ? 'Lock the results first' : '';
  const jobDone = (j: Json) => {
    setJob(null); setLastJob(j.job_id); reloadExperiments().catch(() => { /* list refresh only */ });
    const now = cidRef.current;
    if (jobTarget && jobTarget !== now) go('workspace', jobTarget); else if (now && now !== NEW) loadExp(now);
  };
  // Export and Import open dialogs that say what will happen before anything is written
  const imported = (root: string, note: string) => act(async () => {
    setImporting(false); await reloadExperiments(); reloadLists(); notify(note, root); go('workspace', root);
  });
  const reproduceHere = (root: string) => { setImporting(false); setNotice(null); once(async () => { const r = await post(`/campaigns/${root}/reproduce`); await execute(r.campaign_id); }); };
  // a different CO₂ calculation or baseline: a new experiment on the same frozen scenarios (the original is untouched)
  const recalcCo2 = (scope: string, baseline: string) => once(async () => {
    if (!exp) return;
    const title = `${exp.campaign.title} · ${SCOPE_LABEL[scope] ?? scope}, ${(BASELINE_LABEL[baseline] ?? baseline).toLowerCase()}`.slice(0, 160);
    const r = await post<{ campaign_id: string; job: Json }>('/lab/run', { title, methods: exp.methods.map((m) => [m.method_id, m.version]), repetitions: exp.campaign.repetitions,
      instance_hashes: exp.scenarios.map((s) => s.instance_hash), emissions: { scope, baseline } });
    setJobTarget(r.campaign_id); setJob(r.job); await reloadExperiments();
  });
  // other vehicles or parameter values: the wizard opens on a new version of the shown frozen scenario
  const editVehicles = () => editScenario();
  // participants or vehicles edited from the Workspace: the wizard opens on a NEW version of the shown frozen scenario
  // (straight at the participants step for + Driver / + Rider / Randomize); the frozen scenario and its results stay
  const editScenario = (action?: 'driver' | 'rider' | 'randomize') => act(async () => {
    const inst = await geo.instance(hash); const sc = exp?.scenarios.find((s) => s.instance_hash === hash);
    const drivers = inst.drivers as Json[], def = inst.vehicles?.default as Json | undefined;
    const profiles = Array.from(new Map([...drivers.map((d) => d.vehicle), def].filter(Boolean).map((p: Json) => [p.id, p])).values());
    const defId = def?.id ?? profiles[0]?.id;
    const agent = (a: Json) => ({ id: a.id, origin: a.origin, destination: a.destination, earliest: a.earliest, latest: a.latest });
    setWizardInitial({ fromInstance: hash, action, scenario: { name: `${sc?.name ?? 'Scenario'} · ${action ? 'edited' : 'vehicles edited'}`.slice(0, 80), network_id: inst.network?.network_id,
      params: { max_detour_s: inst.params.max_detour_s, max_detour_ratio: inst.params.max_detour_ratio }, drivers: drivers.map(agent), riders: (inst.riders as Json[]).map(agent),
      vehicles: { profiles, default: defId, assignments: Object.fromEntries(drivers.filter((d) => d.vehicle && d.vehicle.id !== defId).map((d) => [d.id, d.vehicle.id])) },
      emissions: exp?.campaign.emissions ?? inst.emissions } });
    setWizard(true);
  });
  // one method on the open experiment's frozen scenarios: a locked experiment is extended (never changed in place)
  const runWithMethod = (id: string, ver: string) => {
    const key = `${id}@${ver}`;
    if (isNew || !exp) { setChecked(Array.from(new Set([...checked, key]))); setAddMethod(false); notify('Method ticked: choose scenarios and press Run.', NEW); return; }
    if (!exp.campaign.locked) { setAddMethod(false); setErr(exp.campaign.status === 'draft' ? 'This experiment has not run yet: tick the method in the Methods list, then Run.' : 'Lock the results first (Lock results, below the results); then the method runs as an extension of this experiment.'); return; }
    setAddMethod(false); setNotice(null);
    once(async () => { const r = await post(`/campaigns/${cid}/extend`, { methods: [[id, ver]] }); await execute(r.campaign_id); });
  };
  const runNote = isNew || !exp ? 'Adds the method to the new experiment.' : exp.campaign.locked ? 'Runs it on the same frozen scenarios as an extension; this experiment stays unchanged.' : 'Lock the results first; then it runs as an extension.';
  const reproduceThis = () => { setPicker(false); if (exp?.campaign.locked) derive('reproduce'); else setErr('Lock the results first; a reproduction re-executes a frozen experiment.'); };
  const variant = () => once(async () => { const r = await post(`/campaigns/${cid}/variant`, { variant: opts.variant }); await execute(r.campaign_id); });
  const parentTitle = exp?.campaign.parent ? experiments.find((x) => x.campaign_id === exp.campaign.parent!.campaign_id)?.title ?? null : null;
  const geographic = !exp || exp.campaign.problem_id === RIDE;
  const traceId = job ? null : exp?.job_id ?? lastJob;
  const variantOf = (id: string) => experiments.find((x) => x.parent === id && x.kind === 'variant' && !x.hidden);
  const showStart = !!st && !st.preferences.start_dismissed && !!current?.demo && !!exp?.results;
  const dismissStart = () => lab.prefs({ start_dismissed: true }).then(setSt).catch(() => { /* preference only */ });
  if (!cfg) return <ErrorNote text={err} />;

  return <div className={`lab ${expanded ? 'expanded' : ''}`}>
    <TopBar experiments={experiments} current={current} areaFilter={areaFilter} setAreaFilter={chooseArea} setExp={(id) => go('workspace', id)}
      onGenerate={() => setWizard(true)} onRun={() => (runWhyNot ? setErr(runWhyNot) : run())} runLabel={adding ? 'extend' : exp?.campaign.locked ? 'again' : 'run'} runDisabled={!!job || busy} runTitle={runWhyNot ?? (adding ? 'Runs the added methods on the same frozen scenarios as an extension; this experiment stays unchanged' : runTitle)}
      onCompare={() => setPicker(true)} canCompare={!!exp?.results} comparePrimary={!!exp?.results && !isNew && exp.campaign.status !== 'draft'}
      onImport={() => setImporting(true)} onTrySample={() => setGuide(true)} sampleAvailable={!!st?.sample.available}
      onExport={() => setExporting(true)} canExport={!!exp && (exp.campaign.locked || exp.campaign.status === 'completed')}
      onPanel={(p) => setPanel(panel === p ? null : p)} onLibrary={() => go('data', 'library')} />
    {(err || notice) && <div className="lab-notes">{err && <ErrorNote text={err} />}{notice && <p className="note ok row gap" role="status">{notice}<span className="grow" /><button className="btn sm" onClick={() => setNotice(null)}>OK</button></p>}</div>}
    <div className="lab-grid">
      <aside className={`lab-left ${panel === 'left' ? 'open' : ''}`} data-tour="scenario" aria-label="scenario">
        {isNew ? <NewExperimentPanel lib={shownLib} picked={picked} setPicked={setPicked} title={title} setTitle={setTitle} onGenerate={() => setWizard(true)} onRun={run} canRun={!runBlocked} runTitle={runTitle} />
          : exp ? <ScenarioPanel exp={exp} hash={hash} setHash={setHash} inst={inst} plan={plan} parentTitle={parentTitle} onDetails={() => go('experiments', `c:${cid}`)}
            hidden={hiddenIds.includes(cid)} onHide={toggleHidden}
            onFocus={(la, lo) => { setPanel(null); setFocus({ key: `${la},${lo},${Date.now()}`, bbox: [la - 0.004, lo - 0.006, la + 0.004, lo + 0.006] }); }}
            onEdit={exp.campaign.problem_id === RIDE && hash ? editScenario : undefined} detailsOpen={!!st?.preferences.details_open}
            setDetailsOpen={(open) => lab.prefs({ details_open: open }).then(setSt).catch(() => { /* preference only */ })} />
          : <p className="muted panel-body">{st ? 'Choose an experiment.' : 'Loading…'}</p>}
      </aside>
      <main className="lab-centre" data-tour="map">
        {geographic ? <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={points} lines={lines} rects={rects} dynamic={dynamic}
          fitKey={isNew ? `new:${areaFilter}` : `${cid}|${hash}|${inst ? 1 : 0}${plan ? 'p' : ''}`} focus={focus} height="100%"
          restore={!isNew && restoreView?.key === `${cid}|${hash}` ? restoreView.view : null} onView={isNew ? undefined : onMapView} />
          : <div className="panel-body">{exp?.results ? <Charts metrics={exp.problem.metrics} rows={exp.results.rows} title={exp.campaign.title} /> : <p className="muted">This problem has no map; results appear here as charts once the experiment has run.</p>}</div>}
        {showStart && <div className="mapcard start-card" role="region" aria-label="start here">
          <div className="row gap"><span className="start-ico"><BadgeCheck size={18} /></span>
            <div className="grow"><b>{t('ws.start.title')}</b><div className="small muted">Demand sampled from RPC 2026-10 observed trips · Montbéliard road network · {exp!.methods.length} methods · {exp!.validation.runs} runs, each validated</div></div>
            <button className="btn icon ghost sm" aria-label="dismiss" onClick={dismissStart}><X size={14} /></button></div>
          <div className="row gap start-actions">
            {variantOf(cid) && <button className="btn primary sm" onClick={() => go('compare', `${cid}|${variantOf(cid)!.campaign_id}`)}><GitCompareArrows size={14} /> {t('ws.start.compare')}</button>}
            <button className="btn sm" onClick={() => setWizard(true)}><Plus size={14} /> {t('ws.start.generate')}</button>
            <button className="btn sm" disabled={!st?.sample.available} onClick={() => setGuide(true)}><PackageOpen size={14} /> {t('ws.start.import')}</button>
            {!st?.preferences.tour_dismissed && <button className="btn sm ghost" onClick={() => { dismissStart(); setTour(true); }}>Quick tour</button>}</div></div>}
        {geographic && plan && <div className="mapcard legend" aria-label="legend">
          <span><i className="lg-line" style={{ borderColor: MAP.shared }} />Shared ride</span><span><i className="lg-dash" style={{ borderColor: MAP.alone }} />Drives alone</span>
          <span><i className="lg-sq" style={{ background: MAP.start }} /><CarIcon size={14} />Driver start</span>
          <span title="arrow up, filled: pick-up · arrow down, hollow: drop-off"><Ico html={legendIcon('pickup', MAP.stop)} /><Ico html={legendIcon('dropoff', MAP.stop)} />Pick-up / drop-off</span><span><Ico html={legendIcon('unserved', MAP.unmatched)} />Rider not matched</span>
          <PowertrainKey list={powertrainsOf((plan.vehicles as Json[]).map((v) => v.vehicle))} /></div>}
        {geographic && !plan && inst && !isNew && <div className="mapcard legend" aria-label="legend">
          <span><i className="lg-sq" style={{ background: COLORS.driver }} /><CarIcon size={14} />Driver start</span>
          <span><Ico html={legendIcon('rider', COLORS.rider)} />Rider start</span>
          <span title="destinations are hollow"><i className="dot hollow" style={{ borderColor: COLORS.driver }} /><i className="dot hollow" style={{ borderColor: COLORS.rider }} />Destination</span>
          <PowertrainKey list={powertrainsOf((inst.drivers as Json[]).map((d) => d.vehicle))} /></div>}
        {geographic && plan && !replaying && <button className="mapcard replay-pill" onClick={() => setReplaying(true)} data-tour="replay"><Play size={14} /> Replay routes</button>}
        {geographic && <button className={`mapcard map-expand ${expanded ? 'on' : ''}`} aria-pressed={expanded} aria-label={expanded ? 'Exit expanded map' : 'Expand the map'}
          title={expanded ? 'Back to the workspace layout (Esc)' : 'Expand the map: panels open on demand, actions stay in the bar above'} onClick={() => { setPanel(null); setExpanded(!expanded); }}>
          {expanded ? <><Minimize2 size={15} /> Exit expanded map <kbd>Esc</kbd></> : <Maximize2 size={15} />}</button>}
        {replaying && plan && <ReplayBar plan={plan} replay={replay} onClose={() => setReplaying(false)} />}
      </main>
      <aside className={`lab-right ${panel === 'right' ? 'open' : ''}`} aria-label="results">
        <ResultPanel exp={isNew ? null : exp} methods={methods} checked={checked} setChecked={setChecked} job={job} onJobDone={jobDone} setErr={setErr}
          selected={selected} setSelected={setSelected}
          onLock={() => act(async () => { await post(`/campaigns/${cid}/lock`); await loadExp(cid); await reloadExperiments(); })}
          opts={opts} setOpts={setOpts} variants={(problem?.variants ?? []).filter((v) => v.instance_level)} onVariant={variant}
          onWhy={() => exp?.comparability && go('experiments', `sem:${exp.comparability.reference}|${cid}`)}
          onRecalcCo2={exp?.campaign.problem_id === RIDE ? recalcCo2 : undefined} onEditVehicles={exp?.campaign.problem_id === RIDE && hash ? editVehicles : undefined}
          onTrace={traceId ? () => setTrace(traceId) : null} onAddMethod={() => setAddMethod(true)} onCompareMethods={() => go('methods', cid)} hash={hash} scope={scope} setScope={setScope} />
      </aside>
    </div>
    {picker && exp && <ComparePicker current={cid} onClose={() => setPicker(false)} onCompare={(sel) => go('compare', toRoute(sel))}
      onMethods={(exp.results?.rows.length ?? 0) > 1 ? () => go('methods', cid) : undefined} onAddMethod={() => { setPicker(false); setAddMethod(true); }} onReproduce={exp.campaign.locked ? reproduceThis : undefined} />}
    {addMethod && <AddMethod problemId={problemId} onClose={() => setAddMethod(false)} onChanged={() => setMethodsKey((k) => k + 1)} setErr={setErr}
      onRun={runWithMethod} done={exp && !isNew ? scopeMethods(exp) : []} runNote={runNote} />}
    {exporting && exp && <ExportDialog cid={cid} title={exp.campaign.title} setErr={setErr} onClose={() => setExporting(false)} onDone={() => { loadExp(cid); reloadExperiments().catch(() => { /* list refresh only */ }); }} />}
    {importing && <ImportDialog sampleAvailable={!!st?.sample.available} setErr={setErr} onClose={() => setImporting(false)} onImported={imported} onReproduce={reproduceHere} />}
    {guide && st?.sample.available && <ImportGuide sample={st.sample} experiments={experiments} methods={methods} onClose={() => { setGuide(false); lab.state().then(setSt).catch(() => { /* */ }); }}
      onOpen={(id) => { setGuide(false); go('workspace', id); }} onCompare={(a, b) => { setGuide(false); go('compare', `${a}|${b}`); }}
      onAddMethod={() => setAddMethod(true)} reload={reloadExperiments} setErr={setErr} />}
    {trace && <TraceDrawer jobId={trace} onClose={() => setTrace(null)} />}
    {wizard && (!wizardData?.area_id || areas.length > 0) && <Wizard cfg={cfg} areas={areas.filter((a) => !hiddenIds.includes(a.area_id) || a.area_id === wizardData?.area_id)} datasets={datasets.filter((d) => !hiddenIds.includes(d.dataset_key) || d.dataset_key === wizardData?.dataset_key)} methods={methods}
      areaId={wizardData?.area_id ?? area?.area_id ?? areas.find((a) => a.name === current?.area)?.area_id} datasetKey={wizardData?.dataset_key} setErr={setErr} reloadAreas={reloadLists} onAddMethod={() => setAddMethod(true)}
      initial={wizardInitial} onClose={() => { setWizard(false); setWizardData(null); setWizardInitial(null); }}
      onSaved={(rec) => { setWizard(false); setWizardData(null); setWizardInitial(null); reloadLists(); setPicked([rec.instance_hash]); notify('Scenario saved. Choose the methods on the right and press Run.', NEW); go('workspace', NEW); }}
      onRun={(r) => { setWizard(false); setWizardData(null); setWizardInitial(null); setNotice(null); setJobTarget(r.campaign_id); setJob(r.job);
        go('workspace', r.campaign_id); reloadLists(); reloadExperiments().catch(() => { /* list refresh only */ }); }} />}
    {tour && <Tour onClose={(never) => { setTour(false); if (never) lab.prefs({ tour_dismissed: true }).then(setSt).catch(() => { /* preference only */ }); }} />}
  </div>;
}

/** Letters on driver markers, for the vehicle types present. */
function PowertrainKey({ list }: { list: string[] }) {
  if (!list.length) return null;
  return <span title="driver markers: colour and icon by vehicle type">{list.map((p) => { const st = GLYPH_STYLE[POWERTRAIN_GLYPH[p]] ?? GLYPH_STYLE['']; return <span key={p} className="lg-pt">
    <i className="lg-sq glyph" style={{ background: st.color }} aria-hidden="true"><svg viewBox="0 0 12 12" width="9" height="9" dangerouslySetInnerHTML={{ __html: st.icon }} /></i>{PT_SHORT[p] ?? p}</span>; })}</span>;
}
const PT_SHORT: Record<string, string> = { ICE: 'Combustion', HEV: 'Hybrid', PHEV: 'Plug-in hybrid', BEV: 'Electric' };

/** A map marker icon in a legend (static markup drawn by the map module). */
function Ico({ html }: { html: string }) { return <i className="lg-ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />; }
