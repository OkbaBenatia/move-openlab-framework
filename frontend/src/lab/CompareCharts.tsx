import { useState } from 'react';
import { num } from '../components/common';
import { BASELINE_LABEL, SCOPE_LABEL } from '../mobility/api';
import type { Experiment } from './api';
import { Chart, type ChartData, type Tip } from './Chart';
import type { Candidate } from './ComparePicker';
import { cellOf, ridersOf, type Cell, type Side } from './compareData';

export interface CustomMetric { id: string; version: string; name: string; unit: string; direction: string; aggregate: string; description: string; provenance: string }
type Kind = 'bar' | 'grouped' | 'line' | 'box' | 'scatter';
interface MetricDef { id: string; label: string; unit: string; fmt: (v: number) => string; basis: (k: number | 'all') => string; co2?: boolean;
  get: (c: Cell, e: Experiment | null, k: number | 'all') => number | null | undefined }
const BASE_COLOR = '#8a97a8', SOL_COLOR = '#00887f';
const KINDS: [Kind, string][] = [['bar', 'Bar'], ['grouped', 'Grouped bar'], ['line', 'Line'], ['box', 'Box plot'], ['scatter', 'Scatter']];

/** Charts of the compared experiments, from recorded results only: a metric selector (compatible metrics of the
 *  problem, CO₂ when computed, registered custom metrics), a chart type where the data supports it (types that would
 *  be meaningless are disabled with the reason), details on hover, CSV/PNG/SVG export, and the CO₂ charts with the
 *  calculation, baseline and vehicle parameters they rest on. */
export function CompareCharts({ sides, colors, methodIds, cands, customs, methodSides = false }: {
  sides: Side[]; colors: string[]; methodIds: string[]; cands: Candidate[]; customs: CustomMetric[]; methodSides?: boolean;
}) {
  const ea = sides[0]?.e ?? null;
  const [method, setMethod] = useState(methodIds[0] ?? '');
  const [metric, setMetric] = useState('all');
  const [kind, setKind] = useState<Kind>('grouped');
  const m = methodIds.includes(method) ? method : methodIds[0] ?? '';
  const nScen = ea?.scenarios.length ?? 0, reps = ea?.campaign.repetitions ?? 1;
  const riders = (e: Experiment | null, k: number | 'all') => ridersOf(e, k, ea);
  const objective = ea?.problem.objective ?? [];
  const mdef = (id: string) => ea?.problem.metrics.find((x) => x.id === id);
  const sum = (k: number | 'all') => (k === 'all' ? `sum over ${nScen} scenarios` : `sample ${k + 1}`);
  const ratio = (k: number | 'all') => (k === 'all' ? 'ratio of sums' : `sample ${k + 1}`);
  const co2 = (c: Cell, f: (d: NonNullable<Cell['dom']>) => number | null | undefined) => (c.dom?.complete ? f(c.dom) ?? null : null);
  const defs: MetricDef[] = [
    { id: 'served', label: 'Served riders', unit: 'riders', fmt: (v) => num(v), basis: sum, get: (c) => c.obj.served },
    ...objective.filter((o) => o.metric !== 'served').map((o) => ({ id: o.metric, label: mdef(o.metric)?.label ?? o.metric, unit: mdef(o.metric)?.unit === 's' ? 'min' : mdef(o.metric)?.unit ?? '',
      fmt: (v: number) => num(v, 1), basis: sum, get: (c: Cell) => (c.obj[o.metric] == null ? null : mdef(o.metric)?.unit === 's' ? c.obj[o.metric] / 60 : c.obj[o.metric]) })),
    { id: 'service_rate', label: 'Service rate', unit: '%', fmt: (v) => num(v, 1), basis: ratio, get: (c, e, k) => { const r = riders(e, k); return r ? (100 * (c.obj.served ?? 0)) / r : null; } },
    { id: 'gap', label: 'Gap to the exact reference', unit: '%', fmt: (v) => num(v, 2), basis: (k) => (k === 'all' ? 'mean over scenarios' : `sample ${k + 1}`), get: (c) => c.gap },
    { id: 'runtime', label: 'Runtime', unit: 'ms', fmt: (v) => num(v, 1), basis: (k) => (k === 'all' ? 'median of scenario medians' : `median of ${reps} runs`), get: (c) => (c.time == null ? null : c.time * 1000) },
    { id: 'vehicles', label: 'Vehicles used', unit: 'vehicles', fmt: (v) => num(v), basis: sum, get: (c) => c.dom?.vehicles_used },
    { id: 'vehicle_km', label: 'Vehicle distance', unit: 'km', fmt: (v) => num(v, 1), basis: sum, get: (c) => c.dom?.vehicle_km },
    { id: 'co2', label: 'CO₂ emissions', unit: 'kg CO₂e', co2: true, fmt: (v) => num(v, 1), basis: sum, get: (c) => co2(c, (d) => (d.solution_g == null ? null : d.solution_g / 1000)) },
    { id: 'co2_avoided', label: 'CO₂ avoided', unit: 'kg CO₂e', co2: true, fmt: (v) => num(v, 1), basis: sum, get: (c) => co2(c, (d) => (d.avoided_g == null ? null : d.avoided_g / 1000)) },
    { id: 'co2_avoided_pct', label: 'CO₂ avoided', unit: '%', co2: true, fmt: (v) => num(v, 1), basis: ratio, get: (c) => co2(c, (d) => d.avoided_pct) },
    ...customs.map((x) => ({ id: `custom:${x.id}`, label: `${x.name} (custom metric)`, unit: x.unit, fmt: (v: number) => num(v, 2),
      basis: (k: number | 'all') => (k === 'all' ? `${x.aggregate.replace(/-/g, ' ')} over scenarios` : `sample ${k + 1}`), get: (c: Cell) => c.custom[x.id] ?? null })),
  ];
  // CO₂ figures are put side by side only where the CO₂ calculation is comparable with the reference's
  const co2Verdict = (i: number) => (i === 0 ? 'direct' : cands.find((c) => c.campaign_id === sides[i].e?.campaign.campaign_id)?.emissions ?? 'direct');
  // sides are experiments (the chosen method in each), or the methods of one experiment (methodSides)
  const name = (s: Side) => `${s.label} · ${methodSides ? s.name ?? s.rows.get(m)?.name : s.e?.campaign.title ?? '…'}`;
  const methodName = methodSides ? `${sides[0]?.e?.campaign.title ?? ''} · methods compared` : sides.map((s) => s.rows.get(m)?.name).find(Boolean) ?? m;
  const runsOf = (s: Side) => Object.values(s.rows.get(m)?.per_scenario ?? {}).flatMap((c) => c.runs ?? []).map((r) => r.total_time_s).filter((x): x is number => x != null);
  /** One chart of metric d in the requested type (or a bar chart where that type does not apply to d). */
  const build = (d: MetricDef, kind: Kind) => {
  const usable = (i: number) => !d.co2 || co2Verdict(i) !== 'incompatible';
    const tipFor = (s: Side, k: number | 'all', v: number, extra?: string): Tip => [name(s), `Method: ${s.rows.get(m)?.name ?? methodName}`, k === 'all' ? `Scenario: all ${nScen} scenarios` : `Scenario: sample ${k + 1}`,
      `${d.label}: ${d.fmt(v)} ${d.unit}`, `Repetitions: ${s.e?.campaign.repetitions ?? '—'}${s.rows.get(m)?.repetitions_consistent ? ' (identical results)' : ''}`, `Aggregation: ${extra ?? d.basis(k)}`];
    const val = (s: Side, i: number, k: number | 'all') => { if (!usable(i)) return null; const c = cellOf(s.rows.get(m), k, s.e, ea); const v = c ? d.get(c, s.e, k) : null; return v ?? null; };
    // which chart types the recorded data supports for this metric (never a chart from insufficient data)
    const why: Partial<Record<Kind, string>> = {};
    if (d.id !== 'runtime') { why.line = 'Needs an ordered dimension; here only runtime has one (repetition 1, 2, 3…).'; why.box = 'Needs at least five recorded values per experiment; here only runtime has them (one per run).'; }
    else { if (reps < 2) why.line = 'Needs at least two repetitions.'; if (sides.some((s) => runsOf(s).length < 5)) why.box = 'Needs at least five recorded runs per experiment.'; }
    if (d.id === 'runtime') why.scatter = 'Plots a metric against runtime; choose another metric.';
    if (nScen < 2) why.grouped = 'Needs at least two scenarios.';
    const k0: Kind = why[kind] ? 'bar' : kind;
    let data: ChartData;
    if (k0 === 'bar') data = { kind: 'bars', cats: [`All ${nScen} scenarios`], series: sides.map((s, i) => { const v = val(s, i, 'all'); return { name: name(s), color: colors[i], values: [v], tips: [v == null ? null : tipFor(s, 'all', v)] }; }) };
    else if (k0 === 'grouped') data = { kind: 'bars', cats: Array.from({ length: nScen }, (_, k) => `Sample ${k + 1}`),
      series: sides.map((s, i) => { const vs = Array.from({ length: nScen }, (_, k) => val(s, i, k)); return { name: name(s), color: colors[i], values: vs, tips: vs.map((v, k) => (v == null ? null : tipFor(s, k, v))) }; }) };
    else if (k0 === 'line') data = { kind: 'line', cats: Array.from({ length: reps }, (_, r) => `Repetition ${r + 1}`),
      series: sides.map((s, i) => { const vs = Array.from({ length: reps }, (_, r) => { const ts = Object.values(s.rows.get(m)?.per_scenario ?? {}).flatMap((c) => c.runs ?? []).filter((x) => x.repetition === r + 1).map((x) => x.total_time_s).filter((x): x is number => x != null).sort((a, b) => a - b);
        return ts.length ? ts[Math.floor((ts.length - 1) / 2)] * 1000 : null; });
        return { name: name(s), color: colors[i], values: vs, tips: vs.map((v, r) => (v == null ? null : [...tipFor(s, 'all', v, `median over scenarios of repetition ${r + 1}`).slice(0, 3), `Repetition ${r + 1}: ${d.fmt(v)} ms`])) }; }) };
    else if (k0 === 'box') data = { kind: 'box', series: sides.map((s, i) => ({ name: s.label, color: colors[i], values: runsOf(s).map((x) => x * 1000), tip: [name(s), `Method: ${s.rows.get(m)?.name ?? methodName}`, `Runtime of every recorded run (${runsOf(s).length} = scenarios × repetitions)`] })) };
    else data = { kind: 'scatter', xLabel: 'Runtime', xUnit: 'ms', points: sides.flatMap((s, i) => Array.from({ length: nScen }, (_, k) => { const c = cellOf(s.rows.get(m), k, s.e, ea); const v = val(s, i, k);
      return c?.time != null && v != null ? { x: c.time * 1000, y: v, color: colors[i], series: name(s), tip: [...tipFor(s, k, v), `Runtime: ${num(c.time * 1000, 1)} ms (median of ${reps} runs)`] } : null; }).filter((p): p is NonNullable<typeof p> => !!p)) };
    const excluded = sides.map((s, i) => (!usable(i) ? `${s.label} not shown: its CO₂ calculation is not comparable with A's` : null)).filter(Boolean);
    const conditional = d.co2 ? sides.map((s, i) => (i > 0 && co2Verdict(i) === 'conditional' ? `${s.label}: CO₂ comparable with conditions (other vehicle or factor values)` : null)).filter(Boolean) : [];
    const has = data.kind === 'scatter' ? data.points.length > 0 : data.kind === 'box' ? data.series.some((s) => s.values.length > 0) : data.series.some((s) => s.values.some((v) => v != null));
    const subtitle = `${methodName} · ${k0 === 'box' ? 'every recorded run' : k0 === 'line' ? 'median over scenarios, per repetition' : d.basis(k0 === 'bar' ? 'all' : 0).replace('sample 1', 'per scenario')}`;
    return { d, k0, data, has, why, subtitle, note: [...excluded, ...conditional].join(' · ') || undefined };
  };
  // "All metrics": one compact card per metric with values (the CO₂ figures have their own cards below); or one metric
  const single = defs.find((x) => x.id === metric);
  const co2Ready = sides.some((s, i) => !!cellOf(s.rows.get(m), 'all', s.e, ea)?.dom?.complete && co2Verdict(i) !== 'incompatible');
  const shown = (single ? [single] : defs.filter((x) => !(x.co2 && co2Ready))).map((x) => build(x, kind)).filter((c) => single || c.has);
  // a chart type is offered when at least one shown metric supports it (the others are drawn as bars)
  const why: Partial<Record<Kind, string>> = single ? shown[0]?.why ?? {} : Object.fromEntries(KINDS.map(([k]) => [k, shown.length && shown.every((c) => c.why[k]) ? shown[0].why[k] : undefined]).filter(([, v]) => v));
  const k0: Kind = single ? shown[0]?.k0 ?? 'bar' : why[kind] ? 'bar' : kind;

  // ---------------- CO₂ charts: baseline vs solution, avoided (kg and %), per served rider and per vehicle
  const dom = (s: Side) => cellOf(s.rows.get(m), 'all', s.e, ea)?.dom;
  const co2Sides = sides.map((s, i) => ({ s, i, dm: dom(s) })).filter((x) => x.dm?.complete && co2Verdict(x.i) !== 'incompatible');
  const kg = (g: number | null | undefined) => (g == null ? null : g / 1000);
  const co2Tip = (s: Side, label: string, v: number, unit: string, basis: string): Tip => [name(s), `Method: ${s.rows.get(m)?.name ?? methodName}`, `Scenario: all ${nScen} scenarios`, `${label}: ${num(v, unit === '%' ? 1 : 2)} ${unit}`,
    `Repetitions: ${s.e?.campaign.repetitions ?? '—'}`, `Aggregation: ${basis}`];
  const cfg = ea?.campaign.emissions;
  const params = (e: Experiment | null) => (e?.scenarios[0]?.vehicles?.fleet ?? []).map((f) => `${f.name}: ${Object.entries(f.parameters as Record<string, { value: number | null; unit: string; source?: string; source_version?: string }>)
    .filter(([, r]) => r.value != null).map(([k, r]) => `${k.replace(/_/g, ' ')} ${r.value} ${r.unit}${r.source ? ` (${r.source}${r.source_version ? `, ${r.source_version}` : ''})` : ''}`).join('; ')}`);
  return <div className="cmp-charts">
    <div className="row gap wrap chart-controls" role="group" aria-label="chart settings">
      <label className="row small gap">Metric <select aria-label="metric" value={single ? single.id : 'all'} onChange={(e) => setMetric(e.target.value)}><option value="all">All metrics</option>{defs.map((x) => <option key={x.id} value={x.id}>{x.label} ({x.unit})</option>)}</select></label>
      {methodIds.length > 1 && <label className="row small gap">Method <select aria-label="method for charts" value={m} onChange={(e) => setMethod(e.target.value)}>{methodIds.map((x) => <option key={x} value={x}>{sides.map((s) => s.rows.get(x)?.name).find(Boolean) ?? x}</option>)}</select></label>}
      <div className="seg" role="group" aria-label="chart type">{KINDS.map(([k, label]) => <button key={k} className={k0 === k ? 'on' : ''} aria-pressed={k0 === k} disabled={!!why[k]} title={why[k] ?? undefined} onClick={() => setKind(k)}>{label}</button>)}</div>
    </div>
    <div className="charts-grid">
      {shown.map((c) => <Chart key={c.d.id} title={c.d.label} subtitle={c.subtitle} unit={c.d.unit} data={c.data} fmt={c.d.fmt}
        file={`${c.d.id.replace(':', '_')}_${c.k0}`} note={c.note} />)}
    </div>
    {co2Sides.length > 0 && <section className="co2-charts"><h3>CO₂: baseline, solution and savings</h3>
      <p className="small muted">{cfg ? `${SCOPE_LABEL[cfg.scope] ?? cfg.scope} · baseline: ${(BASELINE_LABEL[cfg.baseline] ?? cfg.baseline).toLowerCase()}` : 'CO₂ calculation not configured'} · {methodName} · all {nScen} scenarios · kg CO₂e
        {sides.some((_, i) => co2Verdict(i) === 'incompatible') ? ` · ${sides.filter((_, i) => co2Verdict(i) === 'incompatible').map((s) => s.label).join(', ')} left out: other CO₂ calculation` : ''}</p>
      <div className="charts-grid">
        <Chart title="Baseline and solution CO₂" subtitle="everyone's trips under the baseline vs the computed solution" unit="kg CO₂e" file="co2_baseline_solution" fmt={(v) => num(v, 1)}
          data={{ kind: 'bars', cats: co2Sides.map((x) => x.s.label), series: [
            { name: 'Baseline', color: BASE_COLOR, values: co2Sides.map((x) => kg(x.dm!.baseline_g)), tips: co2Sides.map((x) => (x.dm!.baseline_g == null ? null : co2Tip(x.s, 'Baseline CO₂', x.dm!.baseline_g / 1000, 'kg CO₂e', 'sum over scenarios'))) },
            { name: 'Solution', color: SOL_COLOR, values: co2Sides.map((x) => kg(x.dm!.solution_g)), tips: co2Sides.map((x) => (x.dm!.solution_g == null ? null : co2Tip(x.s, 'Solution CO₂', x.dm!.solution_g / 1000, 'kg CO₂e', 'sum over scenarios'))) }] }} />
        <Chart title="CO₂ avoided" subtitle="baseline − solution; below zero when the solution emits more" unit="kg CO₂e" file="co2_avoided_kg" fmt={(v) => num(v, 1)}
          data={{ kind: 'bars', cats: [`All ${nScen} scenarios`], series: co2Sides.map((x) => ({ name: name(x.s), color: colors[x.i], values: [kg(x.dm!.avoided_g)], tips: [x.dm!.avoided_g == null ? null : co2Tip(x.s, 'CO₂ avoided', x.dm!.avoided_g / 1000, 'kg CO₂e', 'baseline − solution, sums over scenarios')] })) }} />
        <Chart title="CO₂ avoided (%)" subtitle="share of the baseline; ratio of sums" unit="%" file="co2_avoided_pct" fmt={(v) => num(v, 1)}
          data={{ kind: 'bars', cats: [`All ${nScen} scenarios`], series: co2Sides.map((x) => ({ name: name(x.s), color: colors[x.i], values: [x.dm!.avoided_pct ?? null], tips: [x.dm!.avoided_pct == null ? null : co2Tip(x.s, 'CO₂ avoided', x.dm!.avoided_pct, '%', 'ratio of sums')] })) }} />
        <Chart title="CO₂ per served rider and per vehicle" subtitle="solution CO₂ divided by riders served / vehicles used" unit="kg CO₂e" file="co2_per_rider_vehicle" fmt={(v) => num(v, 2)}
          data={{ kind: 'bars', cats: co2Sides.map((x) => x.s.label), series: [
            { name: 'per served rider', color: SOL_COLOR, values: co2Sides.map((x) => kg(x.dm!.per_served_request_g)), tips: co2Sides.map((x) => (x.dm!.per_served_request_g == null ? null : co2Tip(x.s, 'CO₂ per served rider', x.dm!.per_served_request_g / 1000, 'kg CO₂e', 'ratio of sums'))) },
            { name: 'per vehicle used', color: BASE_COLOR, values: co2Sides.map((x) => kg(x.dm!.per_vehicle_g)), tips: co2Sides.map((x) => (x.dm!.per_vehicle_g == null ? null : co2Tip(x.s, 'CO₂ per vehicle used', x.dm!.per_vehicle_g / 1000, 'kg CO₂e', 'ratio of sums'))) }] }} />
      </div>
      <details className="small co2-prov"><summary>Calculation, baseline and vehicle parameters</summary>
        <ul className="plain">{co2Sides.map((x) => <li key={x.s.label}><b>{x.s.label}</b> · {x.s.e?.campaign.emissions ? `${SCOPE_LABEL[x.s.e.campaign.emissions.scope] ?? x.s.e.campaign.emissions.scope}, baseline ${(BASELINE_LABEL[x.s.e.campaign.emissions.baseline] ?? x.s.e.campaign.emissions.baseline).toLowerCase()}` : '—'}
          {co2Verdict(x.i) === 'conditional' ? ' · comparable with conditions (other vehicle or factor values)' : ''}
          <ul className="plain muted">{params(x.s.e).map((p) => <li key={p}>{p}</li>)}</ul></li>)}</ul></details>
    </section>}
  </div>;
}
