import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Download, Info, ListChecks, ShieldCheck } from 'lucide-react';
import { ErrorNote, errText, num } from '../components/common';
import { tr } from '../i18n';
import { lab, type Experiment, type ResultRow } from './api';
import { CompareCharts } from './CompareCharts';
import { CompareTabs } from './CompareTabs';
import { cellOf, plain, servedOf, type Side } from './compareData';
import { MethodMaps } from './MethodMaps';
import { MetricChooser } from './MetricChooser';
import { MlEvaluationView } from './MlEvaluation';
import { GROUPS, metricDefs, missingWord, type Ctx, type MetricDef } from './metrics';
import { useMetricChoice, useMlEvaluations } from './useMetrics';
import { ScenarioNav } from './ScenarioNav';
import { scenarioLabel } from './scenarioNames';
import { statusOf } from './ComparePanel';

const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', '#9085e9', '#e87ba4', '#4f8a5b', '#b7791f', '#5b6b8c'];
const letter = (i: number) => String.fromCharCode(65 + i);
const ME = '*';                                   // the single row key of a method side
type Tab = 'results' | 'charts' | 'maps' | 'ml';
/** A status label in the interface language; the count it may end with ("… 3/5") is kept as it is. */
const statusText = (label: string) => { const m = /^(.*?)( \d+\/\d+)$/.exec(label); return m ? `${tr(m[1])}${m[2]}` : tr(label); };

/** Route argument `<experiment>` or `<experiment>|<method key>,<method key>…`. A method key is `method_id@version`,
 *  or `experiment:method_id` when the same method appears from two experiments. */
export const methodsRoute = (cid: string, keys: string[] = []) => (keys.length ? `${cid}|${keys.join(',')}` : cid);
const keyer = (rows: ResultRow[]) => (r: ResultRow) => (rows.filter((x) => x.method_id === r.method_id && x.version === r.version).length > 1 ? `${r.campaign_id}:${r.method_id}` : `${r.method_id}@${r.version}`);

/** Methods compared on the same frozen scenarios. The rows are the experiment's own methods (with the experiment it
 *  extends), or the members of a saved study: methods of several locked experiments evaluated on the same scenarios,
 *  each named with the experiment it comes from. The first selected method is the reference of the differences. */
export function CompareMethods({ arg, go, back, onExperiments }: { arg: string; go: (route: string) => void; back: () => void; onExperiments?: (cid: string) => void }) {
  const [cid, keyList] = arg.split('|');
  const [exp, setExp] = useState<Experiment | null>(null);
  const [records, setRecords] = useState(false);            // the experiment's own records instead of its study view
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('results');
  const [scope, setScope] = useState<number | 'all'>('all');
  const [population, setPopulation] = useState(0);
  const mc = useMetricChoice(exp, { population });
  const { defs, chosen, visible, customs } = mc;
  useEffect(() => { setExp(null); lab.experiment(cid, records ? 'records' : '').then(setExp).catch((e) => setErr(errText(e))); }, [cid, records]);
  // one row per method and experiment, in the order of the view
  const all = useMemo(() => {
    const rows = exp?.results?.rows ?? [];
    if (exp?.view?.mode === 'study') return rows;
    const m = new Map<string, ResultRow>();
    for (const r of rows) { const k = `${r.method_id}@${r.version}`; const cur = m.get(k); if (!cur || (r.campaign_id === cid && cur.campaign_id !== cid)) m.set(k, r); }
    return Array.from(m.values());
  }, [exp, cid]);
  const rowKey = useMemo(() => keyer(all), [all]);
  const wanted = keyList ? keyList.split(',').filter(Boolean) : all.map(rowKey);
  const picked = wanted.map((k) => all.find((r) => rowKey(r) === k)).filter((r): r is ResultRow => !!r);
  const shown = picked.length ? picked : all;
  const setPicked = (keys: string[]) => go(methodsRoute(cid, keys));
  const toggle = (k: string) => setPicked(wanted.includes(k) ? wanted.filter((x) => x !== k) : [...wanted, k]);
  const setRef = (k: string) => setPicked([k, ...wanted.filter((x) => x !== k)]);
  // labelled ML evaluation of the learned methods (asked once per row; never derived here)
  const { mlOf, reload } = useMlEvaluations(all);
  const sides: (Side & { name: string })[] = shown.map((r, i) => ({ label: letter(i), e: exp, rows: new Map([[ME, r]]), name: r.name }));
  const nScen = exp?.scenarios.length ?? 0;
  const names = (k: number) => scenarioLabel(exp?.scenarios[k], k);
  const cell = (r: ResultRow) => cellOf(r, scope, exp, exp);
  const ctx: Ctx = { ref: shown[0] ? cell(shown[0]) : null, refRow: shown[0] ?? null, ml: mlOf };
  const val = (d: MetricDef, r: ResultRow) => { const c = cell(r); return c ? d.get(c, r, scope, ctx) ?? null : null; };
  const whyNot = (d: MetricDef, r: ResultRow) => d.why?.(r, scope, ctx) ?? null;
  // a metric nobody can show for this problem: the reason, for the chooser
  const unavailable = (d: MetricDef) => mc.unavailable(d, all, ctx);
  const study = exp?.view?.mode === 'study' ? exp.view.study : null;
  const mixed = new Set(shown.map((r) => r.campaign_id)).size > 1;
  const csv = () => {
    const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
    // an exported table is in English whatever the interface language
    const nameEn = (k: number) => scenarioLabel(exp?.scenarios[k], k, plain);
    const en = new Map(metricDefs(exp, customs, { nScen, reps: exp?.campaign.repetitions ?? 1, riders: (k) => servedOf(exp, k), population, names: nameEn }, plain).map((d) => [d.id, d]));
    const head = ['group', 'metric', 'unit', 'aggregation', ...shown.flatMap((r, i) => [`${letter(i)} ${r.name}`, ...(i > 0 ? [`${letter(i)}-A`] : [])])];
    const lines = visible.map((d) => { const e = en.get(d.id) ?? d; return [q(d.group), q(e.label), q(e.unit), q(e.basis(scope)), ...shown.flatMap((r, i) => { const v = val(d, r), a = val(d, shown[0]); const c = cell(r);
      // a number where there is one; else the recorded text; else the reason there is no value (never an empty zero)
      const shownValue = v != null ? v : e.text && c ? q(e.text(c, r)) : q(missingWord(e.why?.(r, scope, ctx)).replace('—', ''));
      return [shownValue, ...(i > 0 ? [v != null && a != null ? v - a : ''] : [])]; })].join(','); });
    const legend = [`# ${study ? `study: ${study.title}` : `methods of one experiment: ${exp?.campaign.title ?? ''}`} [${cid}]; scope: ${scope === 'all' ? `all ${nScen} scenarios` : nameEn(scope)}; reference A: ${shown[0]?.name ?? ''}`,
      ...shown.map((r, i) => `# ${letter(i)}: ${r.name} — experiment: ${r.experiment ?? exp?.campaign.title ?? ''} [${r.campaign_id}] — ${r.origin}`)];
    const blob = new Blob([[...legend, head.join(','), ...lines].join('\n') + '\n'], { type: 'text/csv' });
    const x = document.createElement('a'); x.href = URL.createObjectURL(blob); x.download = 'move_openlab_methods.csv'; x.click();
  };
  const hash = scope === 'all' ? exp?.scenarios[0]?.instance_hash ?? '' : exp?.scenarios[scope]?.instance_hash ?? '';
  const cols = 1 + shown.length * 2 - 1;
  return <div className="ab">
    <div className="cmp-head">
      <div className="row gap wrap"><button className="btn ghost icon" aria-label={tr('back to the workspace')} onClick={back}><ChevronLeft size={17} /></button>
        <h2 className="cmp-title">{tr('Compare')}</h2><CompareTabs active="methods" onExperiments={onExperiments ? () => onExperiments(cid) : undefined} />
        <span className="muted ellipsis">{study ? study.title : exp?.campaign.title ?? '…'}</span>
        <span className="grow" />
        {shown.length > 1 && <label className="row small gap" title={tr('Differences are other − reference. The reference is the comparison baseline you choose; it is not necessarily a proven optimum.')}>{tr('Reference')}
          <select aria-label={tr('reference method')} value={rowKey(shown[0])} onChange={(e) => setRef(e.target.value)}>
            {shown.map((r, i) => <option key={rowKey(r)} value={rowKey(r)}>{letter(i)} · {r.name}</option>)}</select></label>}
        <button className="btn" onClick={mc.open} disabled={!exp?.results}><ListChecks size={14} /> {tr('Choose metrics')}</button>
        <button className="btn" onClick={csv} disabled={!shown.length}><Download size={14} /> {tr('Export table')}</button></div>
      {exp?.view && exp.view.studies.length > 0 && <div className="row gap wrap small view-switch" role="group" aria-label={tr('which results are shown')}>
        <div className="seg"><button className={!records ? 'on' : ''} aria-pressed={!records} onClick={() => { setRecords(false); go(methodsRoute(cid)); }}>{exp.view.study?.title ?? exp.view.studies[0].title}</button>
          <button className={records ? 'on' : ''} aria-pressed={records} onClick={() => { setRecords(true); go(methodsRoute(cid)); }} title={tr('Every record of this experiment and of the experiments it extends, including earlier policies and pilots')}>{tr('History · all records of this experiment')}</button></div>
        {study && <span className="muted">{tr('{n} methods from {m} locked experiments on the same {s} scenarios; no record is merged or changed.', { n: study.members.length, m: new Set(study.members.map((x) => x.campaign_id)).size, s: nScen })}</span>}</div>}
      <div className="row gap wrap method-picks" role="group" aria-label={tr('methods to display')}>
        {all.map((r) => { const i = shown.indexOf(r); const on = picked.length ? i >= 0 : true;
          return <label key={rowKey(r)} className={`cmpchip ${i === 0 ? 'ref' : ''}`} title={`${r.experiment ?? ''} · ${tr(r.origin)}`}><input type="checkbox" checked={on} aria-label={r.name} onChange={() => toggle(rowKey(r))} />
            {on && <span className="badge" style={{ background: SERIES[i % SERIES.length], color: '#fff' }}>{letter(i)}</span>}<span className="ellipsis">{r.name}</span>
            {r.note && <span className="badge outline">{r.note}</span>}
            {i === 0 && <span className="badge outline">{tr('Reference')}</span>}</label>; })}
        <span className="small muted">{tr('{n} displayed · same {s} frozen scenarios, constraints, objective and validator', { n: shown.length, s: nScen })}</span></div>
      <div className="evstrip row gap wrap" aria-label={tr('validation')}><span className="badge ok"><ShieldCheck size={12} /> {exp ? tr('Validated {a}/{n} runs', { a: shown.reduce((s, r) => s + Object.values(r.per_scenario).reduce((x, c) => x + c.accepted, 0), 0), n: shown.reduce((s, r) => s + Object.values(r.per_scenario).reduce((x, c) => x + c.repetitions, 0), 0) }) : '…'}</span>
        <span className="small muted">{tr('every solution checked by validator {v}, not by the method', { v: exp?.validation.validator_version ?? '' })}</span></div>
      <div className="row gap tabsrow"><nav className="tabs" aria-label={tr('method comparison views')}>{([['results', 'Results'], ['charts', 'Charts'], ['maps', 'Maps'], ['ml', 'ML evaluation']] as [Tab, string][]).map(([x, label]) =>
        <button key={x} className={tab === x ? 'on' : ''} aria-pressed={tab === x} onClick={() => { setTab(x); if (x === 'maps' && scope === 'all') setScope(0); }}>{tr(label)}</button>)}</nav>
        <span className="grow" />
        {(tab === 'results' || tab === 'maps') && exp && nScen > 1 && <ScenarioNav scenarios={exp.scenarios} value={scope} onChange={setScope} allowAll={tab === 'results'} />}</div>
    </div>
    {err && <div className="lab-notes"><ErrorNote text={err} /></div>}
    <div className={`cmp-body ${tab === 'maps' ? 'maps' : ''}`}>
      {exp && !exp.results && <p className="muted">{tr('Run the experiment to compare its methods.')}</p>}
      {exp && exp.results && all.length < 2 && <p className="muted">{tr('This experiment has one method. Add a method and run it on the same scenarios to compare, or open the Experiments tab.')}</p>}
      {exp?.results && shown.length > 0 && tab === 'results' && <>
        <p className="small scope-line" role="status"><Info size={13} /> {scope === 'all'
          ? tr('All {n} scenarios: every value is an aggregate over the {n} scenarios (hover a metric for how it is aggregated).', { n: nScen })
          : tr('One scenario: {s}. Values of this scenario only{r}.', { s: exp.scenarios[scope]?.name ?? names(scope), r: (exp.campaign.repetitions ?? 1) > 1 ? tr(' (repetition 1; runtime = median of {n} repetitions of this scenario)', { n: exp.campaign.repetitions }) : '' })}</p>
        <div className="card table-card"><table className="compact cmp-table" aria-label={tr('methods compared')}>
        <thead><tr><th>{tr('Metric')}</th>{shown.map((r, i) => [<th key={rowKey(r)} className={`n ${i === 0 ? 'grp-l' : ''}`} title={`${r.experiment ?? ''} · ${tr(r.origin)}`}><span className="dot" style={{ background: SERIES[i % SERIES.length] }} /> {letter(i)} · {r.name}</th>,
          ...(i > 0 ? [<th key={`${rowKey(r)}d`} className="n muted">{letter(i)} − A</th>] : [])])}</tr></thead>
        <tbody>
          <tr className="grp"><td colSpan={cols}>{tr('Validation')}</td></tr>
          <tr><td title={tr('What each result proves. A solver proves optimality only for the model it was given: after a learned reduction, "optimal" means optimal on the reduced model.')}>{tr('Status')}</td>
            {shown.map((r, i) => [<td key={rowKey(r)} className={`n ${i === 0 ? 'grp-l' : ''}`}>{scope === 'all' ? statusText(statusOf(r).label) : cell(r) ? tr(r.per_scenario[exp.scenarios[scope].instance_hash]?.optimality ?? '—') : '—'}{r.repetitions_consistent ? '' : ` · ${tr('repetitions differ')}`}</td>, ...(i > 0 ? [<td key={`${rowKey(r)}d`} className="n muted">—</td>] : [])])}</tr>
          <tr><td title={tr('The experiment each column comes from and how its results were obtained')}>{tr('Source')}</td>
            {shown.map((r, i) => [<td key={rowKey(r)} className={`n small ${i === 0 ? 'grp-l' : ''}`} title={tr(r.origin)}>{r.experiment ?? exp.campaign.title}<span className="tiny muted block">{/imported results/.test(r.origin) ? tr('imported results, re-validated here') : tr(r.origin)}</span></td>, ...(i > 0 ? [<td key={`${rowKey(r)}d`} className="n muted">—</td>] : [])])}</tr>
          {GROUPS.map(([g, label]) => { const list = visible.filter((d) => d.group === g); if (!list.length) return null;
            return [g === 'validation' ? null : <tr key={g} className="grp"><td colSpan={cols}>{tr(label)}</td></tr>,
              ...list.map((d) => { const vals = shown.map((r) => (d.text ? null : val(d, r)));
                // nothing to show in this scope (e.g. a per-scenario figure over all scenarios): no row of dashes; a metric
                // the problem cannot provide keeps its row, with the reason
                if (!d.text && vals.every((v) => v == null) && !shown.some((r) => /not configured|not available|not applicable|needed|not computed/i.test(whyNot(d, r) ?? ''))) return null;
                if (d.text && shown.every((r) => { const c = cell(r); return !c || d.text!(c, r) === '—'; })) return null;
                return <tr key={d.id}><td title={[d.help, `${tr('Aggregation')}: ${d.basis(scope)}`].filter(Boolean).join('\n')}><span className="metric-name">{d.label}</span></td>
                  {shown.map((r, i) => { const v = vals[i], a = vals[0]; const c = cell(r); const why = v == null && !d.text ? whyNot(d, r) : null;
                    return [<td key={rowKey(r)} className={`n ${i === 0 ? 'grp-l' : ''}`}>{d.text ? (c ? d.text(c, r) : '—') : v == null ? <span className="muted na" title={why ? tr(why) : tr('No value recorded')}>{why && !/reference/i.test(why) ? tr(missingWord(why)) : '—'}</span> : d.fmt(v)}</td>,
                      ...(i > 0 ? [<td key={`${rowKey(r)}d`} className="n muted">{(d.text && d.id !== 'validated') || v == null || a == null ? '—' : `${v - a >= 0 ? '+' : ''}${num(v - a, Math.abs(v - a) < 10 ? 2 : 0)}`}</td>] : [])]; })}</tr>; })]; })}
        </tbody></table></div>
        {scope !== 'all' && (exp.scenarios[scope]?.notes ?? []).map((n) => <p key={n} className="small warn-text" role="note">{n}</p>)}
        {visible.filter((d) => d.caveat).map((d) => <p key={d.id} className="small warn-text" role="note"><b>{d.label}</b>: {d.caveat}</p>)}
        {scope === 'all' && visible.some((d) => d.why?.(shown[0], 'all', ctx) && /per scenario/i.test(d.why(shown[0], 'all', ctx) ?? '')) && <p className="small muted">{tr('Some chosen metrics are recorded per scenario only (e.g. solver termination, proven optimality gap): choose one scenario to see them.')}</p>}
        <details className="small terms"><summary>{tr('How to read Reference, differences and Basis')}</summary>
          <ul className="plain muted">
            <li><b>{tr('Reference')}</b>: {tr('the comparison baseline (column A). It is the method the others are measured against, not necessarily a proven optimum.')}{shown[0] ? ` ${tr('Here: {m}, {s}.', { m: shown[0].name, s: statusText(statusOf(shown[0]).label).toLowerCase() })}` : ''}</li>
            <li><b>{tr('Objective difference vs reference')}</b>: {tr('relative difference of the objective against the reference. Negative does not prove superiority over an exact optimum: where the reference stopped at its time limit it only means a better incumbent was found.')}</li>
            <li><b>{tr('Proven optimality gap')}</b>: {tr('the solver’s own gap between its incumbent and its bound, for one run. It is shown per scenario only and is a different quantity.')}</li>
            <li><b>{tr('Basis')}</b>: {tr('how a value is aggregated over scenarios (sum, mean, median, ratio of sums). It is shown when you hover a metric; it is not a metric.')}</li>
            <li>{tr('Differences are other − A. Values of repetition 1{c}; runtime uses every run.', { c: exp.results.rows.every((x) => x.repetitions_consistent) ? tr(' (identical in every repetition)') : '' })}{mixed ? ` ${tr('Columns come from different experiments on the same frozen scenarios: results compare directly, runtimes compare with conditions (separate runs, possibly another environment).')}` : ''}</li></ul></details></>}
      {exp?.results && shown.length > 0 && tab === 'charts' && <CompareCharts sides={sides} colors={sides.map((_, i) => SERIES[i % SERIES.length])} methodIds={[ME]} cands={[]} customs={customs} methodSides chosen={chosen} mlOf={mlOf} population={population} onChoose={mc.open} />}
      {exp?.results && tab === 'maps' && <MethodMaps exp={exp} rows={shown} hash={hash} setErr={setErr} />}
      {exp?.results && tab === 'ml' && <MlEvaluationView rows={shown} evals={mlOf} population={population} setPopulation={setPopulation} reload={reload} />}
      {!exp && !err && <p className="muted small">{tr('Loading…')}</p>}
    </div>
    {mc.choosing && <MetricChooser defs={defs} chosen={chosen} onApply={mc.apply} onClose={mc.close} unavailable={unavailable} remembered={mc.remembered} />}
  </div>;
}
