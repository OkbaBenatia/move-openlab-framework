import { useState } from 'react';
import { CheckCircle2, GitBranch, Leaf, ListChecks, ListTree, Lock, Plus, RotateCcw, Scale, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import type { Json, MethodRef } from '../api/client';
import { JobProgress } from '../components/JobProgress';
import { num } from '../components/common';
import { t, tr } from '../i18n';
import { BASELINE_LABEL, PARAM_LABEL, SCOPE_LABEL, grams, pct, type Domain } from '../mobility/api';
import { CountInput } from '../components/CountInput';
import { VERDICT, rowKey, scopeMethods, type Experiment, type ResultRow } from './api';
import { hasCap, participantsOf, servedOf } from './scenarioMatch';
import { cellOf, fmtFact } from './compareData';
import { MetricChooser } from './MetricChooser';
import { missingWord, shownValue, type Ctx, type MetricDef } from './metrics';
import { useMetricChoice, useMlEvaluations } from './useMetrics';
import { scenarioLabel } from './scenarioNames';

export interface RunOptions { repetitions: number; variant: string }
export type Scope = 'scenario' | 'all';

export function methodKey(m: { method_id: string; version: string }) { return `${m.method_id}@${m.version}`; }

export type SettingValue = number | boolean | null;
export type Settings = Record<string, Record<string, SettingValue>>;
/** The value a setting has for a method: the researcher's edit, else the experiment's recorded setting, else the default. */
export const settingValue = (m: MethodRef, k: string, edits: Settings, exp: Experiment | null): SettingValue => {
  const e = edits[m.method_id];
  if (e && k in e) return e[k];
  const rec = exp?.campaign.method_configs?.[m.method_id];
  const v = rec && k in rec ? rec[k] : m.settings?.default_config[k];
  return typeof v === 'number' || typeof v === 'boolean' ? v : null;
};
/** Every setting of a method as it would run (recorded or default, with the researcher's edits), for previews. */
export const methodConfig = (m: MethodRef, edits: Settings, exp: Experiment | null): Record<string, SettingValue> =>
  Object.fromEntries(Object.keys(m.settings?.config_schema ?? {}).map((k) => [k, settingValue(m, k, edits, exp)]).filter(([, v]) => v !== null));
/** Only the settings that differ from what the experiment records (or from the defaults for a new experiment). */
export function changedSettings(methods: MethodRef[], edits: Settings, exp: Experiment | null): Settings {
  const out: Settings = {};
  for (const m of methods) for (const [k, v] of Object.entries(edits[m.method_id] ?? {})) {
    if (settingValue(m, k, {}, exp) !== v) out[m.method_id] = { ...(out[m.method_id] ?? {}), [k]: v };
  }
  return out;
}

/** Runtime with the unit it needs: milliseconds below one second. */
export const runtime = (s: number | null | undefined) => (s == null ? '—' : s < 1 ? `${num(s * 1000, 1)} ms` : `${num(s, 2)} s`);
export const metricValue = (v: number | null | undefined, unit?: string) => (v == null ? '—' : unit === 's' ? `${num(v / 60, 1)} min` : num(v));
const STATUS: Record<string, [string, string]> = {
  'proven optimal (full problem)': ['proven optimal', 'ok'], 'optimal for the reduced instance only': ['optimal (reduced)', 'warn'],
  'not proven (time limit)': ['time limit', 'warn'], 'feasible, optimality not proven': ['feasible', ''], 'heuristic (no optimality claim)': ['heuristic', ''],
  'invalid (rejected by the validator)': ['rejected', 'bad'],
};
const shortName = (r: ResultRow, rows: ResultRow[]) => {
  const aliased = !!r.recorded_name && r.recorded_name !== r.name;  // a problem-supplied display name is shown whole
  const base = aliased ? r.name! : (r.name ?? r.method_id).replace(/\s*\(.*\)\s*$/, '');
  return rows.filter((x) => x.method_id === r.method_id).length > 1 ? `${base} · ${tr(r.campaign_kind)}` : base;
};

/** The values of one row in the chosen scope: one scenario (repetition 1, consistent across repetitions; time = median of
 *  its repetitions) or all scenarios (sums; time = median over scenarios of each scenario's median). */
export function scoped(r: ResultRow, scope: Scope, hash: string) {
  if (scope === 'scenario') {
    const c = r.per_scenario[hash];
    return c ? { metrics: c.metrics, time: c.median_total_time_s, domain: c.domain, gap: c.gap_pct, ok: c.feasible, status: STATUS[c.optimality] ?? [c.optimality, ''], consistent: c.consistent, reps: c.repetitions, errors: c.errors ?? [] } : null;
  }
  const status: [string, string] = !r.valid ? ['rejected', 'bad'] : r.proven_optimal === r.scenarios ? ['proven optimal', 'ok'] : r.kind === 'exact' ? [tr('proven optimal {n}/{m}', { n: r.proven_optimal, m: r.scenarios }), 'warn']
    : r.kind === 'hybrid' && (r.reduced_optimal ?? 0) > 0 ? [tr('optimal on reduced model {n}/{m}', { n: r.reduced_optimal ?? 0, m: r.scenarios }), 'warn'] : r.kind === 'hybrid' ? ['not proven', 'warn'] : ['heuristic', ''];
  // over all scenarios: the validator's reasons of the rejected scenarios, with how many scenarios were rejected
  const rejected = Object.values(r.per_scenario).filter((c) => !c.feasible);
  return { metrics: r.totals, time: r.total_time_s, domain: r.domain, gap: r.gap_pct, ok: r.valid, status, consistent: r.repetitions_consistent, reps: r.repetitions,
    errors: rejected.length ? [`${rejected.length}/${r.scenarios}: ${rejected.flatMap((c) => c.errors ?? [])[0] ?? ''}`] : [] };
}

function Co2({ dom, basis }: { dom: Domain | null | undefined; basis: string }) {
  if (!dom) return null;
  if (!dom.complete) {
    // "D1: profile.parameter" → "D1 · profile · parameter (unit)"; nothing is assumed in its place
    const said = (m: string) => { const [who, what = ''] = m.split(': '); const i = what.lastIndexOf('.'); return `${who} · ${what.slice(0, i)} · ${tr(PARAM_LABEL[what.slice(i + 1)] ?? what.slice(i + 1))}`; };
    const miss = dom.missing ?? [];
    return <section className="sec co2" aria-label="CO2"><div className="row gap"><h3 className="grow"><Leaf size={16} /> CO₂</h3><span className="small muted">{tr(SCOPE_LABEL[dom.scope] ?? dom.scope)}</span></div>
      <p className="small">{tr('Not computed: a vehicle parameter has no value, and none is assumed.')}</p>
      <ul className="plain small muted">{miss.slice(0, 3).map((m) => <li key={m}>{said(m)}</li>)}{miss.length > 3 && <li>{tr('and {n} more', { n: miss.length - 3 })}</li>}</ul>
      <p className="tiny muted">{tr('Enter it under Advanced › Edit vehicles and their parameters (a new scenario version).')}</p></section>;
  }
  const w = dom.baseline_g ? Math.min(100, (100 * (dom.solution_g ?? 0)) / dom.baseline_g) : 0;
  return <section className="sec co2" aria-label="CO2">
    <div className="row gap"><h3 className="grow"><Leaf size={16} /> CO₂</h3><span className="small muted">{tr(SCOPE_LABEL[dom.scope] ?? dom.scope)}</span></div>
    <div className="row gap headline"><span className="big teal">−{grams(dom.avoided_g)}</span><span className="soft"><b>−{pct(dom.avoided_pct)}</b> {tr('vs {baseline}', { baseline: tr(BASELINE_LABEL[dom.baseline] ?? dom.baseline).toLowerCase() })}</span></div>
    <div className="bars">
      <div className="row gap small"><span className="lbl muted">{tr(BASELINE_LABEL[dom.baseline] ?? dom.baseline)}</span><span className="bar grow"><i style={{ width: '100%', background: 'var(--route-alone)' }} /></span><span className="num">{grams(dom.baseline_g)}</span></div>
      <div className="row gap small"><span className="lbl muted">{tr('With car-pooling')}</span><span className="bar grow"><i style={{ width: `${w}%`, background: 'var(--route-shared)' }} /></span><span className="num">{grams(dom.solution_g)}</span></div></div>
    <div className="row gap small muted wrap"><span>{tr('{value} per served rider', { value: grams(dom.per_served_request_g) })}</span><span>{tr('{n} vehicles', { n: dom.vehicles_used ?? '' })}</span><span>{num(dom.vehicle_km, 1)} km</span>{dom.basis === 'CO2e' && <span>CO₂e</span>}</div>
    <p className="tiny muted">{basis}</p>
  </section>;
}

/** Right panel: methods (with Add method), the running job, results in an explicit scope, CO₂, and the evidence kept
 *  apart — independent validation, reproducibility (only for a re-execution), semantic comparability with the parent. */
export function ResultPanel({ exp, methods, checked, setChecked, job, onJobDone, setErr, selected, setSelected, onLock, opts, setOpts, variants, onVariant,
  onWhy, onTrace, onAddMethod, hash, scope, setScope, onRecalcCo2, onEditVehicles, edits = {}, setEdits, onPreview,
  runScope = 'scenario', setRunScope, hiddenRows = [], setHiddenRows, setRecords }: {
  exp: Experiment | null; methods: MethodRef[]; checked: string[]; setChecked: (k: string[]) => void;
  job: Json | null; onJobDone: (j: Json) => void; setErr: (s: string | null) => void;
  selected: string; setSelected: (m: string) => void; onLock: () => void;
  opts: RunOptions; setOpts: (o: RunOptions) => void; variants: { id: string; description: string }[]; onVariant: () => void; onWhy: () => void;
  onTrace: (() => void) | null; onAddMethod: () => void; hash: string; scope: Scope; setScope: (s: Scope) => void;
  onRecalcCo2?: (scope: string, baseline: string) => void; onEditVehicles?: () => void;
  /** Solver settings the researcher is changing ({method_id: {setting: value}}); null keeps the solver's default. */
  edits?: Settings; setEdits?: (s: Settings) => void;
  /** Preview, on the map, the candidate reduction a method would apply with its current settings (no solve). */
  onPreview?: (m: MethodRef) => void;
  /** Where a new settings version runs: the shown scenario only, or all the experiment's scenarios. */
  runScope?: 'scenario' | 'all'; setRunScope?: (s: 'scenario' | 'all') => void;
  /** Display selection: result rows the researcher unticked (independent of what was or will be run). */
  hiddenRows?: string[]; setHiddenRows?: (keys: string[]) => void;
  /** Switch between a saved study view and the experiment's own records (History). */
  setRecords?: (records: boolean) => void;
}) {
  const [why, setWhy] = useState(false);
  const [openCfg, setOpenCfg] = useState<string | null>(null);
  const [co2Cfg, setCo2Cfg] = useState<{ scope: string; baseline: string } | null>(null);
  // the metrics shown as columns: the account's choice for this problem (the same one as in Compare and the charts)
  const mc = useMetricChoice(exp, { compact: true });
  const { mlOf } = useMlEvaluations(exp?.results?.rows ?? [], mc.visible.some((d) => d.group === 'ml'));
  const inExp = new Set(exp ? scopeMethods(exp) : []);
  const toggle = (k: string) => setChecked(checked.includes(k) ? checked.filter((x) => x !== k) : [...checked, k]);
  const rows = exp?.results?.rows ?? [];
  const visible = rows.filter((r) => !hiddenRows.includes(rowKey(r)));
  const cmp = exp?.comparability;
  const sel = visible.find((r) => rowKey(r) === selected) ?? visible[0] ?? rows[0];
  const k = exp ? Math.max(0, exp.scenarios.findIndex((s) => s.instance_hash === hash)) : 0;
  const n = exp?.scenarios.length ?? 0;
  const riders = servedOf(exp, scope === 'scenario' ? k : 'all');      // denominator of `served`
  const who = participantsOf(exp);
  const first = sel ? scoped(sel, scope, hash) : null;
  const reps = first?.reps ?? exp?.campaign.repetitions ?? 1;
  const consistent = rows.every((r) => scoped(r, scope, hash)?.consistent !== false);
  const repNote = consistent ? tr('results identical in all {reps} repetitions', { reps }) : tr('repetitions differ (repetition 1 shown)');
  const basis = scope === 'scenario'
    ? `${scenarioLabel(exp?.scenarios[k], k)} · ${tr('scenario {k} of {n}', { k: k + 1, n })}${riders != null ? ` · ${riders} ${tr(who)}` : ''} · ${repNote} · ${reps === 1 ? tr('time: median of {reps} run', { reps }) : tr('time: median of {reps} runs', { reps })}`
    : `${tr('All {n} scenarios', { n })} · ${riders != null ? tr('sums over {riders} {who}', { riders, who: tr(who) }) : tr('sums')} · ${repNote} · ${tr("time: median over scenarios of each scenario's median of {reps} runs", { reps })}`;
  // methods whose changed settings would run as a new experiment version (the scenario choice sits inside the sentence)
  const [runOnlyBefore, runOnlyAfter = ''] = tr('Run again runs only {methods} as a new experiment version, on {scope}; this experiment stays unchanged.',
    { methods: Object.keys(changedSettings(methods, edits, exp)).map((id) => methods.find((x) => x.method_id === id)?.name ?? id).join(', ') }).split(' {scope}');
  const refRow = rows.find((r) => r.method_id === (exp?.results?.reference as { method_id?: string } | null)?.method_id);
  const gapTip = tr('Objective difference vs the reference ({ref}): positive = worse, negative = better. It is not a proven optimality gap{p}.', { ref: refRow?.name ?? tr('the reference method'),
    p: refRow && refRow.proven_optimal < refRow.scenarios ? tr(': the reference is proven optimal on {a} of {b} scenarios, so a negative value only means a better incumbent', { a: refRow.proven_optimal, b: refRow.scenarios }) : '' });
  const dom = first?.domain;
  const kScope: number | 'all' = scope === 'scenario' ? k : 'all';
  const cellFor = (r: ResultRow) => cellOf(r, kScope, exp, exp);
  const ctx: Ctx = { ref: refRow ? cellFor(refRow) : null, refRow: refRow ?? null, ml: mlOf };
  const valueOf = (d: MetricDef, r: ResultRow) => { const c = cellFor(r); return c && !d.text ? d.get(c, r, kScope, ctx) ?? null : null; };
  const whyNot = (d: MetricDef, r: ResultRow) => d.why?.(r, kScope, ctx) ?? null;
  // a chosen metric keeps its column when a displayed method has a value, or a stated reason for having none (not
  // configured, not available…); a metric that simply does not exist in this scope gets no column of dashes
  const cols = mc.visible.filter((d) => visible.some((r) => { const c = cellFor(r); if (!c) return false;
    return d.text ? d.text(c, r) !== '—' : valueOf(d, r) != null || /not configured|not available|not applicable|needed|not computed/i.test(whyNot(d, r) ?? ''); }));
  const cellText = (d: MetricDef, r: ResultRow) => { const c = cellFor(r); if (!c) return <span className="muted">—</span>;
    if (d.text) return d.text(c, r);
    if (d.id === 'gap' && r.method_id === refRow?.method_id) return <span className="muted">{tr('ref.')}</span>;
    const v = valueOf(d, r);
    if (v == null) { const why = whyNot(d, r); return <span className="muted na" title={why ? tr(why) : tr('No value recorded')}>{tr(missingWord(why))}</span>; }
    if (d.id === 'served' && riders != null) return <><b>{num(v)}</b><span className="muted"> / {riders}</span></>;
    return shownValue(d, v); };
  // the formulation's own mobility figures (a problem may report some), shown where the platform computes no CO₂
  const native = (exp?.problem.metrics ?? []).filter((m) => m.category === 'mobility');
  const [runOpen, setRunOpen] = useState<boolean | null>(null);
  // open while there is something to choose before a run; closed on frozen results unless the researcher opens it
  const runIsOpen = runOpen ?? (!rows.length || !exp?.campaign.locked);
  const runItem = (m0: MethodRef) => { const key = methodKey(m0);
        // a method of this experiment is named with the experiment's own settings (e.g. its policy), as in its results
        const m = { ...m0, name: (inExp.has(key) && exp?.methods.find((x) => methodKey(x) === key)?.name) || m0.name };
        return <li key={key}><label className="row">
        <input type="checkbox" aria-label={m.name} checked={checked.includes(key)} disabled={inExp.has(key) && exp?.campaign.locked === true} onChange={() => toggle(key)} />
        <span className="grow"><span className="strong">{m.name}</span><span className="small muted block">{m.source === 'plugin' ? tr('your method · {author}', { author: m.author }) : m.author === 'MOVE OpenLab' ? tr('built-in') : m.author}</span></span>
        <span className={`badge ${m.kind === 'exact' ? 'info' : ''}`}>{tr(m.kind === 'exact' ? 'Exact' : m.kind === 'heuristic' ? 'Heuristic' : m.kind)}</span>
        {m.settings && setEdits && <button type="button" className="btn icon ghost sm" aria-label={tr('settings of {name}', { name: m.name })} aria-expanded={openCfg === key} title={tr('Solver settings')}
          onClick={(e) => { e.preventDefault(); setOpenCfg(openCfg === key ? null : key); }}><SlidersHorizontal size={13} /></button>}</label>
        {m.settings && setEdits && openCfg === key && <div className="settings-grid" aria-label={tr('settings of {name}', { name: m.name })}>{Object.entries(m.settings.config_schema).map(([k, s]) => {
          const v = settingValue(m, k, edits, exp);
          const set = (x: SettingValue) => setEdits({ ...edits, [m.method_id]: { ...(edits[m.method_id] ?? {}), [k]: x } });
          return <label key={k} className="small" title={s.help}>{tr(s.label)}{s.unit ? ` (${s.unit})` : ''}
            {s.type === 'boolean'
              ? <select value={v === null ? '' : String(v)} onChange={(e) => set(e.target.value === '' ? null : e.target.value === 'true')}>
                {s.nullable && <option value="">{tr('default')}</option>}<option value="true">{tr('on')}</option><option value="false">{tr('off')}</option></select>
              : <input type="number" value={typeof v === 'number' ? v : ''} placeholder={s.nullable ? tr('default') : ''} min={s.min} max={s.max} step={s.type === 'integer' ? 1 : 'any'}
                onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} />}</label>; })}
          {onPreview && inExp.has(key) && 'threshold' in m.settings.config_schema && <button type="button" className="btn sm settings-preview" onClick={() => onPreview(m)}
            title={tr('Run the model on the shown scenario and apply these settings: candidates retained and removed, on the map (nothing is solved)')}>{tr('Preview reduction')}</button>}</div>}</li>; };
  return <div className="panel-body">
    <section className="sec" data-tour="methods" aria-label={tr('methods')}>
      <div className="row gap"><h3 className="grow">{t('ws.methods')}</h3><button className="btn sm" onClick={onAddMethod} data-tour="add-method"><Plus size={13} /> {t('ws.addMethod')}</button></div>
      {rows.length > 0 && <>
        {exp?.view && exp.view.studies.length > 0 && setRecords && <div className="seg view-seg" role="group" aria-label={tr('which results are shown')}>
          <button className={exp.view.mode === 'study' ? 'on' : ''} aria-pressed={exp.view.mode === 'study'} onClick={() => setRecords(false)} title={exp.view.study?.description || exp.view.studies[0].title}>{tr('Study view')}</button>
          <button className={exp.view.mode === 'records' ? 'on' : ''} aria-pressed={exp.view.mode === 'records'} onClick={() => setRecords(true)} title={tr('Every record of this experiment and of the experiments it extends, including earlier policies and pilots')}>{tr('History')}</button></div>}
        {exp?.view && exp.view.studies.length > 0 && <div className="tiny muted">{exp.view.mode === 'study' ? (exp.view.study?.title ?? '') : tr('History: every record of this experiment and of the experiments it extends')}</div>}
        <div className="tiny muted shown-head">{tr('Displayed methods: tick to show, click a name to see its map and results')}</div>
        <ul className="methods shown-methods" aria-label={tr('displayed methods')}>{rows.map((r) => { const key = rowKey(r); const on = !hiddenRows.includes(key);
          return <li key={key} className={selected === key ? 'on' : ''}><div className="row">
            <input type="checkbox" aria-label={`${tr('show')} ${r.name}`} checked={on} onChange={() => { const next = on ? [...hiddenRows, key] : hiddenRows.filter((x) => x !== key); setHiddenRows?.(next); if (on && selected === key) { const other = rows.find((x) => !next.includes(rowKey(x))); if (other) setSelected(rowKey(other)); } }} />
            <button type="button" className="grow method-pick" aria-pressed={selected === key} onClick={() => { if (!on) setHiddenRows?.(hiddenRows.filter((x) => x !== key)); setSelected(key); }}
              title={`${r.experiment ?? ''} · ${tr(r.origin)}`}><span className="strong">{shortName(r, rows)}</span>
              <span className="small muted block">{[r.note, r.campaign_id !== exp?.campaign.campaign_id ? `${tr('from')} ${r.experiment ?? r.campaign_id}` : null, /imported results/.test(r.origin) ? tr('imported results, re-validated here') : null].filter(Boolean).join(' · ') || (r.kind === 'exact' ? tr('exact reference') : tr(r.origin))}</span></button>
            <span className={`badge ${r.kind === 'exact' ? 'info' : ''}`}>{tr(r.kind === 'exact' ? 'Exact' : r.kind === 'heuristic' ? 'Heuristic' : r.kind)}</span></div></li>; })}</ul></>}
      <details className="run-methods" open={runIsOpen}>
        <summary className="small strong" onClick={(e) => { e.preventDefault(); setRunOpen(!runIsOpen); }}>{tr('Methods to run')}<span className="muted"> · {tr('{n} ticked', { n: checked.length })}</span></summary>
        {exp?.campaign.locked && <p className="tiny muted">{tr('Frozen results are never changed: ticking another method and Run again creates an extension; changed settings create a new experiment version.')}</p>}
        <ul className="methods">{methods.filter((m) => !m.archived || inExp.has(methodKey(m))).map(runItem)}</ul>
        {methods.some((m) => m.archived && !inExp.has(methodKey(m))) && <details className="history-methods"><summary className="small muted">{tr('History · {n} earlier methods (pilots, superseded versions)', { n: methods.filter((m) => m.archived && !inExp.has(methodKey(m))).length })}</summary>
          <ul className="methods">{methods.filter((m) => m.archived && !inExp.has(methodKey(m))).map(runItem)}</ul></details>}

      {exp?.campaign.locked && checked.some((c) => !inExp.has(c)) && <p className="tiny muted">{tr('Run again with an added method creates an extension; this experiment stays unchanged.')}</p>}
      {Object.keys(changedSettings(methods, edits, exp)).length > 0 && (exp?.campaign.locked
        ? <div className="tiny muted settings-run">{runOnlyBefore}
          {setRunScope && <select aria-label={tr('scenarios to run')} value={runScope} onChange={(e) => setRunScope(e.target.value as 'scenario' | 'all')}>
            <option value="scenario">{tr('this scenario')}</option><option value="all">{tr('all {n} scenarios', { n: exp.scenarios.length })}</option></select>}{runOnlyAfter}</div>
        : <p className="tiny muted">{exp ? tr('Lock the results first; changed settings then run as a new experiment version.') : tr('The settings apply to the new experiment.')}</p>)}
      </details>
    </section>
    {job && <section className="sec"><JobProgress job={job} setErr={setErr} onFinished={onJobDone} unit="runs" /></section>}
    <section className="sec" data-tour="results" aria-label={tr('results')}>
      <div className="row gap"><h3 className="grow">{t('ws.results')}</h3>
        {rows.length > 0 && <button className="btn sm" onClick={mc.open} title={tr('Choose the metrics shown here, in Compare and in the charts')}><ListChecks size={13} /> {tr('Choose metrics')}</button>}
        {rows.length > 0 && n > 1 && <div className="seg" role="group" aria-label={tr('scope')}><button className={scope === 'scenario' ? 'on' : ''} aria-pressed={scope === 'scenario'} onClick={() => setScope('scenario')} title={tr('Values of the shown scenario only')}>{scenarioLabel(exp?.scenarios[k], k)}</button>
          <button className={scope === 'all' ? 'on' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')} title={tr('Values aggregated over every scenario of the experiment')}>{tr('All {n}', { n })}</button></div>}</div>
      {rows.length === 0 ? <p className="small muted">{exp ? t('ws.notRun') : tr('Choose scenarios and methods, then Run.')}</p> : <>
        <div className="results-scroll"><table className="compact results" aria-label={tr('results')}><thead><tr><th>{tr('Method')}</th>
          {cols.map((d) => <th key={d.id} className="n" data-metric={d.id} title={[d.id === 'gap' ? gapTip : d.help, `${tr('Aggregation')}: ${d.basis(kScope)}`].filter(Boolean).join('\n')}>{d.short ?? d.label}</th>)}<th /></tr></thead>
          <tbody>{visible.map((r) => { const v = scoped(r, scope, hash); if (!v) return null;
            return <tr key={rowKey(r)} className={selected === rowKey(r) ? 'hl' : ''} onClick={() => setSelected(rowKey(r))} title={tr("show this method's routes on the map")}>
              <td><span className="strong">{shortName(r, rows)}</span><span className={`tiny block ${v.status[1] === 'bad' ? 'bad-text' : 'muted'}`} title={v.errors.length ? v.errors.join('\n') : undefined}>{tr(v.status[0])}{v.status[1] === 'bad' && v.errors[0] ? ` — ${v.errors[0]}` : ''}</span></td>
              {cols.map((d) => <td key={d.id} className="n" data-metric={d.id}>{cellText(d, r)}</td>)}
              <td className="ok-cell">{v.ok ? <CheckCircle2 size={14} aria-label={tr('validated')} /> : null}</td></tr>; })}</tbody></table></div>
        <div className="basis"><span>{basis}</span></div>
        {scope === 'scenario' && (exp?.scenarios[k]?.notes ?? []).map((note) => <p key={note} className="small warn-text" role="note">{note}</p>)}
        {sel && (exp?.problem.facts ?? []).length > 0 && (() => {
          // what the selected method recorded, in the chosen scope (per scenario, or aggregated where defined)
          const fx = scope === 'scenario' ? sel.per_scenario[hash]?.facts ?? {} : sel.facts ?? {};
          const shown = (exp!.problem.facts ?? []).filter((f) => (scope === 'scenario' || f.aggregate !== 'none') && fx[f.id] != null);
          return shown.length > 0 && <details className="run-facts" open><summary className="small strong">{tr('{name} · recorded details', { name: shortName(sel, rows) })}</summary>
            <dl className="facts-list">{shown.map((f) => <div key={f.id}><dt>{tr(f.label)}</dt><dd>{fmtFact(fx[f.id], f)}</dd></div>)}</dl></details>;
        })()}</>}
    </section>
    {!dom && exp && rows.length > 0 && hasCap(exp, 'map') && <section className="sec co2 co2-na" aria-label="CO2">
      <div className="row gap"><h3 className="grow"><Leaf size={16} /> CO₂</h3><span className="badge">{tr('Not configured')}</span></div>
      <p className="small">{tr('The platform’s CO₂ calculation is not configured for this problem: its scenarios carry no vehicle energy profiles. No value is shown and none is assumed; nothing is copied from another experiment.')}</p>
      {sel && first && native.filter((m) => first.metrics[m.id] != null).map((m) => <p key={m.id} className="small" data-native={m.id}><b>{tr(m.label)}</b>: {num(first.metrics[m.id])} {m.unit}
        <span className="tiny muted block">{tr('Reported by the formulation itself, not computed by the platform.')}{m.note ? ` ${tr(m.note)}` : ''}</span></p>)}
    </section>}
    <Co2 dom={dom} basis={`${scope === 'scenario' ? `${scenarioLabel(exp?.scenarios[k], k)} (${k + 1} / ${n})` : tr('All {n} scenarios (percentages and per-rider values are ratios of the sums)', { n })} · ${sel ? shortName(sel, rows) : ''}`} />
    {exp && exp.validation.runs > 0 && <section className="sec evidence" aria-label={tr('evidence')}>
      <div className="ev-item"><ShieldCheck size={17} className={exp.validation.accepted === exp.validation.runs ? 'ok-text' : 'bad-text'} />
        <div className="grow"><div className="evh">{t('ev.validation')}</div><b>{tr('{n} of {m} runs accepted', { n: exp.validation.accepted, m: exp.validation.runs })}</b>
          <div className="tiny muted">{tr('every solution checked by validator {version}, not by the method', { version: exp.validation.validator_version ?? '' })}</div></div></div>
      {exp.reproduction && <div className="ev-item"><RotateCcw size={17} className={exp.reproduction.reproduced ? 'ok-text' : 'bad-text'} />
        <div className="grow"><div className="evh">{t('ev.reproducibility')}</div><b>{exp.reproduction.reproduced ? `${t('ev.reproduced')}: ${tr('{n} of {m} results equal', { n: exp.reproduction.cells, m: exp.reproduction.cells })}` : tr('{n} of {m} results differ', { n: exp.reproduction.agreement.different, m: exp.reproduction.cells })}</b>
          <div className="tiny muted">{tr('independent re-execution · every validated metric must be equal; runtimes are reported, not required to match')}</div></div></div>}
      {cmp && <div className="ev-item"><Scale size={17} className={cmp.quality === 'direct' ? 'ok-text' : cmp.quality === 'conditional' ? 'warn-text' : 'bad-text'} />
        <div className="grow"><div className="evh">{t('ev.comparability')} · {tr('with its parent')}</div>
          <div className="row gap wrap chips"><span className={`badge ${VERDICT[cmp.quality].cls}`}>{tr('Results')}</span><span className={`badge ${VERDICT[cmp.runtime].cls}`}>{tr('Runtime')}</span>
            {cmp.emissions && <span className={`badge ${VERDICT[cmp.emissions].cls}`}>CO₂</span>}<button className="btn link small" onClick={() => setWhy(!why)} aria-expanded={why}>{t('ev.why')}</button></div>
          {why && <div className="note small"><p>{cmp.emissions ? tr('Results: {quality} · runtime: {runtime} · CO₂: {emissions}.', { quality: tr(VERDICT[cmp.quality].label).toLowerCase(), runtime: tr(VERDICT[cmp.runtime].label).toLowerCase(), emissions: tr(VERDICT[cmp.emissions].label).toLowerCase() })
              : tr('Results: {quality} · runtime: {runtime}.', { quality: tr(VERDICT[cmp.quality].label).toLowerCase(), runtime: tr(VERDICT[cmp.runtime].label).toLowerCase() })}</p>
            {cmp.reasons.length > 0 && <ul>{cmp.reasons.map((x) => <li key={x}>{tr(x)}</li>)}</ul>}<button className="btn sm" onClick={onWhy}>{tr('Details')}</button></div>}</div></div>}
    </section>}
    {exp && <section className="sec row gap actions">
      {!exp.campaign.locked && !exp.campaign.imported && exp.campaign.status === 'completed' && <button className="btn sm" onClick={onLock}><Lock size={12} /> {tr('Lock results')}</button>}
      {onTrace && <button className="btn sm" onClick={onTrace}><ListTree size={12} /> {tr('Execution trace')}</button>}
    </section>}
    <details className="sec small">
      <summary>{tr('Advanced')}</summary>
      <label className="row">{tr('Repetitions')} <CountInput min={1} max={20} value={opts.repetitions} aria-label={tr('repetitions')}
        onChange={(n) => setOpts({ ...opts, repetitions: n })} style={{ width: '5em' }} /></label>
      {exp?.campaign.locked && variants.length > 0 && <div className="row gap">
        <select aria-label={tr('controlled variant')} value={opts.variant} onChange={(e) => setOpts({ ...opts, variant: e.target.value })} className="grow">
          {variants.map((v) => <option key={v.id} value={v.id}>{tr(v.description)}</option>)}</select>
        <button className="btn sm" onClick={onVariant}><GitBranch size={12} /> {tr('Create controlled variant')}</button></div>}
      {exp && (onRecalcCo2 || onEditVehicles) && exp.results && <div className="adv-co2">
        <div className="small strong">{tr('CO₂ calculation and vehicles')}</div>
        {onRecalcCo2 && (() => { const cur = co2Cfg ?? { scope: exp.campaign.emissions?.scope ?? 'operational-energy', baseline: exp.campaign.emissions?.baseline ?? 'everyone-drives-alone' };
          const same = exp.campaign.emissions && cur.scope === exp.campaign.emissions.scope && cur.baseline === exp.campaign.emissions.baseline;
          return <div className="row gap wrap">
            <select aria-label={tr('CO₂ calculation of the new experiment')} value={cur.scope} onChange={(e) => setCo2Cfg({ ...cur, scope: e.target.value })}>{Object.entries(SCOPE_LABEL).map(([k, v]) => <option key={k} value={k}>{tr(v)}</option>)}</select>
            <select aria-label={tr('CO₂ baseline of the new experiment')} value={cur.baseline} onChange={(e) => setCo2Cfg({ ...cur, baseline: e.target.value })}>{Object.entries(BASELINE_LABEL).map(([k, v]) => <option key={k} value={k}>{tr(v)}</option>)}</select>
            <button className="btn sm" disabled={!!same} title={same ? tr('Choose another calculation or baseline') : tr('Runs the same methods on the same frozen scenarios with this CO₂ calculation')} onClick={() => onRecalcCo2(cur.scope, cur.baseline)}>{tr('New experiment with this calculation')}</button></div>; })()}
        {onEditVehicles && <button className="btn sm" onClick={onEditVehicles}>{tr('Edit vehicles and their parameters…')}</button>}
        <p className="tiny muted">{tr('Each creates a new, traceable configuration (new fingerprints); the original results stay unchanged.')}</p></div>}
    </details>
    {mc.choosing && <MetricChooser defs={mc.defs} chosen={mc.chosen} onApply={mc.apply} onClose={mc.close} compact remembered={mc.remembered} unavailable={(d) => mc.unavailable(d, rows, ctx)} />}
  </div>;
}
