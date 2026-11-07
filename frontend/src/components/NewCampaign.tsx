import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { call, post, type Json, type MethodRef, type Problem } from '../api/client';
import { errText } from './common';

/** Scenario-set form generated from the problem's declared parameters. */
export function NewCampaign({ problem, onCreated, setErr, preset }: { problem: Problem; onCreated: (id: string) => void; setErr: (s: string | null) => void; preset?: string[] | null }) {
  const [title, setTitle] = useState(`${problem.title} — baseline`);
  const [params, setParams] = useState<Json>({ ...problem.scenario_parameters.defaults, ...(preset ? { instance_hashes: preset } : {}) });
  const [library, setLibrary] = useState<Json[]>([]);
  const fromLibrary = problem.scenario_parameters.fields.some((f) => f.type === 'scenario-library');
  useEffect(() => { if (problem.scenario_parameters.fields.some((f) => f.type === 'scenario-library')) call('/geo/scenarios').then((r) => setLibrary(r.scenarios)).catch((e) => setErr(errText(e))); }, [problem, setErr]);
  // free text of list fields (parsed on every change, but displayed as typed)
  const [raw, setRaw] = useState<Record<string, string>>(() => Object.fromEntries(problem.scenario_parameters.fields
    .filter((f) => f.type === 'int-list').map((f) => [f.id, (problem.scenario_parameters.defaults[f.id] ?? []).join(', ')])));
  const [methods, setMethods] = useState<MethodRef[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [reps, setReps] = useState(3);
  const [timeout, setTimeoutS] = useState(120);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call(`/problems/${problem.spec.problem_id}/methods`).then((m) => {
      const regs: MethodRef[] = m.registered.map((r: Json) => ({ ...r, source: 'plugin' }));
      const all = [...m.builtin, ...regs];
      setMethods(all); setChosen(m.builtin.map((b: MethodRef) => `${b.method_id}@${b.version}`));
    }).catch((e) => setErr(errText(e)));
  }, [problem, setErr]);
  const toggle = (k: string, on: boolean) => setChosen(on ? [...chosen, k] : chosen.filter((x) => x !== k));
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const c = await post('/campaigns', { problem_id: problem.spec.problem_id, title, scenario_params: params, repetitions: reps, timeout_s: timeout,
        methods: chosen.map((k) => k.split('@')) });
      onCreated(c.campaign_id);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return <div className="form">
    <label>Title <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="title" /></label>
    {problem.scenario_parameters.fields.map((f) => <fieldset key={f.id}><legend>{f.label}</legend>
      {f.type === 'multi-choice' && f.choices?.map((ch) => { const cur: string[] = params[f.id] ?? []; return <label key={ch.id} className="row">
        <input type="checkbox" checked={cur.includes(ch.id)} onChange={(e) => setParams({ ...params, [f.id]: e.target.checked ? [...cur, ch.id] : cur.filter((x) => x !== ch.id) })} /> {ch.label}</label>; })}
      {f.type === 'int-list' && <input aria-label={f.label} value={raw[f.id] ?? ''}
        onChange={(e) => { setRaw({ ...raw, [f.id]: e.target.value }); setParams({ ...params, [f.id]: e.target.value.split(/[\s,]+/).filter(Boolean).map(Number) }); }} />}
      {f.type === 'scenario-library' && (library.length === 0 ? <p className="small muted">The scenario library is empty: create scenarios under “Scenarios &amp; maps”.</p> :
        library.map((s) => { const cur: string[] = params[f.id] ?? []; return <label key={s.scenario_id} className="row">
          <input type="checkbox" checked={cur.includes(s.instance_hash)} onChange={(e) => setParams({ ...params, [f.id]: e.target.checked ? [...cur, s.instance_hash] : cur.filter((x) => x !== s.instance_hash) })} />
          <b>{s.name}</b> <span className="small muted">{s.source} · {s.drivers} drivers · {s.riders} riders</span></label>; }))}
      {f.help && <p className="small muted">{f.help}</p>}
    </fieldset>)}
    <fieldset><legend>Methods</legend>{methods.map((m) => { const k = `${m.method_id}@${m.version}`; return <label key={k} className="row">
      <input type="checkbox" checked={chosen.includes(k)} onChange={(e) => toggle(k, e.target.checked)} /> <b>{m.name}</b> <span className="mono small">{k}</span>
      <span className="small muted">{m.kind} · {m.source === 'builtin' ? 'built-in' : 'registered plugin'}</span></label>; })}</fieldset>
    <div className="row gap">
      <label>Repetitions <input type="number" min={1} max={20} value={reps} onChange={(e) => setReps(Number(e.target.value))} aria-label="repetitions" /></label>
      <label>Timeout per run (s) <input type="number" min={1} max={3600} value={timeout} onChange={(e) => setTimeoutS(Number(e.target.value))} aria-label="timeout" /></label>
    </div>
    <button className="btn primary" disabled={busy || chosen.length === 0} onClick={create}><Plus size={13} /> {fromLibrary ? 'Create campaign' : 'Generate scenarios & create campaign'}</button>
  </div>;
}
