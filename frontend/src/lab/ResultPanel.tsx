import { useState } from 'react';
import { CheckCircle2, GitBranch, Leaf, ListTree, Lock, Plus, RotateCcw, Scale, ShieldCheck } from 'lucide-react';
import type { Json, MethodRef } from '../api/client';
import { JobProgress } from '../components/JobProgress';
import { num } from '../components/common';
import { t } from '../i18n';
import { BASELINE_LABEL, SCOPE_LABEL, grams, pct, type Domain } from '../mobility/api';
import { VERDICT, rowKey, scopeMethods, type Experiment, type ResultRow } from './api';

export interface RunOptions { repetitions: number; variant: string }
export type Scope = 'scenario' | 'all';

export function methodKey(m: { method_id: string; version: string }) { return `${m.method_id}@${m.version}`; }

/** Runtime with the unit it needs: milliseconds below one second. */
export const runtime = (s: number | null | undefined) => (s == null ? '—' : s < 1 ? `${num(s * 1000, 1)} ms` : `${num(s, 2)} s`);
export const metricValue = (v: number | null | undefined, unit?: string) => (v == null ? '—' : unit === 's' ? `${num(v / 60, 1)} min` : num(v));
const STATUS: Record<string, [string, string]> = {
  'proven optimal (full problem)': ['proven optimal', 'ok'], 'optimal for the reduced instance only': ['optimal (reduced)', 'warn'],
  'not proven (time limit)': ['time limit', 'warn'], 'feasible, optimality not proven': ['feasible', ''], 'heuristic (no optimality claim)': ['heuristic', ''],
  'invalid (rejected by the validator)': ['rejected', 'bad'],
};
const shortName = (r: ResultRow, rows: ResultRow[]) => {
  const base = (r.name ?? r.method_id).replace(/\s*\(.*\)\s*$/, '');
  return rows.filter((x) => x.method_id === r.method_id).length > 1 ? `${base} · ${r.campaign_kind}` : base;
};

/** The values of one row in the chosen scope: one scenario (repetition 1, consistent across repetitions; time = median of
 *  its repetitions) or all scenarios (sums; time = median over scenarios of each scenario's median). */
export function scoped(r: ResultRow, scope: Scope, hash: string) {
  if (scope === 'scenario') {
    const c = r.per_scenario[hash];
    return c ? { metrics: c.metrics, time: c.median_total_time_s, domain: c.domain, gap: c.gap_pct, ok: c.feasible, status: STATUS[c.optimality] ?? [c.optimality, ''], consistent: c.consistent, reps: c.repetitions } : null;
  }
  const status: [string, string] = !r.valid ? ['rejected', 'bad'] : r.proven_optimal === r.scenarios ? ['proven optimal', 'ok'] : r.kind === 'exact' ? [`optimal ${r.proven_optimal}/${r.scenarios}`, 'warn'] : ['heuristic', ''];
  return { metrics: r.totals, time: r.total_time_s, domain: r.domain, gap: r.gap_pct, ok: r.valid, status, consistent: r.repetitions_consistent, reps: r.repetitions };
}

function Co2({ dom, basis }: { dom: Domain | null | undefined; basis: string }) {
  if (!dom) return null;
  if (!dom.complete) return <p className="small muted">No CO₂ figure: {dom.missing?.slice(0, 2).join(', ')}{(dom.missing?.length ?? 0) > 2 ? ', …' : ''}</p>;
  const w = dom.baseline_g ? Math.min(100, (100 * (dom.solution_g ?? 0)) / dom.baseline_g) : 0;
  return <section className="sec co2" aria-label="CO2">
    <div className="row gap"><h3 className="grow"><Leaf size={16} /> CO₂</h3><span className="small muted">{SCOPE_LABEL[dom.scope] ?? dom.scope}</span></div>
    <div className="row gap headline"><span className="big teal">−{grams(dom.avoided_g)}</span><span className="soft"><b>−{pct(dom.avoided_pct)}</b> vs {(BASELINE_LABEL[dom.baseline] ?? dom.baseline).toLowerCase()}</span></div>
    <div className="bars">
      <div className="row gap small"><span className="lbl muted">{BASELINE_LABEL[dom.baseline] ?? dom.baseline}</span><span className="bar grow"><i style={{ width: '100%', background: 'var(--route-alone)' }} /></span><span className="num">{grams(dom.baseline_g)}</span></div>
      <div className="row gap small"><span className="lbl muted">With car-pooling</span><span className="bar grow"><i style={{ width: `${w}%`, background: 'var(--route-shared)' }} /></span><span className="num">{grams(dom.solution_g)}</span></div></div>
    <div className="row gap small muted wrap"><span>{grams(dom.per_served_request_g)} per served rider</span><span>{dom.vehicles_used} vehicles</span><span>{num(dom.vehicle_km, 1)} km</span>{dom.basis === 'CO2e' && <span>CO₂e</span>}</div>
    <p className="tiny muted">{basis}</p>
  </section>;
}

/** Right panel: methods (with Add method), the running job, results in an explicit scope, CO₂, and the evidence kept
 *  apart — independent validation, reproducibility (only for a re-execution), semantic comparability with the parent. */
export function ResultPanel({ exp, methods, checked, setChecked, job, onJobDone, setErr, selected, setSelected, onLock, opts, setOpts, variants, onVariant,
  onWhy, onTrace, onAddMethod, hash, scope, setScope }: {
  exp: Experiment | null; methods: MethodRef[]; checked: string[]; setChecked: (k: string[]) => void;
  job: Json | null; onJobDone: (j: Json) => void; setErr: (s: string | null) => void;
  selected: string; setSelected: (m: string) => void; onLock: () => void;
  opts: RunOptions; setOpts: (o: RunOptions) => void; variants: { id: string; description: string }[]; onVariant: () => void; onWhy: () => void;
  onTrace: (() => void) | null; onAddMethod: () => void; hash: string; scope: Scope; setScope: (s: Scope) => void;
}) {
  const [why, setWhy] = useState(false);
  const inExp = new Set(exp ? scopeMethods(exp) : []);
  const toggle = (k: string) => setChecked(checked.includes(k) ? checked.filter((x) => x !== k) : [...checked, k]);
  const rows = exp?.results?.rows ?? [];
  const cmp = exp?.comparability;
  const sel = rows.find((r) => rowKey(r) === selected) ?? rows[0];
  const k = exp ? Math.max(0, exp.scenarios.findIndex((s) => s.instance_hash === hash)) : 0;
  const sc = exp?.scenarios[k];
  const n = exp?.scenarios.length ?? 0;
  const riders = scope === 'scenario' ? sc?.riders ?? null : exp ? exp.scenarios.reduce((a, s) => a + (s.riders ?? 0), 0) : null;
  const objective = exp?.problem.objective ?? [];
  const metric = (id: string) => exp?.problem.metrics.find((m) => m.id === id);
  const first = sel ? scoped(sel, scope, hash) : null;
  const reps = first?.reps ?? exp?.campaign.repetitions ?? 1;
  const consistent = rows.every((r) => scoped(r, scope, hash)?.consistent !== false);
  const basis = scope === 'scenario'
    ? `Sample ${k + 1} of ${n}${riders != null ? ` · ${riders} riders` : ''} · ${consistent ? `results identical in all ${reps} repetitions` : 'repetitions differ (repetition 1 shown)'} · time: median of ${reps} run${reps === 1 ? '' : 's'}`
    : `All ${n} scenarios · sums${riders != null ? ` over ${riders} riders` : ''} · ${consistent ? `results identical in all ${reps} repetitions` : 'repetitions differ (repetition 1 shown)'} · time: median over scenarios of each scenario's median of ${reps} runs`;
  const hasGap = !!exp?.results?.reference && rows.some((r) => r.kind !== 'exact');
  const dom = first?.domain;
  return <div className="panel-body">
    <section className="sec" data-tour="methods" aria-label="methods">
      <div className="row gap"><h3 className="grow">{t('ws.methods')}</h3><button className="btn sm" onClick={onAddMethod} data-tour="add-method"><Plus size={13} /> {t('ws.addMethod')}</button></div>
      <ul className="methods">{methods.map((m) => { const key = methodKey(m); return <li key={key}><label className="row">
        <input type="checkbox" aria-label={m.name} checked={checked.includes(key)} disabled={inExp.has(key) && exp?.campaign.locked === true} onChange={() => toggle(key)} />
        <span className="grow"><span className="strong">{m.name}</span><span className="small muted block">{m.source === 'plugin' ? `your method · ${m.author}` : m.author === 'MOVE OpenLab' ? 'built-in' : m.author}</span></span>
        <span className={`badge ${m.kind === 'exact' ? 'info' : ''}`}>{m.kind === 'exact' ? 'Exact' : m.kind === 'heuristic' ? 'Heuristic' : m.kind}</span></label></li>; })}</ul>
      {exp?.campaign.locked && checked.some((c) => !inExp.has(c)) && <p className="tiny muted">Run again with an added method creates an extension; this experiment stays unchanged.</p>}
    </section>
    {job && <section className="sec"><JobProgress job={job} setErr={setErr} onFinished={onJobDone} unit="runs" /></section>}
    <section className="sec" data-tour="results" aria-label="results">
      <div className="row gap"><h3 className="grow">{t('ws.results')}</h3>
        {rows.length > 0 && n > 1 && <div className="seg" role="group" aria-label="scope"><button className={scope === 'scenario' ? 'on' : ''} aria-pressed={scope === 'scenario'} onClick={() => setScope('scenario')}>Sample {k + 1}</button>
          <button className={scope === 'all' ? 'on' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>{t('ws.allScenarios')}</button></div>}</div>
      {rows.length === 0 ? <p className="small muted">{exp ? t('ws.notRun') : 'Choose scenarios and methods, then Run.'}</p> : <>
        <table className="compact results" aria-label="results"><thead><tr><th>Method</th>
          {objective.map((o) => <th key={o.metric} className="n" title={metric(o.metric)?.definition}>{o.metric === 'served' ? 'Served' : metric(o.metric)?.label ?? o.metric}</th>)}
          {hasGap && <th className="n" title="relative gap to the exact reference on the last objective level">Gap</th>}<th className="n">Time</th><th /></tr></thead>
          <tbody>{rows.map((r) => { const v = scoped(r, scope, hash); if (!v) return null;
            return <tr key={rowKey(r)} className={selected === rowKey(r) ? 'hl' : ''} onClick={() => setSelected(rowKey(r))} title="show this method's routes on the map">
              <td><span className="strong">{shortName(r, rows)}</span><span className={`tiny block ${v.status[1] === 'bad' ? 'bad-text' : 'muted'}`}>{v.status[0]}</span></td>
              {objective.map((o) => <td key={o.metric} className="n">{o.metric === 'served' && riders != null ? <><b>{num(v.metrics[o.metric])}</b><span className="muted"> / {riders}</span></> : metricValue(v.metrics[o.metric], metric(o.metric)?.unit)}</td>)}
              {hasGap && <td className="n">{r.kind === 'exact' ? '—' : v.gap == null ? <span className="muted" title="an earlier objective level differs">n/a</span> : `${num(v.gap, 1)} %`}</td>}
              <td className="n">{runtime(v.time)}</td>
              <td className="ok-cell">{v.ok ? <CheckCircle2 size={14} aria-label="validated" /> : null}</td></tr>; })}</tbody></table>
        <div className="basis"><span>{basis}</span></div></>}
    </section>
    <Co2 dom={dom} basis={`${scope === 'scenario' ? `Sample ${k + 1} of ${n}` : `All ${n} scenarios (percentages and per-rider values are ratios of the sums)`} · ${sel ? shortName(sel, rows) : ''}`} />
    {exp && exp.validation.runs > 0 && <section className="sec evidence" aria-label="evidence">
      <div className="ev-item"><ShieldCheck size={17} className={exp.validation.accepted === exp.validation.runs ? 'ok-text' : 'bad-text'} />
        <div className="grow"><div className="evh">{t('ev.validation')}</div><b>{exp.validation.accepted} of {exp.validation.runs} runs accepted</b>
          <div className="tiny muted">every solution checked by validator {exp.validation.validator_version}, not by the method</div></div></div>
      {exp.reproduction && <div className="ev-item"><RotateCcw size={17} className={exp.reproduction.reproduced ? 'ok-text' : 'bad-text'} />
        <div className="grow"><div className="evh">{t('ev.reproducibility')}</div><b>{exp.reproduction.reproduced ? `${t('ev.reproduced')}: ${exp.reproduction.cells} of ${exp.reproduction.cells} results equal` : `${exp.reproduction.agreement.different} of ${exp.reproduction.cells} results differ`}</b>
          <div className="tiny muted">independent re-execution · every validated metric must be equal; runtimes are reported, not required to match</div></div></div>}
      {cmp && <div className="ev-item"><Scale size={17} className={cmp.quality === 'direct' ? 'ok-text' : cmp.quality === 'conditional' ? 'warn-text' : 'bad-text'} />
        <div className="grow"><div className="evh">{t('ev.comparability')} · with its parent</div>
          <div className="row gap wrap chips"><span className={`badge ${VERDICT[cmp.quality].cls}`}>Results</span><span className={`badge ${VERDICT[cmp.runtime].cls}`}>Runtime</span>
            {cmp.emissions && <span className={`badge ${VERDICT[cmp.emissions].cls}`}>CO₂</span>}<button className="btn link small" onClick={() => setWhy(!why)} aria-expanded={why}>{t('ev.why')}</button></div>
          {why && <div className="note small"><p>Results: {VERDICT[cmp.quality].label.toLowerCase()} · runtime: {VERDICT[cmp.runtime].label.toLowerCase()}{cmp.emissions ? ` · CO₂: ${VERDICT[cmp.emissions].label.toLowerCase()}` : ''}.</p>
            {cmp.reasons.length > 0 && <ul>{cmp.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}<button className="btn sm" onClick={onWhy}>Details</button></div>}</div></div>}
    </section>}
    {exp && <section className="sec row gap actions">
      {!exp.campaign.locked && !exp.campaign.imported && exp.campaign.status === 'completed' && <button className="btn sm" onClick={onLock}><Lock size={12} /> Lock results</button>}
      {onTrace && <button className="btn sm" onClick={onTrace}><ListTree size={12} /> Execution trace</button>}
    </section>}
    <details className="sec small">
      <summary>Advanced</summary>
      <label className="row">Repetitions <input type="number" min={1} max={20} value={opts.repetitions} aria-label="repetitions"
        onChange={(e) => setOpts({ ...opts, repetitions: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} style={{ width: '5em' }} /></label>
      {exp?.campaign.locked && variants.length > 0 && <div className="row gap">
        <select aria-label="controlled variant" value={opts.variant} onChange={(e) => setOpts({ ...opts, variant: e.target.value })} className="grow">
          {variants.map((v) => <option key={v.id} value={v.id}>{v.description}</option>)}</select>
        <button className="btn sm" onClick={onVariant}><GitBranch size={12} /> Create controlled variant</button></div>}
    </details>
  </div>;
}
