import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Download, ShieldCheck } from 'lucide-react';
import { ErrorNote, errText, num } from '../components/common';
import { BASELINE_LABEL, SCOPE_LABEL } from '../mobility/api';
import { lab, type Experiment, type ResultRow } from './api';
import { CompareCharts, type CustomMetric } from './CompareCharts';
import { cellOf, type Cell, type Side } from './compareData';
import { runtime } from './ResultPanel';
import { statusOf } from './ComparePanel';

const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', '#9085e9', '#e87ba4'];
const letter = (i: number) => String.fromCharCode(65 + i);
const ME = '*';                                   // the single row key of a method side

/** Route argument `<experiment>` or `<experiment>|<method key>,<method key>…` (method key = method_id@version). */
export const methodsRoute = (cid: string, keys: string[] = []) => (keys.length ? `${cid}|${keys.join(',')}` : cid);
const rowKey = (r: ResultRow) => `${r.method_id}@${r.version}`;

/** Methods of ONE frozen experiment compared with each other: same scenarios, constraints, objective, validator and
 *  metrics, so no other experiment is needed. Rows that the experiment shows from its lineage (an extension shows the
 *  methods of the experiment it extends) were run on the same frozen scenarios. The first selected method is the
 *  reference of the deltas. */
export function CompareMethods({ arg, go, back }: { arg: string; go: (route: string) => void; back: () => void }) {
  const [cid, keyList] = arg.split('|');
  const [exp, setExp] = useState<Experiment | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'results' | 'charts'>('results');
  const [scope, setScope] = useState<number | 'all'>('all');
  const [customs, setCustoms] = useState<CustomMetric[]>([]);
  useEffect(() => { lab.experiment(cid).then(setExp).catch((e) => setErr(errText(e))); }, [cid]);
  useEffect(() => { if (exp) fetch(`/api/lab/metrics?problem_id=${encodeURIComponent(exp.campaign.problem_id)}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setCustoms(d.metrics)).catch(() => { /* optional */ }); }, [exp]);
  // one row per method (the experiment's own row first, else the lineage row it shows)
  const all = useMemo(() => {
    const m = new Map<string, ResultRow>();
    for (const r of exp?.results?.rows ?? []) { const k = rowKey(r); const cur = m.get(k); if (!cur || (r.campaign_id === cid && cur.campaign_id !== cid)) m.set(k, r); }
    return Array.from(m.values());
  }, [exp, cid]);
  const wanted = keyList ? keyList.split(',').filter(Boolean) : all.map(rowKey);
  const picked = wanted.map((k) => all.find((r) => rowKey(r) === k)).filter((r): r is ResultRow => !!r);
  const setPicked = (keys: string[]) => go(methodsRoute(cid, keys));
  const toggle = (k: string) => setPicked(wanted.includes(k) ? wanted.filter((x) => x !== k) : [...wanted, k]);
  const setRef = (k: string) => setPicked([k, ...wanted.filter((x) => x !== k)]);
  const sides: (Side & { name: string })[] = picked.map((r, i) => ({ label: letter(i), e: exp, rows: new Map([[ME, r]]), name: r.name }));
  const nScen = exp?.scenarios.length ?? 0;
  const objective = exp?.problem.objective ?? [];
  const mdef = (id: string) => exp?.problem.metrics.find((m) => m.id === id);
  const riders = scope === 'all' ? (exp?.scenarios.reduce((s, x) => s + (x.riders ?? 0), 0) ?? null) : exp?.scenarios[scope]?.riders ?? null;
  const cell = (r: ResultRow) => cellOf(r, scope, exp, exp);
  const word = scope === 'all' ? `sum · ${nScen} scenarios` : `sample ${scope + 1}`;
  type RowDef = { group?: string; label: string; basis: string; get: (c: Cell, r: ResultRow) => number | null | undefined; fmt: (v: number) => string; text?: (r: ResultRow) => string };
  const emis = exp?.campaign.emissions;
  const defs: RowDef[] = [
    { group: 'Validation', label: 'Status', basis: 'independent validator', get: () => null, fmt: String, text: (r) => `${statusOf(r).label}${r.repetitions_consistent ? '' : ' · repetitions differ'}` },
    { group: 'Matching', label: 'Served riders', basis: word, get: (c) => c.obj.served, fmt: (v) => `${num(v)}${riders ? ` / ${riders}` : ''}` },
    ...objective.filter((o) => o.metric !== 'served').map((o) => ({ label: mdef(o.metric)?.label ?? o.metric, basis: word, get: (c: Cell) => c.obj[o.metric], fmt: (v: number) => (mdef(o.metric)?.unit === 's' ? `${num(v / 60, 1)} min` : num(v)) })),
    { group: 'Performance', label: 'Runtime', basis: scope === 'all' ? 'median of scenario medians' : `median · ${exp?.campaign.repetitions ?? '—'} runs`, get: (c) => c.time, fmt: (v) => runtime(v) },
    { label: 'Solver time', basis: 'median', get: (_c, r) => (scope === 'all' ? r.solver_time_s : null), fmt: (v) => runtime(v) },
    { label: 'Gap to the exact reference', basis: scope === 'all' ? 'mean over scenarios' : 'this scenario', get: (c) => c.gap, fmt: (v) => `${num(v, 2)} %` },
    { group: `CO₂ · ${emis ? `${SCOPE_LABEL[emis.scope] ?? emis.scope} · vs ${(BASELINE_LABEL[emis.baseline] ?? emis.baseline).toLowerCase()}` : 'not configured'}`, label: 'Emissions', basis: word, get: (c) => (c.dom?.complete ? c.dom.solution_g ?? null : null), fmt: (v) => `${num(v / 1000, 1)} kg` },
    { label: 'Avoided', basis: scope === 'all' ? 'ratio of sums' : 'this scenario', get: (c) => (c.dom?.complete ? c.dom.avoided_pct ?? null : null), fmt: (v) => `${num(v, 1)} %` },
    { label: 'Per served rider', basis: scope === 'all' ? 'ratio of sums' : 'this scenario', get: (c) => (c.dom?.complete ? c.dom.per_served_request_g ?? null : null), fmt: (v) => `${num(v / 1000, 2)} kg` },
    { group: 'Fleet', label: 'Vehicles used', basis: word, get: (c) => c.dom?.vehicles_used, fmt: (v) => num(v) },
    { label: 'Vehicle distance', basis: word, get: (c) => c.dom?.vehicle_km, fmt: (v) => `${num(v, 1)} km` },
    ...customs.map((x, i) => ({ group: i === 0 ? 'Custom metrics' : undefined, label: x.name, basis: scope === 'all' ? `${x.aggregate.replace(/-/g, ' ')} over scenarios` : 'this scenario', get: (c: Cell) => c.custom[x.id] ?? null, fmt: (v: number) => `${num(v, 3)} ${x.unit}` })),
  ];
  const val = (d: RowDef, r: ResultRow) => { const c = cell(r); return c ? d.get(c, r) ?? null : null; };
  const lineage = new Set(picked.map((r) => r.campaign_id)).size > 1;
  const csv = () => {
    const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
    const head = ['metric', 'basis', ...picked.flatMap((r, i) => [`${letter(i)} ${r.name}`, ...(i > 0 ? [`${letter(i)}-A`] : [])])];
    const lines = defs.filter((d) => !d.text).map((d) => [q(d.label), q(d.basis), ...picked.flatMap((r, i) => { const v = val(d, r), a = val(d, picked[0]); return [v ?? '', ...(i > 0 ? [v != null && a != null ? v - a : ''] : [])]; })].join(','));
    const legend = [`# methods of one experiment: ${exp?.campaign.title ?? ''} [${cid}]; reference A: ${picked[0]?.name ?? ''}`];
    const blob = new Blob([[...legend, head.join(','), ...lines].join('\n') + '\n'], { type: 'text/csv' });
    const x = document.createElement('a'); x.href = URL.createObjectURL(blob); x.download = 'move_openlab_methods.csv'; x.click();
  };
  return <div className="ab">
    <div className="cmp-head">
      <div className="row gap wrap"><button className="btn ghost icon" aria-label="back to the workspace" onClick={back}><ChevronLeft size={17} /></button>
        <h2 className="cmp-title">Compare methods</h2><span className="muted ellipsis">{exp?.campaign.title ?? '…'}</span>
        <span className="grow" />
        {picked.length > 1 && <label className="row small gap" title="Deltas are other − reference">Reference
          <select aria-label="reference method" value={rowKey(picked[0])} onChange={(e) => setRef(e.target.value)}>
            {picked.map((r, i) => <option key={rowKey(r)} value={rowKey(r)}>{letter(i)} · {r.name}</option>)}</select></label>}
        <button className="btn" onClick={csv} disabled={!picked.length}><Download size={14} /> Export table</button></div>
      <div className="row gap wrap method-picks" role="group" aria-label="methods to compare">
        {all.map((r) => { const i = picked.indexOf(r); const on = i >= 0;
          return <label key={rowKey(r)} className={`cmpchip ${i === 0 ? 'ref' : ''}`}><input type="checkbox" checked={on} aria-label={r.name} onChange={() => toggle(rowKey(r))} />
            {on && <span className="badge" style={{ background: SERIES[i % SERIES.length], color: '#fff' }}>{letter(i)}</span>}<span className="ellipsis">{r.name}</span>
            {i === 0 && <span className="badge outline">Reference</span>}</label>; })}
        <span className="small muted">{picked.length} selected · same {nScen} frozen scenario{nScen === 1 ? '' : 's'}, constraints, objective and validator</span></div>
      <div className="evstrip row gap wrap" aria-label="validation"><span className="badge ok"><ShieldCheck size={12} /> {exp ? `Validated ${exp.validation.accepted}/${exp.validation.runs} runs` : '…'}</span>
        <span className="small muted">every solution checked by validator {exp?.validation.validator_version ?? ''}, not by the method</span></div>
      <div className="row gap tabsrow"><nav className="tabs" aria-label="method comparison views">{(['results', 'charts'] as const).map((x) => <button key={x} className={tab === x ? 'on' : ''} aria-pressed={tab === x} onClick={() => setTab(x)}>{x === 'results' ? 'Results' : 'Charts'}</button>)}</nav>
        <span className="grow" />
        {tab === 'results' && nScen > 1 && <div className="seg" role="group" aria-label="scope"><button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All {nScen} scenarios</button>
          {Array.from({ length: nScen }, (_, i) => <button key={i} className={scope === i ? 'on' : ''} onClick={() => setScope(i)}>Sample {i + 1}</button>)}</div>}</div>
    </div>
    {err && <div className="lab-notes"><ErrorNote text={err} /></div>}
    <div className="cmp-body">
      {exp && !exp.results && <p className="muted">Run the experiment to compare its methods.</p>}
      {exp && exp.results && all.length < 2 && <p className="muted">This experiment has one method. Add a method and run it on the same scenarios to compare.</p>}
      {exp?.results && picked.length > 0 && tab === 'results' && <><div className="card table-card"><table className="compact cmp-table" aria-label="methods compared">
        <thead><tr><th>Metric</th><th>Basis</th>{picked.map((r, i) => [<th key={rowKey(r)} className={`n ${i === 0 ? 'grp-l' : ''}`}><span className="dot" style={{ background: SERIES[i % SERIES.length] }} /> {letter(i)} · {r.name}</th>,
          ...(i > 0 ? [<th key={`${rowKey(r)}d`} className="n muted">{letter(i)} − A</th>] : [])])}</tr></thead>
        <tbody>{defs.map((d) => { const rowVals = picked.map((r) => (d.text ? null : val(d, r))); if (!d.text && rowVals.every((v) => v == null)) return null;
          return [d.group ? <tr key={`g${d.label}`} className="grp"><td colSpan={2 + picked.length * 2 - 1}>{d.group}</td></tr> : null,
            <tr key={d.label}><td>{d.label}</td><td className="small muted">{d.basis}</td>{picked.map((r, i) => { const v = rowVals[i], a = rowVals[0];
              return [<td key={rowKey(r)} className={`n ${i === 0 ? 'grp-l' : ''}`}>{d.text ? d.text(r) : v == null ? <span className="muted">—</span> : d.fmt(v)}</td>,
                ...(i > 0 ? [<td key={`${rowKey(r)}d`} className="n muted">{d.text || v == null || a == null ? '—' : `${v - a >= 0 ? '+' : ''}${num(v - a, Math.abs(v - a) < 10 ? 2 : 0)}`}</td>] : [])]; })}</tr>]; })}</tbody></table></div>
        <p className="small muted">Deltas against A ({picked[0].name}). Values from repetition 1{exp.results.rows.every((x) => x.repetitions_consistent) ? ' (identical in every repetition)' : ''}; runtime uses every run.
          {lineage ? ' Some methods were run in the experiment this one extends: same frozen scenarios, separate runs, so runtimes compare with conditions.' : ''}</p></>}
      {exp?.results && picked.length > 0 && tab === 'charts' && <CompareCharts sides={sides} colors={sides.map((_, i) => SERIES[i % SERIES.length])} methodIds={[ME]} cands={[]} customs={customs} methodSides />}
      {!exp && !err && <p className="muted small">Loading…</p>}
    </div>
  </div>;
}
