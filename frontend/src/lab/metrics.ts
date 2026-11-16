import { num } from '../components/common';
import { tr as translate } from '../i18n';
import type { Experiment, FactDef, ResultRow } from './api';
import { FACT_BASIS, fmtFact, servedLabel, type Cell, type Translate } from './compareData';
import { runtime } from './ResultPanel';

/** One metric model for tables, charts and the "Choose metrics" dialog. Every metric says which group it belongs to,
 *  how it is aggregated (its basis, shown as a tooltip) and, when the problem cannot provide it, why — a metric without
 *  data is "not available" or "not configured", never zero. */
export type MetricGroup = 'validation' | 'optimization' | 'ml' | 'performance' | 'mobility' | 'custom';
export const GROUPS: [MetricGroup, string][] = [['validation', 'Validation'], ['optimization', 'Optimization'], ['ml', 'ML evaluation'], ['performance', 'Performance'],
  ['mobility', 'Mobility and CO₂'], ['custom', 'Custom metrics']];
export type Scope = number | 'all';
export interface Ctx { ref: Cell | null; refRow: ResultRow | null; ml: (r: ResultRow) => MlEvaluation | null }
export interface MetricDef {
  id: string; group: MetricGroup; label: string; unit: string; help?: string; byDefault: boolean;
  /** Part of the default selection of a narrow results table (the Workspace panel), and its short column heading. */
  compact?: boolean; short?: string;
  basis: (k: Scope) => string;
  get: (c: Cell, r: ResultRow, k: Scope, x: Ctx) => number | null | undefined;
  fmt: (v: number) => string;
  /** A textual value (e.g. a solver status) instead of a number. */
  text?: (c: Cell, r: ResultRow) => string;
  /** Why a row has no value (shown in place of the number, with this explanation). Always the English text, which the
   *  views test ("not configured", "not available"…): it is translated where it is displayed. */
  why?: (r: ResultRow, k: Scope, x: Ctx) => string | null;
  /** Whether the metric can be charted (numbers per scenario or over all scenarios). */
  chart?: boolean;
  /** How to read the metric (a boundary, a caveat): shown under a table that displays it. */
  caveat?: string;
}
export interface MlPopulation { population: string; split: string; graphs: number; candidates: number; positives: number; prevalence_pct: number; decision: string; positive_label: string; convention: string;
  confusion: { tp: number; fn: number; fp: number; tn: number }; metrics: Record<string, number>; metric_basis?: Record<string, string>; source: { name: string; sha256: string }; notes: string[];
  /** Where the evaluation comes from: the problem package, or evidence a researcher imported for this experiment. The
   *  fields below exist for imported evidence (a metric of `metrics` may then be null: undefined, with its reason). */
  origin?: 'adapter' | 'imported' | 'bundle-reference'; recomputable?: boolean; reference_only?: boolean; unit?: string; records?: number; metric_reasons?: Record<string, string>;
  extra_metrics?: { id: string; label: string; description: string; source: string; value: number | null; reason: string | null }[];
  provenance?: { method_id: string; dataset: { id: string; split: string; population: string; unit: string }; model: { name: string; version: string; sha256?: string; training_data?: string };
    feature_pipeline: { name: string; version: string; description: string }; decision: { rule: string; threshold?: number; policy?: string } };
  evidence_sha256?: string; evidence_format?: string; imported_by?: string; imported_at?: string; has_scores?: boolean;
  /** A decision `score ≥ / ≤ threshold`: it can be recomputed at another threshold (then `exploratory`), with the sweep behind the curve. */
  threshold_adjustable?: boolean; threshold?: number | null; exploratory?: boolean; score_range?: [number, number] | null;
  sweep?: { threshold: number; precision: number | null; recall: number | null; f1: number | null; kept_share: number }[];
  recorded_decision?: { rule: string; threshold: number | null; policy: string | null; decision: string; confusion: { tp: number; fn: number; fp: number; tn: number }; metrics: Record<string, number | null> } }
export interface MlEvaluation { method_id: string; name: string; available: boolean; reason: string | null; evaluations: MlPopulation[];
  kind?: string; can_import?: boolean; withdrawn?: number; adapter_error?: string | null; evidence_errors?: { evidence_sha256: string; reason: string }[] }
export interface CustomMetric { id: string; version: string; name: string; unit: string; direction: string; aggregate: string; description: string; provenance: string }

const CATEGORY: Record<string, MetricGroup> = { optimization: 'optimization', ml: 'ml', performance: 'performance', mobility: 'mobility' };
const ML_METRICS: [string, string, string][] = [['accuracy', 'Accuracy', 'share of all candidates classified like the reference label'],
  ['precision', 'Precision', 'share of the kept candidates that the reference solution uses'], ['recall', 'Recall', 'share of the reference-positive candidates that are kept'],
  ['f1', 'F1', 'harmonic mean of precision and recall'], ['pr_auc', 'PR-AUC', 'area under the precision–recall curve of the raw score (average precision)'],
  ['roc_auc', 'ROC-AUC', 'area under the ROC curve of the raw score']];

/** The metrics an experiment's problem supports, in the four groups (plus registered custom metrics). Labels, definitions
 *  and bases are in the interface language; an exported file passes `plain` as `tr` to keep them in English. */
export function metricDefs(exp: Experiment | null, customs: CustomMetric[], opts: { nScen: number; reps: number; riders: (k: Scope) => number | null; population: number; names: (k: number) => string },
  tr: Translate = translate): MetricDef[] {
  if (!exp) return [];
  const { nScen, reps, riders, names } = opts;
  const one = (k: Scope) => (k === 'all' ? '' : names(k));
  const sum = (k: Scope) => (k === 'all' ? tr('sum over {n} scenarios', { n: nScen }) : tr('this scenario ({s})', { s: one(k) }));
  const ratio = (k: Scope) => (k === 'all' ? tr('ratio of sums over {n} scenarios', { n: nScen }) : tr('this scenario ({s})', { s: one(k) }));
  const mdef = (id: string) => exp.problem.metrics.find((m) => m.id === id);
  const opt = (s: string | null | undefined) => (s ? tr(s) : undefined);          // a label or definition of the problem, when it has one
  const objective = exp.problem.objective;
  const refRow = exp.results?.rows.find((r) => r.method_id === (exp.results?.reference as { method_id?: string } | null)?.method_id) ?? null;
  const refName = refRow?.name ?? tr('the reference method');
  const refProven = refRow ? `${refRow.proven_optimal}/${refRow.scenarios}` : '';
  const emis = exp.campaign.emissions;
  const hasDomain = (exp.results?.rows ?? []).some((r) => r.domain != null || Object.values(r.per_scenario).some((c) => c.domain != null));
  const co2Why = () => (hasDomain ? 'Not computed: a vehicle parameter has no value, and none is assumed' : 'Not configured: the scenarios of this problem carry no vehicle energy profiles for the platform’s CO₂ calculation');
  const co2 = (c: Cell, f: (d: NonNullable<Cell['dom']>) => number | null | undefined) => (c.dom?.complete ? f(c.dom) ?? null : null);
  const facts = exp.problem.facts ?? [];
  const factDef = (f: FactDef): MetricDef => ({
    id: `fact:${f.id}`, group: CATEGORY[f.category ?? ''] ?? (/time|overhead|runtime/i.test(`${f.group} ${f.id}`) ? 'performance' : 'optimization'), label: tr(f.label), unit: f.unit, help: opt(f.help),
    byDefault: f.default ?? (f.aggregate !== 'none' && f.kind === 'number'), chart: f.kind === 'number',
    basis: (k) => (k === 'all' ? `${tr(FACT_BASIS[f.aggregate])}${f.aggregate === 'none' ? '' : ` · ${nScen} ${tr('scenarios')}`}` : tr('this scenario ({s})', { s: one(k) })),
    get: (c) => { const v = c.facts[f.id]; return typeof v === 'number' ? v : null; }, fmt: (v) => fmtFact(v, f),
    text: f.kind === 'text' ? (c) => fmtFact(c.facts[f.id], f) : undefined,
    why: (_r, k) => (k === 'all' && f.aggregate === 'none' ? 'Recorded per scenario; it is not aggregated over scenarios. Choose one scenario.' : null) });
  const speedFact = facts.find((f) => f.speedup);
  const mlWhy = (r: ResultRow, k: Scope, x: Ctx) => { const ev = x.ml(r);
    if (!ev) return 'Loading the evaluation…';
    if (!ev.available) return ev.reason ?? 'Not available: labelled predictions are needed';
    return k === 'all' ? null : 'Evaluated on a population of scenarios, not on one scenario. Choose "All scenarios".'; };
  const pop = (x: Ctx, r: ResultRow) => { const ev = x.ml(r); return ev?.available ? ev.evaluations[Math.min(opts.population, ev.evaluations.length - 1)] ?? null : null; };
  const anyLearned = (exp.results?.rows ?? []).some((r) => r.kind !== 'exact' && r.kind !== 'heuristic');
  const count = (k: Scope) => (k === 'all' ? tr('count over {n} scenarios', { n: nScen }) : tr('this scenario ({s})', { s: one(k) }));
  const defs: MetricDef[] = [
    // ---------------------------------------------------------------- validation (independent validator, repetitions)
    { id: 'validated', group: 'validation', label: tr('Validated runs'), short: tr('Validated'), unit: '', byDefault: true, chart: false, basis: count,
      help: tr('Runs accepted by the independent validator, out of the runs executed. The validator checks every solution; the method does not.'),
      get: (c) => c.accepted, fmt: (v) => num(v), text: (c) => `${num(c.accepted)} / ${num(c.executed)}` },
    { id: 'consistent', group: 'validation', label: tr('Repetitions identical'), unit: '', byDefault: false, chart: false, basis: count,
      help: tr('Whether every repetition of a run gave the same validated result (runtimes are not required to match).'),
      get: () => null, fmt: (v) => num(v), text: (c) => (c.executed > 0 ? tr(c.consistent ? 'yes' : 'no') : '—') },
    // ---------------------------------------------------------------- optimization
    { id: 'served', group: 'optimization', label: tr(servedLabel(exp)), short: tr('Served'), compact: true, unit: '', byDefault: true, chart: true, basis: sum, help: opt(mdef('served')?.definition),
      get: (c) => c.obj.served, fmt: (v) => num(v) },
    ...objective.filter((o) => o.metric !== 'served').map((o): MetricDef => ({ id: `obj:${o.metric}`, group: 'optimization', label: tr(mdef(o.metric)?.label ?? o.metric), unit: mdef(o.metric)?.unit === 's' ? 'min' : mdef(o.metric)?.unit ?? '',
      help: opt(mdef(o.metric)?.definition), byDefault: true, compact: true, chart: true, basis: sum, get: (c) => (c.obj[o.metric] == null ? null : mdef(o.metric)?.unit === 's' ? c.obj[o.metric] / 60 : c.obj[o.metric]), fmt: (v) => num(v, mdef(o.metric)?.unit === 's' ? 1 : 2) })),
    { id: 'service_rate', group: 'optimization', label: tr('Service rate'), unit: '%', byDefault: false, chart: true, basis: ratio,
      get: (c, _r, k) => { const d = riders(k); return d ? (100 * (c.obj.served ?? 0)) / d : null; }, fmt: (v) => `${num(v, 1)} %` },
    { id: 'gap', group: 'optimization', label: tr('Objective difference vs reference'), short: tr('Δ vs ref.'), compact: true, unit: '%', byDefault: true, chart: true,
      help: tr('Relative difference of the last objective level against the reference method ({ref}), on scenarios where the earlier levels are equal. Positive = worse than the reference, negative = better. It is NOT a proven optimality gap: the reference is proven optimal on {p} scenarios; where the reference stopped at its time limit, a negative difference only means a better incumbent was found.', { ref: refName, p: refProven }),
      basis: (k) => (k === 'all' ? tr('mean over the scenarios where it is defined') : tr('this scenario ({s})', { s: one(k) })), get: (c) => c.gap, fmt: (v) => `${v > 0 ? '+' : ''}${num(v, 2)} %`,
      why: (r) => (r.method_id === refRow?.method_id ? 'This is the reference' : null) },
    ...exp.problem.metrics.filter((m) => m.id !== 'served' && !objective.some((o) => o.metric === m.id) && (m.category ?? 'optimization') !== 'mobility').map((m): MetricDef => ({
      id: `metric:${m.id}`, group: 'optimization', label: tr(m.label), unit: m.unit, help: opt(m.definition), byDefault: false, chart: true, basis: sum, get: (c) => c.obj[m.id], fmt: (v) => num(v) })),
    ...facts.map(factDef).filter((d) => d.group === 'optimization'),
    // ---------------------------------------------------------------- ML (labelled evaluation only)
    ...(anyLearned ? ML_METRICS.map(([id, label, help]): MetricDef => ({ id: `ml:${id}`, group: 'ml', label: tr(label), unit: '%', help: tr(help), byDefault: false, chart: false,
      basis: () => tr('evaluation population (see ML evaluation)'), get: (_c, r, k, x) => (k === 'all' ? (pop(x, r)?.metrics[id] != null ? 100 * pop(x, r)!.metrics[id] : null) : null),
      fmt: (v) => `${num(v, 2)} %`, why: mlWhy })) : []),
    ...facts.map(factDef).filter((d) => d.group === 'ml'),
    // ---------------------------------------------------------------- performance
    { id: 'runtime', group: 'performance', label: tr('Runtime'), short: tr('Time'), compact: true, unit: 's', byDefault: !facts.some((f) => f.speedup), chart: true,
      help: tr('Platform wall time of the isolated execution'), basis: (k) => (k === 'all' ? tr('median of the scenario medians') : tr('median of {n} runs', { n: reps })), get: (c) => c.time, fmt: (v) => runtime(v) },
    { id: 'solver_time', group: 'performance', label: tr('Solver time'), unit: 's', byDefault: false, chart: false, help: tr('Solver-reported time'), basis: () => tr('median over scenarios'),
      get: (_c, r, k) => (k === 'all' ? r.solver_time_s : null), fmt: (v) => runtime(v), why: (_r, k) => (k === 'all' ? null : 'Shown over all scenarios') },
    ...facts.map(factDef).filter((d) => d.group === 'performance'),
    speedFact
      ? { id: 'speedup', group: 'performance', label: tr('Speed-up vs {ref}', { ref: refName }), unit: '×', byDefault: true, chart: true,
        help: tr('{label} of the reference method divided by this method’s, on the same scenarios. Above 1 = faster than the reference.', { label: tr(speedFact.label) }),
        basis: (k: Scope) => (k === 'all' ? tr('ratio of sums over {n} scenarios', { n: nScen }) : tr('this scenario ({s})', { s: one(k) })),
        get: (c: Cell, _r: ResultRow, _k: Scope, x: Ctx) => { const a = x.ref?.facts[speedFact.id], b = c.facts[speedFact.id]; return typeof a === 'number' && typeof b === 'number' && b > 0 ? a / b : null; }, fmt: (v: number) => `${num(v, 2)} ×` }
      : { id: 'speedup', group: 'performance', label: tr('Speed-up vs {ref}', { ref: refName }), unit: '×', byDefault: false, chart: true,
        help: tr('Runtime of the reference method divided by this method’s. Above 1 = faster than the reference.'),
        basis: (k: Scope) => (k === 'all' ? tr('ratio of the medians of scenario medians') : tr('ratio of the medians of {n} runs', { n: reps })),
        get: (c: Cell, _r: ResultRow, _k: Scope, x: Ctx) => (x.ref?.time && c.time ? x.ref.time / c.time : null), fmt: (v: number) => `${num(v, 2)} ×` },
    // ---------------------------------------------------------------- mobility and emissions
    ...exp.problem.metrics.filter((m) => m.category === 'mobility').map((m): MetricDef => ({
      id: `metric:${m.id}`, group: 'mobility', label: tr(m.label), unit: m.unit, help: [opt(m.definition), opt(m.note)].filter(Boolean).join('\n'), caveat: opt(m.note), byDefault: !m.note, chart: true, basis: sum, get: (c) => c.obj[m.id], fmt: (v) => `${num(v)} ${m.unit}` })),
    { id: 'vehicles', group: 'mobility', label: tr('Vehicles used'), unit: '', byDefault: hasDomain, chart: true, basis: sum, get: (c) => c.dom?.vehicles_used ?? c.obj.vehicles_used, fmt: (v) => num(v) },
    { id: 'vehicle_km', group: 'mobility', label: tr('Vehicle distance'), unit: 'km', byDefault: hasDomain, chart: true, basis: sum, get: (c) => c.dom?.vehicle_km, fmt: (v) => `${num(v, 1)} km`, why: () => (hasDomain ? null : 'Not configured: this problem records no vehicle distances for the platform') },
    { id: 'co2', group: 'mobility', label: tr('CO₂e emissions'), unit: 'kg', byDefault: hasDomain, chart: true, basis: sum,
      help: emis ? `${emis.scope} · ${emis.baseline}` : undefined, get: (c) => co2(c, (d) => (d.solution_g == null ? null : d.solution_g / 1000)), fmt: (v) => `${num(v, 1)} kg`, why: co2Why },
    { id: 'co2_avoided', group: 'mobility', label: tr('CO₂e avoided'), unit: 'kg', byDefault: false, chart: true, basis: sum, get: (c) => co2(c, (d) => (d.avoided_g == null ? null : d.avoided_g / 1000)), fmt: (v) => `${num(v, 1)} kg`, why: co2Why },
    { id: 'co2_avoided_pct', group: 'mobility', label: tr('CO₂e reduction'), unit: '%', byDefault: hasDomain, chart: true, basis: ratio, get: (c) => co2(c, (d) => d.avoided_pct), fmt: (v) => `${num(v, 1)} %`, why: co2Why },
    { id: 'co2_per_served', group: 'mobility', label: tr('CO₂e per served passenger'), unit: 'kg', byDefault: hasDomain, chart: true, basis: ratio, get: (c) => co2(c, (d) => (d.per_served_request_g == null ? null : d.per_served_request_g / 1000)), fmt: (v) => `${num(v, 2)} kg`, why: co2Why },
    ...facts.map(factDef).filter((d) => d.group === 'mobility'),
    // ---------------------------------------------------------------- custom (registered, sandboxed)
    ...customs.map((x): MetricDef => ({ id: `custom:${x.id}`, group: 'custom', label: x.name, unit: x.unit, help: x.description, byDefault: true, chart: true,
      basis: (k) => (k === 'all' ? `${tr(x.aggregate.replace(/-/g, ' '))} ${tr('over scenarios')}` : tr('this scenario ({s})', { s: one(k) })), get: (c) => c.custom[x.id] ?? null, fmt: (v) => `${num(v, 3)} ${x.unit}` })),
  ];
  return defs;
}

export { chosenIds } from './metricChoice';

/** How a missing value is worded in a table cell, from the reason a metric gives (English reasons, see `why`). */
export const missingWord = (why: string | null | undefined): string => (!why ? '—' : /not configured/i.test(why) ? 'Not configured' : /not applicable/i.test(why) ? 'Not applicable'
  : /reference/i.test(why) ? 'ref.' : /not available|needed|loading|not computed/i.test(why) ? 'Not available' : '—');

/** A value as a table shows it: the metric's own format, with the unit where the heading does not carry it. */
export const shownValue = (d: MetricDef, v: number): string => (d.id.startsWith('obj:') && d.unit === 'min' ? `${d.fmt(v)} min` : d.fmt(v));
