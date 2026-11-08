import { useState } from 'react';
import { Download, GitBranch, ListTree, Lock, RotateCcw } from 'lucide-react';
import type { Json, MethodRef } from '../api/client';
import { JobProgress } from '../components/JobProgress';
import { num, secs } from '../components/common';
import { dur } from '../geo/api';
import { BASELINE_LABEL, SCOPE_LABEL, grams, pct } from '../mobility/api';
import { rowLabel } from './Charts';
import { statusOf } from './ComparePanel';
import { VERDICT, rowKey, scopeMethods, type Experiment } from './api';

export interface RunOptions { repetitions: number; variant: string }

const metricText = (v: number | undefined, unit?: string) => (v == null ? '—' : unit === 's' ? dur(v) : num(v));

export function methodKey(m: { method_id: string; version: string }) { return `${m.method_id}@${m.version}`; }

/** Right panel: methods to run, live progress, key results (objective, runtime, CO₂ of the selected method),
 *  comparability with the parent, export / reproduce / extend, trace. */
export function ResultPanel({ exp, methods, checked, setChecked, job, onJobDone, setErr, selected, setSelected, onExport, onReproduce, onExtend, onLock, opts, setOpts, variants, onVariant, onWhy, onTrace }: {
  exp: Experiment | null; methods: MethodRef[]; checked: string[]; setChecked: (k: string[]) => void;
  job: Json | null; onJobDone: (j: Json) => void; setErr: (s: string | null) => void;
  selected: string; setSelected: (m: string) => void;
  onExport: () => void; onReproduce: () => void; onExtend: () => void; onLock: () => void;
  opts: RunOptions; setOpts: (o: RunOptions) => void; variants: { id: string; description: string }[]; onVariant: () => void; onWhy: () => void;
  onTrace: (() => void) | null;
}) {
  const [why, setWhy] = useState(false);
  const inExp = new Set(exp ? scopeMethods(exp) : []);
  const toggle = (k: string) => setChecked(checked.includes(k) ? checked.filter((x) => x !== k) : [...checked, k]);
  const rows = exp?.results?.rows ?? [];
  const cmp = exp?.comparability;
  const added = checked.filter((k) => !inExp.has(k));
  const sel = rows.find((r) => rowKey(r) === selected) ?? rows[0];
  const dom = sel?.domain;
  return <div className="panel-body">
    <section data-tour="methods" aria-label="methods">
      <h3>Methods</h3>
      <ul className="methods">{methods.map((m) => { const k = methodKey(m); return <li key={k}><label className="row">
        <input type="checkbox" aria-label={m.name} checked={checked.includes(k)} disabled={inExp.has(k) && exp?.campaign.locked === true} onChange={() => toggle(k)} />
        <span className="grow">{m.name}<span className="muted small"> · {m.kind}{m.source === 'plugin' ? ' · your method' : ''}</span></span></label></li>; })}</ul>
    </section>
    {job && <JobProgress job={job} setErr={setErr} onFinished={onJobDone} unit="runs" />}
    <section data-tour="results" aria-label="results">
      <h3>Results</h3>
      {rows.length === 0 ? <p className="small muted">{exp ? 'Not run yet.' : 'Choose scenarios and methods, then Run.'}</p> :
        <table className="compact" aria-label="results summary"><thead><tr><th>Method</th><th>Status</th>
          <th title={exp!.problem.objective.map((o) => exp!.problem.metrics.find((m) => m.id === o.metric)?.label ?? o.metric).join(', then ')}>Objective</th><th>Time</th></tr></thead>
          <tbody>{rows.map((r) => { const st = statusOf(r); const k = r.method_id + r.campaign_id;
            return <tr key={k} className={selected === rowKey(r) ? 'hl' : ''} onClick={() => setSelected(rowKey(r))} style={{ cursor: 'pointer' }} title="show on the map">
              <td>{rowLabel(r, rows)}</td><td><span className={`badge ${st.cls}`}>{st.label}</span></td>
              <td>{exp!.problem.objective.map((o) => metricText(r.totals[o.metric], exp!.problem.metrics.find((m) => m.id === o.metric)?.unit)).join(' · ')}</td><td>{secs(r.total_time_s)}</td></tr>; })}</tbody></table>}
      {dom && dom.complete && <dl className="facts emissions" aria-label="emissions">
        <dt>CO₂</dt><dd>{grams(dom.solution_g)} <span className="muted">· {SCOPE_LABEL[dom.scope] ?? dom.scope}{dom.basis === 'CO2e' ? ' · CO₂e' : ''}</span></dd>
        <dt>Baseline</dt><dd>{grams(dom.baseline_g)} <span className="muted">· {BASELINE_LABEL[dom.baseline] ?? dom.baseline}</span></dd>
        <dt>Avoided</dt><dd>{grams(dom.avoided_g)} · {pct(dom.avoided_pct)}</dd>
        <dt>Per request</dt><dd>{grams(dom.per_served_request_g)} <span className="muted">· {dom.vehicles_used} vehicles · {num(dom.vehicle_km, 1)} km</span></dd>
      </dl>}
      {dom && !dom.complete && <p className="small muted">No CO₂: {dom.missing?.slice(0, 2).join(', ')}{(dom.missing?.length ?? 0) > 2 ? ', …' : ''}</p>}
      {cmp && <div className="row gap chips"><span className={`badge ${VERDICT[cmp.quality].cls}`}>{VERDICT[cmp.quality].label}</span>
        {cmp.emissions && <span className={`badge ${VERDICT[cmp.emissions].cls}`} title="emissions">CO₂: {VERDICT[cmp.emissions].label.toLowerCase()}</span>}
        <button className="btn link small" onClick={() => setWhy(!why)} aria-expanded={why}>Why?</button></div>}
      {cmp && why && <div className="note small">
        <p>Compared with the experiment it derives from. Results: {VERDICT[cmp.quality].label.toLowerCase()}; runtimes: {VERDICT[cmp.runtime].label.toLowerCase()}{cmp.emissions ? `; emissions: ${VERDICT[cmp.emissions].label.toLowerCase()}` : ''}.</p>
        {cmp.reasons.length > 0 && <ul>{cmp.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        <button className="btn sm" onClick={onWhy}>Details</button></div>}
      {exp?.reproduction && <p className="small">{exp.reproduction.reproduced ? `Reproduced: ${exp.reproduction.cells} of ${exp.reproduction.cells} results identical.` : `${exp.reproduction.agreement.different} of ${exp.reproduction.cells} results differ.`}</p>}
    </section>
    {exp && <section className="row gap actions" data-tour="share">
      <button className="btn sm" onClick={onExport} disabled={!exp.campaign.locked && exp.campaign.status !== 'completed'}><Download size={12} /> Export</button>
      {exp.campaign.locked && <button className="btn sm" onClick={onReproduce}><RotateCcw size={12} /> Reproduce</button>}
      {exp.campaign.locked && <button className="btn sm" disabled={!added.length} onClick={onExtend} title={added.length ? '' : 'tick a method that is not in this experiment'}><GitBranch size={12} /> Extend</button>}
      {!exp.campaign.locked && !exp.campaign.imported && exp.campaign.status === 'completed' && <button className="btn sm" onClick={onLock}><Lock size={12} /> Lock results</button>}
      {onTrace && <button className="btn sm" onClick={onTrace}><ListTree size={12} /> Trace</button>}
    </section>}
    <details className="small">
      <summary>Advanced</summary>
      <label className="row">Repetitions <input type="number" min={1} max={20} value={opts.repetitions} aria-label="repetitions"
        onChange={(e) => setOpts({ ...opts, repetitions: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} style={{ width: '5em' }} /></label>
      {exp?.campaign.locked && variants.length > 0 && <div className="row gap">
        <select aria-label="controlled variant" value={opts.variant} onChange={(e) => setOpts({ ...opts, variant: e.target.value })} className="grow">
          {variants.map((v) => <option key={v.id} value={v.id}>{v.description}</option>)}</select>
        <button className="btn sm" onClick={onVariant}><GitBranch size={12} /> Create variant</button></div>}
    </details>
  </div>;
}
