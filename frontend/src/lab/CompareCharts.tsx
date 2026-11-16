import { useCallback, useRef, useState } from 'react';
import { Download, ListChecks } from 'lucide-react';
import { num } from '../components/common';
import { tr } from '../i18n';
import { BASELINE_LABEL, SCOPE_LABEL } from '../mobility/api';
import type { Experiment, ResultRow } from './api';
import { Chart, type ChartData, type Tip } from './Chart';
import { csvText, manifest, selectedCharts, utf8, zip, type ChartExport } from './chartExport';
import { saveBlob, svgToPng } from './chartImage';
import { APP_NAME } from '../brand';
import type { Candidate } from './ComparePicker';
import { cellOf, ridersOf, type Side } from './compareData';
import { metricDefs, type Ctx, type CustomMetric, type MetricDef, type MlEvaluation } from './metrics';
import { scenarioLabel } from './scenarioNames';

export type { CustomMetric } from './metrics';
type Kind = 'bar' | 'grouped' | 'line' | 'box' | 'scatter';
const BASE_COLOR = '#8a97a8', SOL_COLOR = '#00887f';
const KINDS: [Kind, string][] = [['bar', 'Bar'], ['grouped', 'Grouped bar'], ['line', 'Line'], ['box', 'Box plot'], ['scatter', 'Scatter']];

/** Charts of the compared experiments or methods, from recorded results only. The metrics are the ones of the shared
 *  metric model (the same as the table; with a chosen set, only the chosen ones). Each chart type is offered where the
 *  recorded data supports it and is disabled with the reason elsewhere; a metric the problem cannot provide shows why
 *  instead of an empty plot. Details on hover, CSV/PNG/SVG export, and the CO₂ charts with the calculation, baseline and
 *  vehicle parameters they rest on. */
export function CompareCharts({ sides, colors, methodIds, cands, customs, methodSides = false, chosen, mlOf, population = 0, onChoose }: {
  sides: Side[]; colors: string[]; methodIds: string[]; cands: Candidate[]; customs: CustomMetric[]; methodSides?: boolean;
  /** The metric ids chosen in "Choose metrics" (all chartable metrics when absent). */
  chosen?: Set<string>; mlOf?: (r: ResultRow) => MlEvaluation | null; population?: number;
  /** Opens "Choose metrics" (the same dialog and the same choice as the tables). */
  onChoose?: () => void;
}) {
  // the charts on screen hand over what they draw; a selection of them is exported together
  const drawn = useRef(new Map<string, () => ChartExport>());
  const register = useCallback((file: string, get: (() => ChartExport) | null) => { if (get) drawn.current.set(file, get); else drawn.current.delete(file); }, []);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const ea = sides[0]?.e ?? null;
  const [method, setMethod] = useState(methodIds[0] ?? '');
  const [metric, setMetric] = useState('all');
  const [kind, setKind] = useState<Kind>((ea?.scenarios.length ?? 0) > 12 ? 'bar' : 'grouped');
  const m = methodIds.includes(method) ? method : methodIds[0] ?? '';
  const nScen = ea?.scenarios.length ?? 0, reps = ea?.campaign.repetitions ?? 1;
  const scen = (k: number) => scenarioLabel(ea?.scenarios[k], k);
  const all = metricDefs(ea, customs, { nScen, reps, riders: (k) => ridersOf(ea, k, ea), population, names: scen }).filter((d) => d.chart);
  const defs = chosen ? all.filter((d) => chosen.has(d.id)) : all;
  const isCo2 = (d: MetricDef) => d.id.startsWith('co2');
  // CO₂ figures are put side by side only where the CO₂ calculation is comparable with the reference's
  const co2Verdict = (i: number) => (i === 0 ? 'direct' : cands.find((c) => c.campaign_id === sides[i].e?.campaign.campaign_id)?.emissions ?? 'direct');
  // sides are experiments (the chosen method in each), or the methods of one view (methodSides)
  const name = (s: Side) => `${s.label} · ${methodSides ? s.name ?? s.rows.get(m)?.name : s.e?.campaign.title ?? '…'}`;
  // a method the experiments name differently (another policy of the same method) is named per side
  const nameOfMethod = (x: string) => {
    const named = sides.map((s) => [s.label, s.rows.get(x)?.name] as const).filter((y): y is readonly [string, string] => !!y[1]);
    return new Set(named.map((y) => y[1])).size <= 1 ? (named[0]?.[1] ?? x) : named.map(([l, n]) => `${l}: ${n}`).join(' · ');
  };
  const methodName = methodSides ? tr('methods compared') : nameOfMethod(m);
  const runsOf = (s: Side) => Object.values(s.rows.get(m)?.per_scenario ?? {}).flatMap((c) => c.runs ?? []).map((r) => r.total_time_s).filter((x): x is number => x != null);
  const ctxOf = (k: number | 'all'): Ctx => ({ ref: cellOf(sides[0]?.rows.get(m), k, sides[0]?.e ?? null, ea), refRow: sides[0]?.rows.get(m) ?? null, ml: mlOf ?? (() => null) });
  /** One chart of metric d in the requested type (or a bar chart where that type does not apply to d). */
  const build = (d: MetricDef, kind: Kind) => {
    const usable = (i: number) => !isCo2(d) || co2Verdict(i) !== 'incompatible';
    const raw = (s: Side, i: number, k: number | 'all') => { if (!usable(i)) return null; const r = s.rows.get(m); const c = cellOf(r, k, s.e, ea); const v = c && r ? d.get(c, r, k, ctxOf(k)) : null; return v ?? null; };
    // times are drawn in the unit that fits them: milliseconds below one second
    const probe = [...sides.map((s, i) => raw(s, i, 'all')), ...sides.flatMap((s, i) => Array.from({ length: Math.min(nScen, 12) }, (_, k) => raw(s, i, k)))].filter((v): v is number => v != null);
    const ms = d.unit === 's' && probe.length > 0 && Math.max(...probe.map(Math.abs)) < 1;
    const unit = ms ? 'ms' : d.unit, scale = ms ? 1000 : 1;
    const fmt = (v: number) => (d.unit === 's' ? num(v, ms ? 1 : 2) : d.unit === '%' || d.unit === '×' ? num(v, 2) : num(v, Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 2));
    const val = (s: Side, i: number, k: number | 'all') => { const v = raw(s, i, k); return v == null ? null : v * scale; };
    const tipFor = (s: Side, k: number | 'all', v: number, extra?: string): Tip => [name(s), `${tr('Method')}: ${s.rows.get(m)?.name ?? methodName}`, k === 'all' ? `${tr('Scenario')}: ${tr('all {n} scenarios', { n: nScen })}` : `${tr('Scenario')}: ${scen(k)}`,
      `${d.label}: ${fmt(v)} ${unit}`, `${tr('Repetitions')}: ${s.e?.campaign.repetitions ?? '—'}${s.rows.get(m)?.repetitions_consistent ? ` (${tr('identical results')})` : ''}`, `${tr('Aggregation')}: ${extra ?? d.basis(k)}`];
    const perScen = (s: Side, i: number) => Array.from({ length: nScen }, (_, k) => val(s, i, k));
    // which chart types the recorded data supports for this metric (never a chart from insufficient data)
    const why: Partial<Record<Kind, string>> = {};
    const byRep = d.id === 'runtime' && reps >= 2;         // runtime over repetitions: an ordered dimension of its own
    if (nScen < 2) { why.grouped = tr('Needs at least two scenarios.'); if (!byRep) why.line = tr('Needs at least two scenarios (or, for runtime, two repetitions).'); }
    if (d.id === 'runtime' ? sides.some((s) => runsOf(s).length < 5) : nScen < 5) why.box = d.id === 'runtime' ? tr('Needs at least five recorded runs per series.') : tr('Needs at least five scenarios: the box shows the distribution over scenarios.');
    if (d.id === 'runtime') why.scatter = tr('Plots a metric against runtime; choose another metric.');
    else if (nScen < 2) why.scatter = tr('Needs at least two scenarios.');
    const k0: Kind = why[kind] ? 'bar' : kind;
    let data: ChartData;
    const cats = Array.from({ length: nScen }, (_, k) => scen(k));
    if (k0 === 'bar') data = { kind: 'bars', cats: [tr('All {n} scenarios', { n: nScen })], series: sides.map((s, i) => { const v = val(s, i, 'all'); return { name: name(s), color: colors[i], values: [v], tips: [v == null ? null : tipFor(s, 'all', v)] }; }) };
    else if (k0 === 'grouped') data = { kind: 'bars', cats, series: sides.map((s, i) => { const vs = perScen(s, i); return { name: name(s), color: colors[i], values: vs, tips: vs.map((v, k) => (v == null ? null : tipFor(s, k, v))) }; }) };
    else if (k0 === 'line' && byRep) data = { kind: 'line', cats: Array.from({ length: reps }, (_, r) => tr('Repetition {r}', { r: r + 1 })),
      series: sides.map((s, i) => { const vs = Array.from({ length: reps }, (_, r) => { const ts = Object.values(s.rows.get(m)?.per_scenario ?? {}).flatMap((c) => c.runs ?? []).filter((x) => x.repetition === r + 1).map((x) => x.total_time_s).filter((x): x is number => x != null).sort((a, b) => a - b);
        return ts.length ? ts[Math.floor((ts.length - 1) / 2)] * scale : null; });
        return { name: name(s), color: colors[i], values: vs, tips: vs.map((v, r) => (v == null ? null : [...tipFor(s, 'all', v, tr('median over scenarios of repetition {r}', { r: r + 1 })).slice(0, 3), `${tr('Repetition {r}', { r: r + 1 })}: ${fmt(v)} ${unit}`])) }; }) };
    else if (k0 === 'line') data = { kind: 'line', cats, series: sides.map((s, i) => { const vs = perScen(s, i); return { name: name(s), color: colors[i], values: vs, tips: vs.map((v, k) => (v == null ? null : tipFor(s, k, v))) }; }) };
    else if (k0 === 'box' && d.id === 'runtime') data = { kind: 'box', series: sides.map((s, i) => ({ name: s.label, color: colors[i], values: runsOf(s).map((x) => x * scale), tip: [name(s), `${tr('Method')}: ${s.rows.get(m)?.name ?? methodName}`, tr('Runtime of every recorded run ({n} = scenarios × repetitions)', { n: runsOf(s).length })] })) };
    else if (k0 === 'box') data = { kind: 'box', series: sides.map((s, i) => { const vs = perScen(s, i).filter((v): v is number => v != null); return { name: s.label, color: colors[i], values: vs, tip: [name(s), `${tr('Method')}: ${s.rows.get(m)?.name ?? methodName}`, tr('{label}: one value per scenario ({n} scenarios)', { label: d.label, n: vs.length })] }; }) };
    else data = { kind: 'scatter', xLabel: tr('Runtime'), xUnit: 'ms', points: sides.flatMap((s, i) => Array.from({ length: nScen }, (_, k) => { const c = cellOf(s.rows.get(m), k, s.e, ea); const v = val(s, i, k);
      return c?.time != null && v != null ? { x: c.time * 1000, y: v, color: colors[i], series: name(s), tip: [...tipFor(s, k, v), `${tr('Runtime')}: ${num(c.time * 1000, 1)} ms (${tr('median of {n} runs', { n: reps })})`] } : null; }).filter((p): p is NonNullable<typeof p> => !!p)) };
    const excluded = sides.map((s, i) => (!usable(i) ? tr('{s} not shown: its CO₂ calculation is not comparable with A’s', { s: s.label }) : null)).filter(Boolean);
    const conditional = isCo2(d) ? sides.map((s, i) => (i > 0 && co2Verdict(i) === 'conditional' ? tr('{s}: CO₂ comparable with conditions (other vehicle or factor values)', { s: s.label }) : null)).filter(Boolean) : [];
    const has = data.kind === 'scatter' ? data.points.length > 0 : data.kind === 'box' ? data.series.some((s) => s.values.length > 0) : data.series.some((s) => s.values.some((v) => v != null));
    // why there is nothing to draw (asked of every side; the first reason that is not about the reference itself), in
    // English: it is tested below and translated where it is shown
    const reason = has ? null : sides.map((s) => { const r = s.rows.get(m); return r ? d.why?.(r, 'all', ctxOf('all')) ?? null : null; }).find((w) => !!w && !/reference/i.test(w)) ?? null;
    const subtitle = `${methodName} · ${k0 === 'box' ? (d.id === 'runtime' ? tr('every recorded run') : tr('distribution over the {n} scenarios', { n: nScen })) : k0 === 'line' && byRep ? tr('median over scenarios, per repetition')
      : k0 === 'bar' ? d.basis('all') : k0 === 'line' ? tr('one value per scenario, in scenario order (the line joins scenarios, it is not a trend)') : tr('one value per scenario')}`;
    return { d, k0, data, has, why, subtitle, unit, fmt, reason, note: [...excluded, ...conditional].join(' · ') || undefined };
  };
  // "All metrics": one compact card per metric with values (the CO₂ figures have their own cards below); or one metric
  const single = defs.find((x) => x.id === metric);
  const co2Ready = sides.some((s, i) => !!cellOf(s.rows.get(m), 'all', s.e, ea)?.dom?.complete && co2Verdict(i) !== 'incompatible');
  // a metric with nothing to draw is not a blank chart: it is listed with its reason (not configured, not available);
  // a metric that simply has no value in this view is left out
  const shown = (single ? [single] : defs.filter((x) => !(isCo2(x) && co2Ready))).map((x) => build(x, kind)).filter((c) => single || c.has || /not configured|not available|not applicable|needed|not computed/i.test(c.reason ?? ''));
  // a chart type is offered when at least one shown metric supports it (the others are drawn as bars)
  const why: Partial<Record<Kind, string>> = single ? shown[0]?.why ?? {} : Object.fromEntries(KINDS.map(([k]) => [k, shown.length && shown.every((c) => c.why[k]) ? shown[0].why[k] : undefined]).filter(([, v]) => v));
  const k0: Kind = single ? shown[0]?.k0 ?? 'bar' : why[kind] ? 'bar' : kind;

  // ---------------- CO₂ charts: baseline vs solution, avoided (kg and %), per served rider and per vehicle
  const dom = (s: Side) => cellOf(s.rows.get(m), 'all', s.e, ea)?.dom;
  const co2Sides = sides.map((s, i) => ({ s, i, dm: dom(s) })).filter((x) => x.dm?.complete && co2Verdict(x.i) !== 'incompatible');
  const kg = (g: number | null | undefined) => (g == null ? null : g / 1000);
  const co2Tip = (s: Side, label: string, v: number, unit: string, basis: string): Tip => [name(s), `${tr('Method')}: ${s.rows.get(m)?.name ?? methodName}`, `${tr('Scenario')}: ${tr('all {n} scenarios', { n: nScen })}`, `${label}: ${num(v, unit === '%' ? 1 : 2)} ${unit}`,
    `${tr('Repetitions')}: ${s.e?.campaign.repetitions ?? '—'}`, `${tr('Aggregation')}: ${basis}`];
  const cfg = ea?.campaign.emissions;
  const params = (e: Experiment | null) => (e?.scenarios[0]?.vehicles?.fleet ?? []).map((f) => `${f.name}: ${Object.entries(f.parameters as Record<string, { value: number | null; unit: string; source?: string; source_version?: string }>)
    .filter(([, r]) => r.value != null).map(([k, r]) => `${k.replace(/_/g, ' ')} ${r.value} ${r.unit}${r.source ? ` (${r.source}${r.source_version ? `, ${r.source_version}` : ''})` : ''}`).join('; ')}`);
  // ---------------- selection and combined export
  const scopeText = tr('all {n} scenarios', { n: nScen });
  const footer = `${APP_NAME} · ${sides.map((s) => `${s.label}: ${s.e?.campaign.title ?? ''}`).filter((x, i, a) => a.indexOf(x) === i).join(' · ')}`;
  const fileOf = (c: { d: MetricDef; k0: Kind }) => `${c.d.id.replace(/[^A-Za-z0-9_-]+/g, '_')}_${c.k0}`;
  const CO2_FILES = ['co2_baseline_solution', 'co2_avoided_kg', 'co2_avoided_pct', 'co2_per_rider_vehicle'];
  const available = [...shown.filter((c) => c.has).map(fileOf), ...(co2Sides.length > 0 ? CO2_FILES : [])];
  const chosenCharts = selectedCharts(picked, available);
  const pick = (file: string) => ({ checked: picked.has(file), onChange: (on: boolean) => setPicked((p) => { const n = new Set(p); if (on) n.add(file); else n.delete(file); return n; }) });
  const metaOf = (d: MetricDef, k: Kind) => ({ metric_id: d.id, metric: d.label, metric_group: d.group, aggregation: d.basis('all'), scenario_scope: k === 'bar' ? scopeText : tr('one value per scenario ({n} scenarios)', { n: nScen }),
    methods: sides.map((s) => s.rows.get(m)?.name ?? '').filter(Boolean) });
  const co2Meta = (metric: string) => ({ metric_id: 'co2', metric, metric_group: 'mobility', scenario_scope: scopeText, methods: sides.map((s) => s.rows.get(m)?.name ?? '').filter(Boolean),
    co2_calculation: cfg ? { scope: cfg.scope, baseline: cfg.baseline } : null });
  const exportSelected = async () => {
    setExporting(true); setExportNote(null);
    try {
      const charts = chosenCharts.map((f) => drawn.current.get(f)?.()).filter((c): c is ChartExport => !!c);
      if (!charts.length) { setExportNote(tr('Select at least one chart to export.')); return; }
      const files: { name: string; data: Uint8Array }[] = [];
      for (const c of charts) {
        const png = await svgToPng(c.svg, c.width, c.height);
        files.push({ name: `charts/${c.file}.png`, data: new Uint8Array(await png.arrayBuffer()) }, { name: `charts/${c.file}.svg`, data: utf8(c.svg) }, { name: `charts/${c.file}.csv`, data: utf8(csvText(c.csv)) });
      }
      const when = new Date();
      const prov = { application: APP_NAME, comparison: methodSides ? 'methods on the same scenarios' : 'experiments', scenarios: nScen, repetitions: reps,
        compared: sides.map((s, i) => ({ label: s.label, reference: i === 0, experiment: s.e?.campaign.title ?? null, campaign_id: s.e?.campaign.campaign_id ?? null, method: s.rows.get(m)?.name ?? null, method_id: s.rows.get(m)?.method_id ?? null,
          origin: s.rows.get(m)?.origin ?? null, locked: s.e?.campaign.locked ?? null, validator_version: s.e?.validation.validator_version ?? null,
          runs_accepted: s.e ? `${s.e.validation.accepted}/${s.e.validation.runs}` : null })),
        problem: ea?.problem.title ?? null, co2_calculation: cfg ? { scope: cfg.scope, baseline: cfg.baseline } : null,
        note: 'Every figure is read from recorded, independently validated results; images are the charts as drawn on screen.' };
      files.push({ name: 'manifest.json', data: utf8(`${JSON.stringify(manifest(charts, prov, when.toISOString()), null, 2)}\n`) });
      files.push({ name: 'README.txt', data: utf8(`${APP_NAME} chart export, ${when.toISOString()}\n\ncharts/<name>.png  the chart as drawn, with its title, legend and provenance line\ncharts/<name>.svg  the same image as vectors\ncharts/<name>.csv  the numbers behind the chart\nmanifest.json      title, metric, unit, chart type, scenario scope, series and provenance of every chart\n`) });
      saveBlob(new Blob([zip(files, when) as BlobPart], { type: 'application/zip' }), `move_openlab_charts_${when.toISOString().slice(0, 19).replace(/[-:T]/g, '')}.zip`);
      setExportNote(tr('{n} charts exported: one ZIP with a PNG, an SVG and a CSV per chart, and a manifest.', { n: charts.length }));
    } catch { setExportNote(tr('The export failed: the browser could not draw a chart image.')); } finally { setExporting(false); }
  };
  return <div className="cmp-charts">
    <div className="row gap wrap chart-controls" role="group" aria-label={tr('chart settings')}>
      <label className="row small gap">{tr('Metric')} <select aria-label={tr('metric')} value={single ? single.id : 'all'} onChange={(e) => setMetric(e.target.value)}><option value="all">{chosen ? tr('All chosen metrics') : tr('All metrics')}</option>{defs.map((x) => <option key={x.id} value={x.id}>{x.label}{x.unit ? ` (${x.unit})` : ''}</option>)}</select></label>
      {methodIds.length > 1 && <label className="row small gap">{tr('Method')} <select aria-label={tr('method for charts')} value={m} onChange={(e) => setMethod(e.target.value)}>{methodIds.map((x) => <option key={x} value={x}>{nameOfMethod(x)}</option>)}</select></label>}
      <div className="seg" role="group" aria-label={tr('chart type')}>{KINDS.map(([k, label]) => <button key={k} className={k0 === k ? 'on' : ''} aria-pressed={k0 === k} disabled={!!why[k]} title={why[k] ?? undefined} onClick={() => setKind(k)}>{tr(label)}</button>)}</div>
      {onChoose && <button className="btn sm" onClick={onChoose}><ListChecks size={13} /> {tr('Choose metrics')}</button>}
    </div>
    <div className="row gap wrap chart-export" role="group" aria-label={tr('export charts')}>
      <span className="small muted" aria-live="polite">{tr('{n} of {m} charts selected', { n: chosenCharts.length, m: available.length })}</span>
      <button className="btn sm" disabled={!available.length} onClick={() => setPicked(new Set(available))}>{tr('Select all charts')}</button>
      <button className="btn sm" disabled={!chosenCharts.length} onClick={() => setPicked(new Set())}>{tr('Clear selection')}</button>
      <button className="btn sm primary" disabled={!chosenCharts.length || exporting} title={chosenCharts.length ? tr('One ZIP: a PNG, an SVG and a CSV per selected chart, and a manifest with titles, metrics, units, scope, methods and provenance') : tr('Tick the charts to export (the box before each title), or Select all charts')}
        onClick={exportSelected}><Download size={13} /> {exporting ? tr('Exporting…') : tr('Export selected (ZIP)')}</button>
      {exportNote && <span className="small" role="status">{exportNote}</span>}
    </div>
    {shown.length === 0 && <p className="note small" role="status">{tr('No chosen metric has values to chart for this selection. Open "Choose metrics" to pick others.')}</p>}
    <div className="charts-grid">
      {shown.map((c) => (c.has ? <Chart key={c.d.id} title={c.d.label} subtitle={c.subtitle} unit={c.unit} data={c.data} fmt={c.fmt}
        file={fileOf(c)} note={c.note} meta={metaOf(c.d, c.k0)} footer={footer} select={pick(fileOf(c))} register={register} />
        : <section key={c.d.id} className="card chart-card chart-na" aria-label={`${c.d.label}: ${tr('not available')}`}><h4>{c.d.label}</h4>
          <p className="small"><span className="badge">{/not configured/i.test(c.reason ?? '') ? tr('Not configured') : tr('Not available')}</span></p><p className="small muted">{c.reason ? tr(c.reason) : tr('No value was recorded for this metric.')}</p></section>))}
    </div>
    {co2Sides.length > 0 && <section className="co2-charts"><h3>{tr('CO₂: baseline, solution and savings')}</h3>
      <p className="small muted">{cfg ? tr('{scope} · baseline: {baseline}', { scope: tr(SCOPE_LABEL[cfg.scope] ?? cfg.scope), baseline: tr(BASELINE_LABEL[cfg.baseline] ?? cfg.baseline).toLowerCase() }) : tr('CO₂ calculation not configured')} · {methodName} · {tr('all {n} scenarios', { n: nScen })} · kg CO₂e
        {sides.some((_, i) => co2Verdict(i) === 'incompatible') ? ` · ${tr('{s} left out: other CO₂ calculation', { s: sides.filter((_, i) => co2Verdict(i) === 'incompatible').map((s) => s.label).join(', ') })}` : ''}</p>
      <div className="charts-grid">
        <Chart title={tr('Baseline and solution CO₂')} subtitle={tr("everyone's trips under the baseline vs the computed solution")} unit="kg CO₂e" file="co2_baseline_solution" meta={co2Meta(tr('Baseline and solution CO₂'))} footer={footer} select={pick('co2_baseline_solution')} register={register} fmt={(v) => num(v, 1)}
          data={{ kind: 'bars', cats: co2Sides.map((x) => x.s.label), series: [
            { name: tr('Baseline'), color: BASE_COLOR, values: co2Sides.map((x) => kg(x.dm!.baseline_g)), tips: co2Sides.map((x) => (x.dm!.baseline_g == null ? null : co2Tip(x.s, tr('Baseline CO₂'), x.dm!.baseline_g / 1000, 'kg CO₂e', tr('sum over scenarios')))) },
            { name: tr('Solution'), color: SOL_COLOR, values: co2Sides.map((x) => kg(x.dm!.solution_g)), tips: co2Sides.map((x) => (x.dm!.solution_g == null ? null : co2Tip(x.s, tr('Solution CO₂'), x.dm!.solution_g / 1000, 'kg CO₂e', tr('sum over scenarios')))) }] }} />
        <Chart title={tr('CO₂ avoided')} subtitle={tr('baseline − solution; below zero when the solution emits more')} unit="kg CO₂e" file="co2_avoided_kg" meta={co2Meta(tr('CO₂ avoided'))} footer={footer} select={pick('co2_avoided_kg')} register={register} fmt={(v) => num(v, 1)}
          data={{ kind: 'bars', cats: [tr('All {n} scenarios', { n: nScen })], series: co2Sides.map((x) => ({ name: name(x.s), color: colors[x.i], values: [kg(x.dm!.avoided_g)], tips: [x.dm!.avoided_g == null ? null : co2Tip(x.s, tr('CO₂ avoided'), x.dm!.avoided_g / 1000, 'kg CO₂e', tr('baseline − solution, sums over scenarios'))] })) }} />
        <Chart title={tr('CO₂ avoided (%)')} subtitle={tr('share of the baseline; ratio of sums')} unit="%" file="co2_avoided_pct" meta={co2Meta(tr('CO₂ avoided (%)'))} footer={footer} select={pick('co2_avoided_pct')} register={register} fmt={(v) => num(v, 1)}
          data={{ kind: 'bars', cats: [tr('All {n} scenarios', { n: nScen })], series: co2Sides.map((x) => ({ name: name(x.s), color: colors[x.i], values: [x.dm!.avoided_pct ?? null], tips: [x.dm!.avoided_pct == null ? null : co2Tip(x.s, tr('CO₂ avoided'), x.dm!.avoided_pct, '%', tr('ratio of sums'))] })) }} />
        <Chart title={tr('CO₂ per served rider and per vehicle')} subtitle={tr('solution CO₂ divided by riders served / vehicles used')} unit="kg CO₂e" file="co2_per_rider_vehicle" meta={co2Meta(tr('CO₂ per served rider and per vehicle'))} footer={footer} select={pick('co2_per_rider_vehicle')} register={register} fmt={(v) => num(v, 2)}
          data={{ kind: 'bars', cats: co2Sides.map((x) => x.s.label), series: [
            { name: tr('per served rider'), color: SOL_COLOR, values: co2Sides.map((x) => kg(x.dm!.per_served_request_g)), tips: co2Sides.map((x) => (x.dm!.per_served_request_g == null ? null : co2Tip(x.s, tr('CO₂ per served rider'), x.dm!.per_served_request_g / 1000, 'kg CO₂e', tr('ratio of sums')))) },
            { name: tr('per vehicle used'), color: BASE_COLOR, values: co2Sides.map((x) => kg(x.dm!.per_vehicle_g)), tips: co2Sides.map((x) => (x.dm!.per_vehicle_g == null ? null : co2Tip(x.s, tr('CO₂ per vehicle used'), x.dm!.per_vehicle_g / 1000, 'kg CO₂e', tr('ratio of sums')))) }] }} />
      </div>
      <details className="small co2-prov"><summary>{tr('Calculation, baseline and vehicle parameters')}</summary>
        <ul className="plain">{co2Sides.map((x) => <li key={x.s.label}><b>{x.s.label}</b> · {x.s.e?.campaign.emissions ? tr('{scope}, baseline {baseline}', { scope: tr(SCOPE_LABEL[x.s.e.campaign.emissions.scope] ?? x.s.e.campaign.emissions.scope), baseline: tr(BASELINE_LABEL[x.s.e.campaign.emissions.baseline] ?? x.s.e.campaign.emissions.baseline).toLowerCase() }) : '—'}
          {co2Verdict(x.i) === 'conditional' ? ` · ${tr('comparable with conditions (other vehicle or factor values)')}` : ''}
          <ul className="plain muted">{params(x.s.e).map((p) => <li key={p}>{p}</li>)}</ul></li>)}</ul></details>
    </section>}
  </div>;
}
