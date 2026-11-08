import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Plus, Puzzle, Upload } from 'lucide-react';
import { call, type Json, type Problem } from '../api/client';
import { Playback } from '../geo/Playback';
import { CampaignView } from './CampaignView';
import { Compare } from './Compare';
import { ImportBundle } from './ImportBundle';
import { Methods } from './Methods';
import { NewCampaign } from './NewCampaign';
import { Reproducibility } from './Reproducibility';
import { Semantic } from './Semantic';
import { ThresholdReport } from './ThresholdReport';
import { Workspace } from './Workspace';
import { ErrorNote, errText } from './common';

/** Experiment list and detail pages (campaign record, comparison report, reproducibility, semantic comparability,
 *  threshold study, playback). ``view`` comes from the URL: '' (list), new, import, methods, c:<id>, cmp:<id>, … */
export function ExperimentsSection({ view, go, preset, clearPreset }: { view: string; go: (v: string) => void; preset: string[] | null; clearPreset: () => void }) {
  const [problems, setProblems] = useState<Problem[]>([]);
  const [pid, setPid] = useState('');
  const [list, setList] = useState<Json[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const problem = problems.find((p) => p.spec.problem_id === pid) ?? null;
  useEffect(() => {
    call<{ problems: Problem[] }>('/problems').then((r) => {
      setProblems(r.problems);
      const ride = r.problems.find((p) => p.scenario_parameters.fields.some((f) => f.type === 'scenario-library'));
      setPid((preset && ride ? ride : r.problems.find((p) => !p.synthetic) ?? r.problems[0])?.spec.problem_id ?? '');
    }).catch((e) => setErr(errText(e)));
  }, [preset]);
  const reload = useCallback(() => {
    if (pid) call(`/campaigns?problem_id=${encodeURIComponent(pid)}`).then((r) => setList(r.campaigns)).catch((e) => setErr(errText(e)));
  }, [pid]);
  useEffect(() => { setErr(null); if (!view) reload(); }, [view, reload]);
  const arg = (p: string) => view.slice(p.length);
  return <div className="content">
    {problem && <section className="problem-head">
      <div className="row gap"><h1>{problem.title} {problem.synthetic && <span className="badge warn">SYNTHETIC DATA</span>}</h1><span className="grow" />
        {problems.length > 1 && <select aria-label="problem" value={pid} onChange={(e) => { setPid(e.target.value); go(''); }}>
          {problems.map((p) => <option key={p.spec.problem_id} value={p.spec.problem_id}>{p.title}</option>)}</select>}</div>
      <details className="small muted"><summary>About this problem</summary><p>{problem.description}</p>
        <p className="mono">{problem.spec.problem_id} · objective {problem.spec.objective_spec_id} · validator {problem.validator_version}</p></details>
    </section>}
    <nav className="row gap actions">
      {view && <button className="btn" onClick={() => go('')}><ArrowLeft size={13} /> Experiments</button>}
      {!view && problem && <>
        <button className="btn primary" onClick={() => go('new')}><Plus size={13} /> New campaign</button>
        <button className="btn" onClick={() => go('import')}><Upload size={13} /> Import bundle</button>
        <button className="btn" onClick={() => go('methods')}><Puzzle size={13} /> Methods &amp; extensions</button></>}
    </nav>
    <ErrorNote text={err} />
    {problem && !view && <Workspace list={list} onOpen={(id) => go(`c:${id}`)} />}
    {problem && view === 'new' && <NewCampaign key={problem.spec.problem_id + (preset ?? []).join()} problem={problem} preset={preset} onCreated={(id) => { clearPreset(); go(`c:${id}`); }} setErr={setErr} />}
    {problem && view === 'import' && <ImportBundle onImported={(id) => go(`c:${id}`)} setErr={setErr} />}
    {problem && view === 'methods' && <Methods problem={problem} setErr={setErr} />}
    {problem && view.startsWith('c:') && <CampaignView key={view + problem.spec.problem_id} id={arg('c:')} problem={problem} go={go} setErr={setErr} onProblem={setPid} />}
    {problem && view.startsWith('cmp:') && <Compare id={arg('cmp:')} problem={problem} setErr={setErr} />}
    {problem && view.startsWith('rep:') && <Reproducibility id={arg('rep:')} problem={problem} setErr={setErr} />}
    {problem && view.startsWith('sem:') && <Semantic ids={arg('sem:')} problem={problem} setErr={setErr} />}
    {problem && view.startsWith('thr:') && <ThresholdReport id={arg('thr:')} problem={problem} setErr={setErr} />}
    {problem && view.startsWith('play:') && <PlaybackLoader id={arg('play:')} setErr={setErr} />}
    {!problem && !err && <p className="muted">Loading…</p>}
  </div>;
}

function PlaybackLoader({ id, setErr }: { id: string; setErr: (s: string | null) => void }) {
  const [c, setC] = useState<Json | null>(null);
  useEffect(() => { call(`/campaigns/${id}`).then((r) => setC(r.campaign)).catch((e) => setErr(errText(e))); }, [id, setErr]);
  return c ? <><h2>Route playback — {c.title}</h2><Playback campaign={c} setErr={setErr} /></> : null;
}
