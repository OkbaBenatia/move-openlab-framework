import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, GitCompareArrows, Maximize2, Minimize2, PackageOpen, Play, Plus, X } from 'lucide-react';
import { call, post, type Json, type MethodRef } from '../api/client';
import { CarIcon } from '../components/DomainIcons';
import { TraceDrawer } from '../components/TraceDrawer';
import { ErrorNote, errText } from '../components/common';
import { COLORS, LeafletMap, type MapPoint, type MapView } from '../geo/LeafletMap';
import { geo } from '../geo/api';
import { instanceLayers } from '../geo/GeoWorkbench';
import { locale, t, tr } from '../i18n';
import { Wizard, type WizardProps } from '../mobility/Wizard';
import { BASELINE_LABEL, SCOPE_LABEL } from '../mobility/api';
import { AddMethod } from './AddMethod';
import type { Section } from '../router';
import { lab, rowKey, scopeMethods, type Experiment, type LabState, type WorkspaceView } from './api';
import { WorkspaceCharts } from './WorkspaceCharts';
import { ALL_AREAS } from './ExperimentPicker';
import { ExportDialog } from './ExportDialog';
import { ImportDialog } from './ImportDialog';
import { ImportGuide } from './ImportGuide';
import { InspectCard } from './InspectCard';
import { ARC, MAP, arcLayers, planLayers, planPositions, powertrainsOf, type ArcMode } from './layers';
import { GLYPH_STYLE, POWERTRAIN_GLYPH, legendIcon } from '../geo/LeafletMap';
import { ReplayBar, useReplay } from './ReplayBar';
import { SampleTripsGuide } from './SampleTripsGuide';
import { SamplesGuide } from './SamplesGuide';
import { samplesOffered } from './samplePackages';
import { ResultPanel, changedSettings, methodConfig, methodKey, type RunOptions, type Scope, type Settings } from './ResultPanel';
import { NewExperimentPanel, ScenarioPanel } from './ScenarioPanel';
import { NEW, TopBar } from './TopBar';
import { Tour } from './Tour';
import { OPEN_ACTION, OPEN_NEW, OPEN_WIZARD, takeHandOff } from './handoff';
import { RIDE, useLabData, useMethods } from './useLabData';
import { hasCap } from './scenarioMatch';

export { OPEN_WIZARD } from './handoff';
const NO_IDS: string[] = [];
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const ARC_MODES: [ArcMode, string, string][] = [
  ['routes', 'Routes', 'The validated solution on road geometry'],
  ['before', 'Before', 'Every vehicle-edge candidate of the scenario, before any reduction'],
  ['after', 'After', 'Candidates retained and removed by this method\'s policy (archived run)'],
  ['solution', 'Solution', 'Vehicle-edges used by the validated solution of the exact solver']];

/** The Workspace: choose or load an experiment, inspect it on the map, run methods, see validated results in an explicit
 *  scope, compare, replay, share. The Generate wizard, the comparison selection, Add method and the sample-bundle guide
 *  open over it. */
export function Lab({ cid, go, tourRequest = 0, onTourShown, research = false, restrictedIds = NO_IDS }: { cid: string; go: (s: Section, arg?: string, replace?: boolean) => void; tourRequest?: number; onTourShown?: () => void;
  /** The private-research context: only the records of restricted problems are listed (in the public context the server
   *  already leaves them out), and the view kept for the public Workspace is neither read nor replaced. */
  research?: boolean; restrictedIds?: string[] }) {
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // a notice belongs to the experiment it was written for; opening another experiment clears it
  const noticeFor = useRef<string | null>(null);
  const notify = (text: string, forCid: string) => { noticeFor.current = forCid; setNotice(text); };
  useEffect(() => { if (noticeFor.current !== cid) { noticeFor.current = null; setNotice((n) => (n?.startsWith('Loading') || n === tr('Loading the demonstration experiment…') ? n : null)); } }, [cid]);
  const { cfg, areas, datasets, experiments: listed, lib, problems, reloadExperiments: reloadListed, reloadLists } = useLabData(setErr);
  const inContext = useCallback((x: { problem_id: string }) => !research || restrictedIds.includes(x.problem_id), [research, restrictedIds]);
  const experiments = useMemo(() => listed.filter(inContext), [listed, inContext]);
  const reloadExperiments = useCallback(() => reloadListed().then((l) => l.filter(inContext)), [reloadListed, inContext]);
  const [st, setSt] = useState<LabState | null>(null);
  const [areaFilter, setAreaFilter] = useState(ALL_AREAS);
  const [exp, setExp] = useState<Experiment | null>(null);
  const [hash, setHash] = useState('');
  const [inst, setInst] = useState<Json | null>(null);
  const [selected, setSelected] = useState('');
  const [plan, setPlan] = useState<Json | null>(null);
  // candidate reduction of the selected run (problems with the "candidates" capability): Routes / Before / After / Solution
  const [arcMode, setArcMode] = useState<ArcMode>('routes');
  const [arcView, setArcView] = useState<Json | null>(null);
  const [arcVeh, setArcVeh] = useState<number | 'all'>('all');
  // a preview of a method's candidate reduction with the settings being edited (model inference + policy, no solve)
  const [preview, setPreview] = useState<Json | null>(null);
  const [runScope, setRunScope] = useState<'scenario' | 'all'>('scenario');
  const [checked, setChecked] = useState<string[]>([]);
  const [edits, setEdits] = useState<Settings>({});
  useEffect(() => setEdits({}), [cid]);
  const [job, setJob] = useState<Json | null>(null);
  const [jobTarget, setJobTarget] = useState('');
  const [opts, setOpts] = useState<RunOptions>({ repetitions: 3, variant: '' });
  const [picked, setPicked] = useState<string[]>([]);
  const [wizardData, setWizardData] = useState<{ area_id?: string; dataset_key?: string } | null>(null);
  const [wizardInitial, setWizardInitial] = useState<WizardProps['initial']>(null);
  const [title, setTitle] = useState(tr('Experiment {stamp}', { stamp: stamp() }));
  const [addMethod, setAddMethod] = useState(false);
  const [guide, setGuide] = useState(false);
  const [samplesGuide, setSamplesGuide] = useState(false);
  const [tripsGuide, setTripsGuide] = useState(false);
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
  // display selection (independent of what was run) and the view: a saved study, or the experiment's own records
  const [hiddenRows, setHiddenRows] = useState<string[]>([]);
  const recordsRef = useRef(false);
  useEffect(() => { setHiddenRows([]); recordsRef.current = false; }, [cid]);
  const [focus, setFocus] = useState<{ key: string; bbox: [number, number, number, number] } | null>(null);
  const isNew = cid === NEW;
  const problemId = exp?.campaign.problem_id ?? RIDE;
  const methods = useMethods(problemId, setErr, methodsKey);
  // the scenario editor builds scenarios of the ride-matching problem whatever experiment is open (a benchmark of
  // another problem, for instance): it offers that problem's methods, never the open experiment's
  const rideMethods = useMethods(problemId === RIDE ? '' : RIDE, setErr, methodsKey);
  const editorMethods = problemId === RIDE ? methods : rideMethods;
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
        setNotice(tr('Loading the demonstration experiment…'));
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
      if (fresh?.hashes?.length) { setPicked(fresh.hashes); notify(tr('{label} selected for a new experiment. Choose the methods on the right and press Run.', { label: fresh.label }), NEW); go('workspace', NEW, true); }
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
  const loadExp = useCallback((id: string) => Promise.all([lab.experiment(id, recordsRef.current ? 'records' : ''), firstState.catch(() => null)]).then(([e, s0]) => {
    if (cidRef.current !== id) return;
    setExp(e);
    // an experiment that is still running (started elsewhere, e.g. Library › Benchmarks, or before a reload): follow its job
    if (e.campaign.status === 'running' && e.job_id) call<Json>(`/jobs/${e.job_id}`).then((j) => { if (cidRef.current === id && j.state === 'running') { setJobTarget(id); setJob((cur) => cur ?? j); } }).catch(() => { /* progress only */ });
    if (!research) lab.prefs({ last_experiment: id }).catch(() => { /* preference only */ });
    // coming back to the experiment of the saved view restores what was shown (only what still exists in it)
    const v: WorkspaceView | null = !research && restored.current !== id && s0?.preferences.workspace?.campaign_id === id ? s0.preferences.workspace : null;
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
      // a study opens on its featured scenario; otherwise the first one
      const featured = e.view?.study?.featured_instance;
      setHash((h) => (hasHash(h) ? h : featured && hasHash(featured) ? featured : e.scenarios[0]?.instance_hash ?? ''));
      setChecked(scopeMethods(e));
      setSelected((k) => (rows.some((r) => rowKey(r) === k) ? k : pick ? rowKey(pick) : ''));
    }
    restored.current = id;
  }).catch((x) => { if (cidRef.current === id) { setExp(null); setErr(errText(x)); } }), [firstState, research]);
  methodsRef.current = methods.map(methodKey);
  // the view is saved for the account as the researcher works (after the restore, so a visit never erases it)
  useEffect(() => {
    if (research || !exp || isNew || exp.campaign.campaign_id !== cid || restored.current !== cid) return;
    const t = window.setTimeout(() => lab.prefs({ workspace: { campaign_id: cid, instance_hash: hash, methods: checked, result: selected, scope, map: mapView } })
      .catch(() => { /* preference only */ }), 700);
    return () => window.clearTimeout(t);
  }, [research, exp, cid, isNew, hash, checked, selected, scope, mapView]);
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
  const mapOk = hasCap(exp, 'map');
  // a clicked vehicle or rider marker: what the scenario records about it (and what the problem adds)
  const [inspect, setInspect] = useState<string | null>(null);
  const [props, setProps] = useState<{ properties: Record<string, [string, string][]>; authoring_note: string | null } | null>(null);
  useEffect(() => { setInspect(null); setProps(null); if (hash && mapOk) geo.participants(hash).then(setProps).catch(() => setProps(null)); }, [hash, mapOk]);
  useEffect(() => {
    let live = true;
    setInst(null);
    if (hash && mapOk) geo.instance(hash).then((i) => live && setInst(i)).catch((e) => live && setErr(errText(e)));
    return () => { live = false; };
  }, [hash, mapOk]);
  useEffect(() => {
    let live = true;
    setPlan(null);
    const run = exp?.runs.find((r) => r.instance_hash === hash && rowKey(r) === selected);
    if (exp && run && hasCap(exp, 'playback')) geo.playback(run.campaign_id, run.run_id).then((p) => live && setPlan(p)).catch((e) => live && setErr(errText(e)));
    return () => { live = false; };
  }, [exp, hash, selected]);
  const arcRun = hasCap(exp, 'candidates') ? exp?.runs.find((r) => r.instance_hash === hash && rowKey(r) === selected) : undefined;
  const arcOn = (!!arcRun || !!preview) && arcMode !== 'routes';
  useEffect(() => { setPreview(null); setArcVeh('all'); }, [cid, hash]);   // a new subject starts with every vehicle
  useEffect(() => {
    let live = true;
    setArcView(null);
    if (arcOn && arcRun && !preview) geo.candidates(arcRun.campaign_id, arcRun.run_id).then((v) => { if (!live) return; setArcView(v); setArcVeh((x) => (x === 'all' || v.vehicles.some((y: Json) => y.vehicle_id === x) ? x : 'all')); })
      .catch((e) => live && setErr(errText(e)));
    return () => { live = false; };
  }, [arcOn, arcRun?.campaign_id, arcRun?.run_id, !!preview]); // eslint-disable-line react-hooks/exhaustive-deps
  const runPreview = (m: MethodRef) => once(async () => {
    const v = await post('/geo/candidates/preview', { campaign_id: cid, instance_hash: hash, method_id: m.method_id, method_config: methodConfig(m, edits, exp) });
    setPreview(v); setArcMode('after'); setArcVeh('all');
  });

  const chooseRecords = (r: boolean) => { recordsRef.current = r; setHiddenRows([]); if (cid && !isNew) loadExp(cid); };
  // one Compare entry: methods on the same scenarios when there are several, else experiments
  const openCompare = () => go((exp?.results?.rows.length ?? 0) > 1 ? 'methods' : 'compare', cid);
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

  // map layers: the candidate reduction of the selected run (Before / After / Solution), else its routes, else the
  // scenario's participants, else the chosen area
  const arcData = preview ?? arcView;
  const arc = useMemo(() => (arcOn && arcData ? arcLayers(arcData, preview && arcMode === 'solution' ? 'after' : arcMode, arcVeh) : null), [arcOn, arcData, preview, arcMode, arcVeh]);
  const { points, lines } = useMemo(() => arc ?? (plan ? planLayers(plan) : instanceLayers(inst, false)), [arc, plan, inst]);
  const dynamic: MapPoint[] = replaying && plan && !arc ? planPositions(plan, replay.t) : [];
  const rects = isNew && area ? [{ bbox: area.bbox, color: COLORS.area }] : [];

  // run: new experiment -> create; draft -> execute; locked -> re-execute (same methods) or extend (added methods)
  const execute = async (target: string) => { const j = await post(`/campaigns/${target}/execute`); setJobTarget(target); setJob(j); };
  const derive = (kind: 'reproduce' | 'extend') => once(async () => {
    const added = checked.filter((k) => !(exp ? scopeMethods(exp) : []).includes(k)).map((k) => k.split('@'));
    const r = kind === 'extend' ? await post(`/campaigns/${cid}/extend`, { methods: added }) : await post(`/campaigns/${cid}/reproduce`);
    await execute(r.campaign_id);
  });
  // solver settings that differ from what the experiment records (validated by the server before anything is stored)
  const pending = changedSettings(methods, edits, isNew ? null : exp);
  const run = () => {
    setNotice(null);                                  // a notice about the previous step is stale once a run starts
    if (isNew) return once(async () => {
      const ids = new Set(checked.map((k) => k.split('@')[0]));
      const method_configs = Object.fromEntries(Object.entries(pending).filter(([m]) => ids.has(m)));
      const c = await post('/campaigns', { problem_id: RIDE, title, scenario_params: { instance_hashes: picked }, methods: checked.map((k) => k.split('@')), repetitions: opts.repetitions, timeout_s: 120, method_configs });
      setEdits({});
      await execute(c.campaign_id);
    });
    if (!exp) return;
    // changed solver settings on a frozen experiment: a new experiment version; the locked original is never modified
    if (exp.campaign.locked && Object.keys(pending).length) return once(async () => {
      // only the methods whose settings changed run, on the shown scenario or on all of them
      const c = await post(`/campaigns/${cid}/settings`, { method_configs: pending, ...(runScope === 'scenario' && hash ? { instance_hashes: [hash] } : {}) });
      setEdits({}); setPreview(null);
      await execute(c.campaign_id);
    });
    if (exp.campaign.locked) return derive(checked.some((k) => !scopeMethods(exp).includes(k)) ? 'extend' : 'reproduce');
    if (exp.campaign.status === 'draft') return once(() => execute(cid));
  };
  const runBlocked = !!job || busy || (isNew ? !picked.length || !checked.length : !exp || (!exp.campaign.locked && exp.campaign.status !== 'draft'));
  // why Run cannot start now, in one actionable sentence (shown when pressed, instead of a silently disabled button)
  const runWhyNot = isNew ? (!picked.length ? tr('Choose at least one scenario (left), or Generate one.') : !checked.length ? tr('Tick at least one method (right).') : null)
    : !exp ? tr('Choose an experiment.') : !exp.campaign.locked && exp.campaign.status === 'completed' ? tr('Lock the results first (below the results); Run again then re-executes the frozen experiment.')
    : !exp.campaign.locked && exp.campaign.status !== 'draft' ? tr('This experiment is still running.') : null;
  // an action asked on the Compare page for this experiment (add a method, reproduce): done once it is open here
  useEffect(() => {
    if (!exp || exp.campaign.campaign_id !== cid) return;
    let a: { action?: string; cid?: string } | null = null;
    try { const raw = sessionStorage.getItem(OPEN_ACTION); a = raw ? JSON.parse(raw) : null; } catch { a = null; }
    if (!a || a.cid !== cid) return;
    takeHandOff(OPEN_ACTION);
    if (a.action === 'add-method') setAddMethod(true);
    else if (a.action === 'reproduce' && exp.campaign.locked) derive('reproduce');
  }, [exp, cid]); // eslint-disable-line react-hooks/exhaustive-deps
  const adding = !!exp?.campaign.locked && checked.some((k) => !scopeMethods(exp).includes(k));
  const runTitle = isNew ? tr('Choose scenarios and methods') : exp?.campaign.locked ? tr('Re-executes this frozen experiment (or extends it with the methods you added)') : exp && exp.campaign.status === 'completed' ? tr('Lock the results first') : '';
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
  // an imported scenario (scenario package or the sample scenario): selected in a new experiment, methods chosen on the right
  const openScenarioInNew = (hash: string, label: string, networkId: string | null) => {
    setImporting(false); setSamplesGuide(false); reloadLists();
    if (area && networkId && area.network_id !== networkId) setAreaFilter(ALL_AREAS);    // the area filter would hide it
    setPicked([hash]); notify(tr('{label} selected for a new experiment. Choose the methods on the right and press Run.', { label }), NEW); go('workspace', NEW);
    lab.state().then(setSt).catch(() => { /* state refresh only */ });
  };
  // a different CO₂ calculation or baseline: a new experiment on the same frozen scenarios (the original is untouched)
  const recalcCo2 = (scope: string, baseline: string) => once(async () => {
    if (!exp) return;
    const title = `${exp.campaign.title} · ${tr(SCOPE_LABEL[scope] ?? scope)}, ${tr(BASELINE_LABEL[baseline] ?? baseline).toLowerCase()}`.slice(0, 160);
    const r = await post<{ campaign_id: string; job: Json }>('/lab/run', { title, methods: exp.methods.map((m) => [m.method_id, m.version]), repetitions: exp.campaign.repetitions,
      instance_hashes: exp.scenarios.map((s) => s.instance_hash), emissions: { scope, baseline } });
    setJobTarget(r.campaign_id); setJob(r.job); await reloadExperiments();
  });
  // other vehicles or parameter values: the wizard opens on a new version of the shown frozen scenario
  const editVehicles = () => editScenario();
  // participants or vehicles edited from the Workspace: the wizard opens on a NEW version of the shown frozen scenario
  // (straight at the participants step for + Driver / + Rider / Randomize); the frozen scenario and its results stay
  const editScenario = (action?: 'driver' | 'rider' | 'randomize' | 'edit', select?: string) => act(async () => {
    const inst = await geo.instance(hash); const sc = exp?.scenarios.find((s) => s.instance_hash === hash);
    const drivers = inst.drivers as Json[], def = inst.vehicles?.default as Json | undefined;
    const profiles = Array.from(new Map([...drivers.map((d) => d.vehicle), def].filter(Boolean).map((p: Json) => [p.id, p])).values());
    const defId = def?.id ?? profiles[0]?.id;
    const agent = (a: Json) => ({ id: a.id, origin: a.origin, destination: a.destination, earliest: a.earliest, latest: a.latest });
    setWizardInitial({ fromInstance: hash, action, select, scenario: { name: `${sc?.name ?? tr('Scenario')} · ${action ? tr('edited') : tr('vehicles edited')}`.slice(0, 80), network_id: inst.network?.network_id,
      params: { max_detour_s: inst.params.max_detour_s, max_detour_ratio: inst.params.max_detour_ratio }, drivers: drivers.map(agent), riders: (inst.riders as Json[]).map(agent),
      vehicles: { profiles, default: defId, assignments: Object.fromEntries(drivers.filter((d) => d.vehicle && d.vehicle.id !== defId).map((d) => [d.id, d.vehicle.id])) },
      emissions: exp?.campaign.emissions ?? inst.emissions } });
    setWizard(true);
  });
  // one method on the open experiment's frozen scenarios: a locked experiment is extended (never changed in place)
  const runWithMethod = (id: string, ver: string) => {
    const key = `${id}@${ver}`;
    if (isNew || !exp) { setChecked(Array.from(new Set([...checked, key]))); setAddMethod(false); notify(tr('Method ticked: choose scenarios and press Run.'), NEW); return; }
    if (!exp.campaign.locked) { setAddMethod(false); setErr(exp.campaign.status === 'draft' ? tr('This experiment has not run yet: tick the method in the Methods list, then Run.') : tr('Lock the results first (Lock results, below the results); then the method runs as an extension of this experiment.')); return; }
    setAddMethod(false); setNotice(null);
    once(async () => { const r = await post(`/campaigns/${cid}/extend`, { methods: [[id, ver]] }); await execute(r.campaign_id); });
  };
  const runNote = isNew || !exp ? tr('Adds the method to the new experiment.') : exp.campaign.locked ? tr('Runs it on the same frozen scenarios as an extension; this experiment stays unchanged.') : tr('Lock the results first; then it runs as an extension.');
  const variant = () => once(async () => { const r = await post(`/campaigns/${cid}/variant`, { variant: opts.variant }); await execute(r.campaign_id); });
  const parentTitle = exp?.campaign.parent ? experiments.find((x) => x.campaign_id === exp.campaign.parent!.campaign_id)?.title ?? null : null;
  const geographic = !exp || hasCap(exp, 'map');
  const traceId = job ? null : exp?.job_id ?? lastJob;
  const variantOf = (id: string) => experiments.find((x) => x.parent === id && x.kind === 'variant' && !x.hidden);
  const showStart = !!st && !st.preferences.start_dismissed && !!current?.demo && !!exp?.results;
  const dismissStart = () => lab.prefs({ start_dismissed: true }).then(setSt).catch(() => { /* preference only */ });
  if (!cfg) return <ErrorNote text={err} />;

  return <div className={`lab ${expanded ? 'expanded' : ''}`}>
    <TopBar experiments={experiments} current={current} areaFilter={areaFilter} setAreaFilter={chooseArea} setExp={(id) => go('workspace', id)}
      onGenerate={() => setWizard(true)} onRun={() => (runWhyNot ? setErr(runWhyNot) : run())} runLabel={adding ? 'extend' : exp?.campaign.locked ? 'again' : 'run'} runDisabled={!!job || busy} runTitle={runWhyNot ?? (adding ? tr('Runs the added methods on the same frozen scenarios as an extension; this experiment stays unchanged') : runTitle)}
      onCompare={openCompare} canCompare={!!exp?.results} comparePrimary={!!exp?.results && !isNew && exp.campaign.status !== 'draft'}
      onImport={() => setImporting(true)} onTrySample={() => setSamplesGuide(true)} sampleAvailable={samplesOffered(st).any} onTryTrips={st?.sample_trips ? () => setTripsGuide(true) : undefined}
      onExport={() => setExporting(true)} canExport={!!exp && (exp.campaign.locked || exp.campaign.status === 'completed')}
      onPanel={(p) => setPanel(panel === p ? null : p)} onLibrary={() => go('data', 'library')} />
    {(err || notice) && <div className="lab-notes">{err && <ErrorNote text={err} />}{notice && <p className="note ok row gap" role="status">{notice}<span className="grow" /><button className="btn sm" onClick={() => setNotice(null)}>{tr('OK')}</button></p>}</div>}
    <div className="lab-grid">
      <aside className={`lab-left ${panel === 'left' ? 'open' : ''}`} data-tour="scenario" aria-label={tr('scenario')}>
        {isNew ? <NewExperimentPanel lib={shownLib} picked={picked} setPicked={setPicked} title={title} setTitle={setTitle} onGenerate={() => setWizard(true)} onRun={run} canRun={!runBlocked} runTitle={runTitle} />
          : exp ? <ScenarioPanel exp={exp} hash={hash} setHash={setHash} inst={inst} plan={plan} parentTitle={parentTitle} onDetails={() => go('experiments', `c:${cid}`)}
            hidden={hiddenIds.includes(cid)} onHide={toggleHidden}
            onFocus={(la, lo) => { setPanel(null); setFocus({ key: `${la},${lo},${Date.now()}`, bbox: [la - 0.004, lo - 0.006, la + 0.004, lo + 0.006] }); }}
            onEdit={exp.campaign.problem_id === RIDE && hash ? editScenario : undefined} detailsOpen={!!st?.preferences.details_open}
            setDetailsOpen={(open) => lab.prefs({ details_open: open }).then(setSt).catch(() => { /* preference only */ })} />
          : <p className="muted panel-body">{st ? tr('Choose an experiment.') : tr('Loading…')}</p>}
      </aside>
      <main className="lab-centre" data-tour="map">
        {geographic ? <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={points} lines={lines} rects={rects} dynamic={dynamic}
          fitKey={isNew ? `new:${areaFilter}` : `${cid}|${hash}|${inst ? 1 : 0}${plan ? 'p' : ''}${arc ? `|arc:${arcRun?.run_id}` : ''}`} focus={focus} height="100%"
          restore={!isNew && !arc && restoreView?.key === `${cid}|${hash}` ? restoreView.view : null} onView={isNew ? undefined : onMapView}
          onPoint={isNew ? undefined : (p) => p.ref && setInspect(p.ref)} />
          : <div className="panel-body">{exp?.results ? <WorkspaceCharts exp={exp} /> : <p className="muted">{tr('This problem has no map; results appear here as charts once the experiment has run.')}</p>}</div>}
        {showStart && <div className="mapcard start-card" role="region" aria-label={tr('start here')}>
          <div className="row gap"><span className="start-ico"><BadgeCheck size={18} /></span>
            <div className="grow"><b>{t('ws.start.title')}</b><div className="small muted">{tr('Demand sampled from RPC 2026-10 observed trips · Montbéliard road network · {methods} methods · {runs} runs, each validated', { methods: exp!.methods.length, runs: exp!.validation.runs })}</div></div>
            <button className="btn icon ghost sm" aria-label={tr('dismiss')} onClick={dismissStart}><X size={14} /></button></div>
          <div className="row gap start-actions">
            {variantOf(cid) && <button className="btn primary sm" onClick={() => go('compare', `${cid}|${variantOf(cid)!.campaign_id}`)}><GitCompareArrows size={14} /> {t('ws.start.compare')}</button>}
            <button className="btn sm" onClick={() => setWizard(true)}><Plus size={14} /> {t('ws.start.generate')}</button>
            <button className="btn sm" disabled={!st?.sample.available} onClick={() => setGuide(true)}><PackageOpen size={14} /> {t('ws.start.import')}</button>
            {st?.sample_trips && <button className="btn sm" onClick={() => setTripsGuide(true)}>{tr('Try the sample trip dataset')}</button>}
            {!st?.preferences.tour_dismissed && <button className="btn sm ghost" onClick={() => { dismissStart(); setTour(true); }}>{tr('Quick tour')}</button>}</div></div>}
        {geographic && (arcRun || preview) && <div className="mapcard arc-switch" role="group" aria-label={tr('candidate reduction')}>
          <div className="seg">{ARC_MODES.filter(([m]) => !(preview && m === 'solution')).map(([m, label, title]) => <button key={m} className={arcMode === m ? 'on' : ''} aria-pressed={arcMode === m} title={tr(title)}
            onClick={() => { setArcMode(m); if (m === 'routes') setPreview(null); }}>{tr(label)}</button>)}</div>
          {arcOn && arcData && <select aria-label={tr('vehicle')} value={String(arcVeh)} onChange={(e) => setArcVeh(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">{tr('All vehicles · {pct} % removed', { pct: arcData.counts.reduction_pct })}</option>{(arcData.by_vehicle as Json[] ?? arcData.vehicles as Json[]).map((x) => <option key={x.vehicle_id} value={x.vehicle_id}>{x.label}{x.reduction_pct != null ? ` · ${tr('{pct} % removed', { pct: x.reduction_pct })}` : ''}</option>)}</select>}</div>}
        {geographic && arc && arcData && <div className="mapcard legend" aria-label={tr('legend')}>
          <span className="strong">{arcData.method_label}{arcData.policy?.threshold != null ? ` · ${tr('threshold {value}', { value: Number(arcData.policy.threshold).toPrecision(3) })}` : ''}</span>
          {arcMode === 'before' && <span><i className="lg-line" style={{ borderColor: ARC.candidate }} />{tr('{n} candidate vehicle-edges', { n: arc.counts.candidates.toLocaleString(locale()) })}</span>}
          {arcMode === 'after' && <><span><i className="lg-line" style={{ borderColor: ARC.retained }} />{tr('Retained {n}', { n: arc.counts.retained.toLocaleString(locale()) })}</span>
            <span><i className="lg-dash" style={{ borderColor: ARC.removed }} />{tr('Removed {n} ({pct} %)', { n: arc.counts.removed.toLocaleString(locale()), pct: arc.counts.candidates ? (100 * arc.counts.removed / arc.counts.candidates).toFixed(1) : '0.0' })}</span>
            <span><i className="lg-line" style={{ borderColor: ARC.protected }} />{arcData.policy.structural_rule ? tr('Kept by the structural rule {n}', { n: arc.counts.protected.toLocaleString(locale()) }) : tr('No structural rule in this policy')}</span></>}
          {arcMode === 'solution' && <><span><i className="lg-line" style={{ borderColor: ARC.selected }} />{tr('Used by the solution {n}', { n: arc.counts.selected.toLocaleString(locale()) })}</span>
            <span><i className="lg-line" style={{ borderColor: ARC.retained, opacity: 0.4 }} />{tr('Retained, not used')}</span></>}
          {arcData.reference_retention && <span title={arcData.reference_retention.note}>{tr('Reference arcs kept {kept}/{total} (retrospective; reference {quality})', { kept: arcData.reference_retention.retained, total: arcData.reference_retention.positives, quality: tr(String(arcData.reference_retention.reference_quality).toLowerCase().replace(/_/g, ' ')) })}</span>}
          <span className="muted" title={arcData.geometry}>{tr('straight lines: logical stop edges, not roads')} · {preview ? tr('preview: model inference + policy, nothing solved') : arcData.executed_here ? tr('run executed here') : arcData.imported ? tr('imported run (computed elsewhere, re-validated here)') : tr('archived run')}</span></div>}
        {geographic && plan && !arc && <div className="mapcard legend" aria-label={tr('legend')}>
          <span><i className="lg-line" style={{ borderColor: MAP.shared }} />{tr('Shared ride')}</span><span><i className="lg-dash" style={{ borderColor: MAP.alone }} />{tr('Drives alone')}</span>
          <span><i className="lg-sq" style={{ background: MAP.start }} /><CarIcon size={14} />{tr('Driver start')}</span>
          <span title={tr('arrow up, filled: pick-up · arrow down, hollow: drop-off')}><Ico html={legendIcon('pickup', MAP.stop)} /><Ico html={legendIcon('dropoff', MAP.stop)} />{tr('Pick-up / drop-off')}</span><span><Ico html={legendIcon('unserved', MAP.unmatched)} />{tr('Rider not matched')}</span>
          <PowertrainKey list={powertrainsOf((plan.vehicles as Json[]).map((v) => v.vehicle))} /></div>}
        {geographic && !plan && inst && !isNew && <div className="mapcard legend" aria-label={tr('legend')}>
          <span><i className="lg-sq" style={{ background: COLORS.driver }} /><CarIcon size={14} />{tr('Driver start')}</span>
          <span><Ico html={legendIcon('rider', COLORS.rider)} />{tr('Rider start')}</span>
          <span title={tr('destinations are hollow')}><i className="dot hollow" style={{ borderColor: COLORS.driver }} /><i className="dot hollow" style={{ borderColor: COLORS.rider }} />{tr('Destination')}</span>
          <PowertrainKey list={powertrainsOf((inst.drivers as Json[]).map((d) => d.vehicle))} /></div>}
        {geographic && inspect && inst && !isNew && <InspectCard id={inspect} inst={inst} plan={arc ? null : plan} extra={props?.properties[inspect] ?? []} note={props?.authoring_note ?? exp?.problem.presentation?.authoring_note ?? null}
          onEdit={exp?.campaign.problem_id === RIDE && hash ? () => { setInspect(null); editScenario('edit', inspect); } : undefined} onClose={() => setInspect(null)} />}
        {geographic && plan && !replaying && !arc && <button className="mapcard replay-pill" onClick={() => setReplaying(true)} data-tour="replay"><Play size={14} /> {tr('Replay routes')}</button>}
        {geographic && <button className={`mapcard map-expand ${expanded ? 'on' : ''}`} aria-pressed={expanded} aria-label={expanded ? tr('Exit expanded map') : tr('Expand the map')}
          title={expanded ? tr('Back to the workspace layout (Esc)') : tr('Expand the map: panels open on demand, actions stay in the bar above')} onClick={() => { setPanel(null); setExpanded(!expanded); }}>
          {expanded ? <><Minimize2 size={15} /> {tr('Exit expanded map')} <kbd>Esc</kbd></> : <Maximize2 size={15} />}</button>}
        {replaying && plan && <ReplayBar plan={plan} replay={replay} onClose={() => setReplaying(false)} />}
      </main>
      <aside className={`lab-right ${panel === 'right' ? 'open' : ''}`} aria-label={tr('results')}>
        <ResultPanel exp={isNew ? null : exp} methods={methods} checked={checked} setChecked={setChecked} job={job} onJobDone={jobDone} setErr={setErr}
          selected={selected} setSelected={setSelected}
          onLock={() => act(async () => { await post(`/campaigns/${cid}/lock`); await loadExp(cid); await reloadExperiments(); })}
          opts={opts} setOpts={setOpts} variants={(problem?.variants ?? []).filter((v) => v.instance_level)} onVariant={variant}
          onWhy={() => exp?.comparability && go('experiments', `sem:${exp.comparability.reference}|${cid}`)}
          onRecalcCo2={exp?.campaign.problem_id === RIDE ? recalcCo2 : undefined} onEditVehicles={exp?.campaign.problem_id === RIDE && hash ? editVehicles : undefined}
          onTrace={traceId ? () => setTrace(traceId) : null} onAddMethod={() => setAddMethod(true)} hash={hash} scope={scope} setScope={setScope}
          edits={edits} setEdits={setEdits} onPreview={hasCap(exp, 'candidate-preview') && !isNew ? runPreview : undefined}
          runScope={runScope} setRunScope={setRunScope} hiddenRows={hiddenRows} setHiddenRows={setHiddenRows} setRecords={chooseRecords} />
      </aside>
    </div>
    {addMethod && <AddMethod problemId={problemId} onClose={() => setAddMethod(false)} onChanged={() => setMethodsKey((k) => k + 1)} setErr={setErr}
      onRun={runWithMethod} done={exp && !isNew ? scopeMethods(exp) : []} runNote={runNote} />}
    {exporting && exp && <ExportDialog cid={cid} title={exp.campaign.title} setErr={setErr} onClose={() => setExporting(false)} onDone={() => { loadExp(cid); reloadExperiments().catch(() => { /* list refresh only */ }); }} />}
    {importing && <ImportDialog sampleAvailable={!!st?.sample.available} setErr={setErr} onClose={() => setImporting(false)} onImported={imported} onReproduce={reproduceHere}
      onScenarioImported={(r) => openScenarioInNew(r.scenario.instance_hash, r.scenario.name, r.scenario.network_id ?? null)} />}
    {samplesGuide && st && <SamplesGuide scenario={st.sample_scenario} experiment={st.sample} setErr={setErr} onClose={() => setSamplesGuide(false)}
      onTryExperiment={() => { setSamplesGuide(false); setGuide(true); }} onOpenNew={openScenarioInNew} reload={reloadLists}
      onTryTrips={st.sample_trips ? () => { setSamplesGuide(false); setTripsGuide(true); } : undefined} />}
    {guide && st?.sample.available && <ImportGuide sample={st.sample} experiments={experiments} methods={methods} onClose={() => { setGuide(false); lab.state().then(setSt).catch(() => { /* */ }); }}
      onOpen={(id) => { setGuide(false); go('workspace', id); }} onCompare={(a, b) => { setGuide(false); go('compare', `${a}|${b}`); }}
      onAddMethod={() => setAddMethod(true)} reload={reloadExperiments} setErr={setErr} />}
    {tripsGuide && st?.sample_trips && <SampleTripsGuide sample={st.sample_trips} areaId={area?.area_id ?? st.demo.area ?? undefined} setErr={setErr} onClose={() => setTripsGuide(false)}
      onLibrary={() => { setTripsGuide(false); go('data', 'datasets'); }}
      onGenerate={(key) => { setTripsGuide(false); reloadLists(); setWizardData({ area_id: area?.area_id ?? st.demo.area ?? undefined, dataset_key: key }); setWizard(true); }} />}
    {trace && <TraceDrawer jobId={trace} onClose={() => setTrace(null)} />}
    {wizard && (!wizardData?.area_id || areas.length > 0) && <Wizard cfg={cfg} areas={areas.filter((a) => !hiddenIds.includes(a.area_id) || a.area_id === wizardData?.area_id)} datasets={datasets.filter((d) => !hiddenIds.includes(d.dataset_key) || d.dataset_key === wizardData?.dataset_key)} methods={editorMethods}
      areaId={wizardData?.area_id ?? area?.area_id ?? areas.find((a) => a.name === current?.area)?.area_id} datasetKey={wizardData?.dataset_key} setErr={setErr} reloadAreas={reloadLists} onAddMethod={() => setAddMethod(true)}
      initial={wizardInitial} onClose={() => { setWizard(false); setWizardData(null); setWizardInitial(null); }}
      onSaved={(rec) => { setWizard(false); setWizardData(null); setWizardInitial(null); reloadLists(); setPicked([rec.instance_hash]); notify(tr('Scenario saved. Choose the methods on the right and press Run.'), NEW); go('workspace', NEW); }}
      onRun={(r) => { setWizard(false); setWizardData(null); setWizardInitial(null); setNotice(null); setJobTarget(r.campaign_id); setJob(r.job);
        go('workspace', r.campaign_id); reloadLists(); reloadExperiments().catch(() => { /* list refresh only */ }); }} />}
    {tour && <Tour onClose={(never) => { setTour(false); if (never) lab.prefs({ tour_dismissed: true }).then(setSt).catch(() => { /* preference only */ }); }} />}
  </div>;
}

/** Letters on driver markers, for the vehicle types present. */
function PowertrainKey({ list }: { list: string[] }) {
  if (!list.length) return null;
  return <span title={tr('driver markers: colour and icon by vehicle type')}>{list.map((p) => { const st = GLYPH_STYLE[POWERTRAIN_GLYPH[p]] ?? GLYPH_STYLE['']; return <span key={p} className="lg-pt">
    <i className="lg-sq glyph" style={{ background: st.color }} aria-hidden="true"><svg viewBox="0 0 12 12" width="9" height="9" dangerouslySetInnerHTML={{ __html: st.icon }} /></i>{tr(PT_SHORT[p] ?? p)}</span>; })}</span>;
}
const PT_SHORT: Record<string, string> = { ICE: 'Combustion', HEV: 'Hybrid', PHEV: 'Plug-in hybrid', BEV: 'Electric' };

/** A map marker icon in a legend (static markup drawn by the map module). */
function Ico({ html }: { html: string }) { return <i className="lg-ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />; }
