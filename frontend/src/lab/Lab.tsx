import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, download, post, type Json } from '../api/client';
import { TraceDrawer } from '../components/TraceDrawer';
import { ErrorNote, errText } from '../components/common';
import { COLORS, LeafletMap, type MapPoint } from '../geo/LeafletMap';
import { geo } from '../geo/api';
import { instanceLayers } from '../geo/GeoWorkbench';
import { Wizard } from '../mobility/Wizard';
import type { Section } from '../router';
import { lab, rowKey, scopeMethods, type Experiment, type LabState } from './api';
import { Charts } from './Charts';
import { ComparePanel } from './ComparePanel';
import { planLayers, planPositions } from './layers';
import { ReplayBar, useReplay } from './ReplayBar';
import { ResultPanel, methodKey, type RunOptions } from './ResultPanel';
import { NewExperimentPanel, ScenarioPanel } from './ScenarioPanel';
import { ALL, NEW, TopBar } from './TopBar';
import { Tour } from './Tour';
import { RIDE, overlaps, useLabData, useMethods } from './useLabData';

const AREA_KEY = 'move-openlab.area';
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

/** Map-first workspace: choose or load an experiment, inspect it on the map, run methods, compare, replay, share. */
export function Lab({ cid, go }: { cid: string; go: (s: Section, arg?: string, replace?: boolean) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { cfg, areas, datasets, experiments, lib, problems, reloadExperiments, reloadLists } = useLabData(setErr);
  const [st, setSt] = useState<LabState | null>(null);
  const [areaId, setAreaId] = useState(ALL);
  const [datasetKey, setDatasetKey] = useState(ALL);
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
  const [comparing, setComparing] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [tour, setTour] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [trace, setTrace] = useState<string | null>(null);
  const [lastJob, setLastJob] = useState<string | null>(null);
  const [panel, setPanel] = useState<'left' | 'right' | null>(null);
  const [focus, setFocus] = useState<{ key: string; bbox: [number, number, number, number] } | null>(null);
  const isNew = cid === NEW;
  const problemId = exp?.campaign.problem_id ?? RIDE;
  const methods = useMethods(problemId, setErr);
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

  // first use: the demonstration is imported once into this workspace; the tour opens until dismissed
  useEffect(() => {
    act(async () => {
      let s = await lab.state();
      if (s.demo.available && !s.demo.installed) {
        setNotice('Loading the demonstration experiment…');
        try { await lab.installDemo(); s = await lab.state(); } catch (e) { setErr(errText(e)); } finally { setNotice(null); }
      }
      const list = await reloadExperiments();
      if (s.preferences.area_id) setAreaId(s.preferences.area_id);
      const last = list.find((x) => x.campaign_id === s.preferences.last_experiment) ?? list[list.length - 1];
      if (!cid && last) go('workspace', last.campaign_id, true);
      setSt(s);
      if (!s.preferences.tour_dismissed) setTour(true);
    });
  }, []);                                                                    // eslint-disable-line react-hooks/exhaustive-deps

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
    setReplaying(false); setComparing(false); setPlan(null);
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

  // lists follow the selected area (and dataset); "All areas" shows everything
  const area = areas.find((a) => a.area_id === areaId) ?? null;
  const shownDatasets = useMemo(() => (area ? datasets.filter((d) => overlaps(d.bbox, area.bbox)) : datasets), [datasets, area]);
  const shownExps = useMemo(() => experiments.filter((x) => x.campaign_id === cid || (!x.hidden && (!area || (!!area.network_id && x.network_ids.includes(area.network_id)))
    && (!datasetKey || x.dataset_keys.includes(datasetKey)))), [experiments, area, datasetKey, cid]);
  const hiddenIds = st?.preferences.hidden_ids ?? [];
  const toggleHidden = () => act(async () => {
    const next = hiddenIds.includes(cid) ? hiddenIds.filter((x) => x !== cid) : [...hiddenIds, cid];
    setSt(await lab.prefs({ hidden_ids: next })); await reloadExperiments();
  });
  const shownLib = useMemo(() => (area ? lib.filter((s) => s.network_id === area.network_id) : lib), [lib, area]);
  const setArea = (id: string) => {
    setAreaId(id); setDatasetKey(ALL);
    try { if (id) localStorage.setItem(AREA_KEY, id); } catch { /* storage unavailable */ }
    lab.prefs({ area_id: id || null }).catch(() => { /* preference only */ });
  };

  // map layers: routes of the selected method, else the scenario's participants, else the selected area
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
    if (isNew) return once(async () => {
      const c = await post('/campaigns', { problem_id: RIDE, title, scenario_params: { instance_hashes: picked }, methods: checked.map((k) => k.split('@')), repetitions: opts.repetitions, timeout_s: 120 });
      await execute(c.campaign_id);
    });
    if (!exp) return;
    if (exp.campaign.locked) return derive(checked.some((k) => !scopeMethods(exp).includes(k)) ? 'extend' : 'reproduce');
    if (exp.campaign.status === 'draft') return once(() => execute(cid));
  };
  const runBlocked = !!job || busy || (isNew ? !picked.length || !checked.length : !exp || (!exp.campaign.locked && exp.campaign.status !== 'draft'));
  const runTitle = isNew ? 'Choose scenarios and methods' : exp && !exp.campaign.locked && exp.campaign.status === 'completed' ? 'Lock the results first' : '';
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
      setNotice(`Imported from ${rep.exported_by}: ${rep.files_checked} files verified, no code. Run reproduces it here.`);
      go('workspace', rep.root_campaign_id);
    } catch (e) { throw new Error(`Bundle rejected: ${errText(e)}`); }
  });
  const variant = () => once(async () => { const r = await post(`/campaigns/${cid}/variant`, { variant: opts.variant }); await execute(r.campaign_id); });
  const parentTitle = exp?.campaign.parent ? experiments.find((x) => x.campaign_id === exp.campaign.parent!.campaign_id)?.title ?? null : null;
  const geographic = !exp || exp.campaign.problem_id === RIDE;
  const traceId = job ? null : exp?.job_id ?? lastJob;
  if (!cfg) return <ErrorNote text={err} />;

  return <div className="lab">
    <TopBar areas={areas} areaId={areaId} setArea={setArea} datasets={shownDatasets} datasetKey={datasetKey} setDataset={setDatasetKey}
      experiments={shownExps} expId={cid} setExp={(id) => go('workspace', id)} onGenerate={() => setWizard(true)}
      onRun={run} runDisabled={runBlocked} runTitle={runTitle} onCompare={() => setComparing(true)} canCompare={!!exp?.results}
      onReplay={() => setReplaying(!replaying)} canReplay={!!plan} replaying={replaying} onImport={importBundle} onExport={exportBundle}
      canExport={!!exp && (exp.campaign.locked || exp.campaign.status === 'completed')} onTour={() => setTour(true)} onPanel={(p) => setPanel(panel === p ? null : p)} />
    {(err || notice) && <div className="lab-notes">{err && <ErrorNote text={err} />}{notice && <p className="note ok row gap" role="status">{notice}<span className="grow" /><button className="btn sm" onClick={() => setNotice(null)}>OK</button></p>}</div>}
    <div className="lab-grid">
      <aside className={`lab-left ${panel === 'left' ? 'open' : ''}`} data-tour="scenario" aria-label="scenario">
        {isNew ? <NewExperimentPanel lib={shownLib} picked={picked} setPicked={setPicked} title={title} setTitle={setTitle} onGenerate={() => setWizard(true)} />
          : exp ? <ScenarioPanel exp={exp} hash={hash} setHash={setHash} inst={inst} plan={plan} parentTitle={parentTitle} onDetails={() => go('experiments', `c:${cid}`)}
            hidden={hiddenIds.includes(cid)} onHide={toggleHidden}
            onFocus={(la, lo) => { setPanel(null); setFocus({ key: `${la},${lo},${Date.now()}`, bbox: [la - 0.004, lo - 0.006, la + 0.004, lo + 0.006] }); }} />
          : <p className="muted panel-body">{st ? 'Choose an experiment.' : 'Loading…'}</p>}
      </aside>
      <main className="lab-centre" data-tour="map">
        {geographic ? <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={points} lines={lines} rects={rects} dynamic={dynamic}
          fitKey={isNew ? `new:${areaId}` : `${cid}|${hash}|${inst ? 1 : 0}${plan ? 'p' : ''}`} focus={focus} height="100%" />
          : <div className="panel-body">{exp?.results ? <Charts metrics={exp.problem.metrics} rows={exp.results.rows} title={exp.campaign.title} /> : <p className="muted">This problem has no map; results appear here as charts once the experiment has run.</p>}</div>}
        {replaying && plan && <ReplayBar plan={plan} replay={replay} onClose={() => setReplaying(false)} />}
      </main>
      <aside className={`lab-right ${panel === 'right' ? 'open' : ''}`} aria-label="results">
        <ResultPanel exp={isNew ? null : exp} methods={methods} checked={checked} setChecked={setChecked} job={job} onJobDone={jobDone} setErr={setErr}
          selected={selected} setSelected={setSelected} onExport={exportBundle} onReproduce={() => derive('reproduce')} onExtend={() => derive('extend')}
          onLock={() => act(async () => { await post(`/campaigns/${cid}/lock`); await loadExp(cid); await reloadExperiments(); })}
          opts={opts} setOpts={setOpts} variants={(problem?.variants ?? []).filter((v) => v.instance_level)} onVariant={variant}
          onWhy={() => exp?.comparability && go('experiments', `sem:${exp.comparability.reference}|${cid}`)}
          onTrace={traceId ? () => setTrace(traceId) : null} />
      </aside>
    </div>
    {comparing && exp && <ComparePanel exp={exp} others={experiments.filter((x) => x.campaign_id !== cid && !x.hidden && x.problem_id === exp.campaign.problem_id)} onClose={() => setComparing(false)}
      onDetails={() => go('experiments', `${exp.campaign.kind === 'threshold-study' ? 'thr' : 'cmp'}:${cid}`)} onAB={(other) => go('compare', `${cid}|${other}`)} />}
    {trace && <TraceDrawer jobId={trace} onClose={() => setTrace(null)} />}
    {wizard && <Wizard cfg={cfg} areas={areas} datasets={datasets} methods={methods} areaId={areaId || undefined} setErr={setErr} reloadAreas={reloadLists}
      onClose={() => setWizard(false)}
      onSaved={(rec) => { setWizard(false); reloadLists(); setPicked([rec.instance_hash]); go('workspace', NEW); }}
      onRun={(r) => { setWizard(false); reloadLists(); setJobTarget(r.campaign_id); setJob(r.job); reloadExperiments().then(() => go('workspace', r.campaign_id)).catch(() => go('workspace', r.campaign_id)); }} />}
    {tour && <Tour onClose={(never) => { setTour(false); if (never) lab.prefs({ tour_dismissed: true }).catch(() => { /* preference only */ }); }} />}
  </div>;
}
