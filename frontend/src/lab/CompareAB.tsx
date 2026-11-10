import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronUp, Download, Pause, Play, Plus, RotateCcw, Scale, ShieldCheck } from 'lucide-react';
import type { Json } from '../api/client';
import { ErrorNote, errText, num } from '../components/common';
import { LeafletMap, type MapView } from '../geo/LeafletMap';
import { geo, hhmm, hhmmss, type GeoConfig } from '../geo/api';
import { t } from '../i18n';
import { BASELINE_LABEL, SCOPE_LABEL, mob, sameEmissionSemantics, type Diff } from '../mobility/api';
import { VERDICT, lab, type Experiment, type ResultRow, type Verdict } from './api';
import { ComparePicker, type Candidate } from './ComparePicker';
import { fromRoute, letter, ordered, setReference, toRoute } from './compareSelection';
import { CompareCharts, type CustomMetric } from './CompareCharts';
import { planLayers, planPositions } from './layers';
import { useReplay } from './ReplayBar';
import { runtime } from './ResultPanel';
import { byMethod, cellOf, type Cell } from './compareData';

const SUMMARY_KEY = 'move-openlab.compare-summary';   // collapsed / open, remembered on this browser

type Tab = 'results' | 'charts' | 'maps' | 'replay' | 'diff';
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', '#9085e9', '#e87ba4'];

/** The comparison workspace: experiment A against one or several Bs (`#/compare/A|B1,B2`). The three kinds of evidence
 *  stay apart (validation, reproducibility, semantic comparability). Results: a method-grouped table with the basis of
 *  every value and a scope (all scenarios or one); Charts with CSV/PNG/SVG export; synchronised maps and replay; Diff
 *  scenario by scenario (definition, assignments, served riders, routes, vehicles, CO₂ where comparable). */
export function CompareAB({ arg, go, back }: { arg: string; go: (route: string) => void; back: () => void }) {
  // exactly the experiments of the route, the reference first (column A); nothing is added
  const sel = useMemo(() => fromRoute(arg), [arg]);
  const a = sel.reference;
  const bs = useMemo(() => ordered(sel).slice(1), [sel]);
  const [bi, setBi] = useState(0);
  const b = bs[Math.min(bi, Math.max(0, bs.length - 1))] ?? '';
  const [cfg, setCfg] = useState<GeoConfig | null>(null);
  const [ea, setEa] = useState<Experiment | null>(null);
  const [ebs, setEbs] = useState<(Experiment | null)[]>([]);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('results');
  const [scope, setScope] = useState<number | 'all'>('all');
  const [ma, setMa] = useState<string | undefined>(); const [mb, setMb] = useState<string | undefined>();
  const [row, setRow] = useState(0);
  const [plans, setPlans] = useState<{ a: Json | null; b: Json | null }>({ a: null, b: null });
  const [insts, setInsts] = useState<{ a: Json | null; b: Json | null }>({ a: null, b: null });
  const [sync, setSync] = useState(true);
  const [view, setView] = useState<MapView | null>(null);
  const [playing, setPlaying] = useState(false);
  const [why, setWhy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(SUMMARY_KEY) === 'collapsed'; } catch { return false; } });
  const [adding, setAdding] = useState(false);
  const [customs, setCustoms] = useState<CustomMetric[]>([]);
  useEffect(() => { geo.config().then(setCfg).catch((e) => setErr(errText(e))); }, []);
  useEffect(() => { if (ea) fetch(`/api/lab/metrics?problem_id=${encodeURIComponent(ea.campaign.problem_id)}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setCustoms(d.metrics)).catch(() => { /* optional */ }); }, [ea]);
  useEffect(() => { lab.experiment(a).then(setEa).catch((e) => setErr(errText(e))); }, [a]);
  useEffect(() => { Promise.all(bs.map((x) => lab.experiment(x).catch(() => null))).then(setEbs); }, [bs]);
  useEffect(() => { fetch(`/api/lab/compatible?a=${encodeURIComponent(a)}`, { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null).then((d) => d && setCands(d.candidates)).catch(() => { /* optional */ }); }, [a]);
  useEffect(() => {
    if (!a || !b) return;
    let live = true;
    setDiff(null); setRow(0);
    mob.diff(a, b, ma, mb).then((d) => live && setDiff(d)).catch((e) => live && setErr(errText(e)));
    return () => { live = false; };
  }, [a, b, ma, mb]);
  const r = diff?.rows[row];
  useEffect(() => {
    let live = true;
    setPlans({ a: null, b: null }); setInsts({ a: null, b: null });
    if (!r || !diff) return;
    const load = (cid: string, run: string | null) => run ? geo.playback(cid, run).catch(() => null) : Promise.resolve(null);
    Promise.all([load(diff.a.campaign_id, r.run_a), load(diff.b.campaign_id, r.run_b), geo.instance(r.instance_hash).catch(() => null), geo.instance(r.instance_hash_b).catch(() => null)])
      .then(([pa, pb, ia, ib]) => { if (live) { setPlans({ a: pa, b: pb }); setInsts({ a: ia, b: ib }); } });
    return () => { live = false; };
  }, [diff, r]);
  const merged = useMemo(() => plans.a || plans.b ? { t_min: Math.min(...[plans.a, plans.b].filter(Boolean).map((p) => p!.t_min)), t_max: Math.max(...[plans.a, plans.b].filter(Boolean).map((p) => p!.t_max)) } : null, [plans]);
  const replay = useReplay(merged, tab === 'replay' && playing);
  const la = useMemo(() => (plans.a ? planLayers(plans.a) : { points: [], lines: [] }), [plans.a]);
  const lb = useMemo(() => (plans.b ? planLayers(plans.b) : { points: [], lines: [] }), [plans.b]);
  const eb = ebs[Math.min(bi, ebs.length - 1)] ?? null;
  const cand = cands.find((c) => c.campaign_id === b);
  const candOf = (id: string) => cands.find((c) => c.campaign_id === id);
  const bLabel = (i: number) => letter(i + 1);
  if (!cfg) return <ErrorNote text={err} />;

  // ---------------- results table
  const sides: { label: string; e: Experiment | null; rows: Map<string, ResultRow> }[] = [{ label: 'A', e: ea, rows: byMethod(ea) }, ...bs.map((_, i) => ({ label: bLabel(i), e: ebs[i] ?? null, rows: byMethod(ebs[i] ?? null) }))];
  const methodIds = Array.from(new Set(sides.flatMap((s) => Array.from(s.rows.keys()))));
  const nScen = ea?.scenarios.length ?? 0;
  const riders = (e: Experiment | null) => (scope === 'all' ? (e?.scenarios.reduce((s, x) => s + (x.riders ?? 0), 0) ?? null) : e?.scenarios[scope]?.riders ?? null);
  const objective = ea?.problem.objective ?? [];
  const mdef = (id: string) => ea?.problem.metrics.find((m) => m.id === id);
  const co2Ok = (i: number) => !!sides[i].e && (i === 0 || (cands.find((c) => c.campaign_id === sides[i].e!.campaign.campaign_id)?.emissions ?? 'direct') !== 'incompatible');
  type RowDef = { group?: string; label: string; basis: string; get: (c: Cell, e: Experiment | null) => number | null | undefined; fmt: (v: number) => string; co2?: boolean };
  const scopeWord = scope === 'all' ? `sum · ${nScen} scenarios` : `sample ${scope + 1}`;
  const defs: RowDef[] = [
    { group: 'Matching', label: 'Served riders', basis: scopeWord, get: (c) => c.obj.served, fmt: (v) => num(v) },
    ...objective.filter((o) => o.metric !== 'served').map((o) => ({ label: mdef(o.metric)?.label ?? o.metric, basis: scopeWord, get: (c: Cell) => c.obj[o.metric], fmt: (v: number) => (mdef(o.metric)?.unit === 's' ? `${num(v / 60, 1)} min` : num(v)) })),
    { group: 'Performance', label: 'Runtime', basis: scope === 'all' ? 'median of scenario medians' : `median · ${ea?.campaign.repetitions ?? '—'} runs`, get: (c) => c.time, fmt: (v) => runtime(v) },
    { label: 'Gap to the exact reference', basis: scope === 'all' ? 'mean over scenarios' : 'this scenario', get: (c) => c.gap, fmt: (v) => `${num(v, 2)} %` },
    { group: `CO₂ · ${ea?.campaign.emissions ? `${SCOPE_LABEL[ea.campaign.emissions.scope] ?? ea.campaign.emissions.scope} · vs ${(BASELINE_LABEL[ea.campaign.emissions.baseline] ?? ea.campaign.emissions.baseline).toLowerCase()}` : 'not configured'}`, label: 'Emissions', basis: scopeWord, co2: true, get: (c) => (c.dom?.complete ? (c.dom.solution_g ?? null) : null), fmt: (v) => `${num(v / 1000, 1)} kg` },
    { label: 'Avoided', basis: scope === 'all' ? 'ratio of sums' : 'this scenario', co2: true, get: (c) => (c.dom?.complete ? (c.dom.avoided_pct ?? null) : null), fmt: (v) => `${num(v, 1)} %` },
    { label: 'Per served rider', basis: scope === 'all' ? 'ratio of sums' : 'this scenario', co2: true, get: (c) => (c.dom?.complete ? (c.dom.per_served_request_g ?? null) : null), fmt: (v) => `${num(v / 1000, 2)} kg` },
    { group: 'Fleet', label: 'Vehicles used', basis: scopeWord, get: (c) => c.dom?.vehicles_used, fmt: (v) => num(v) },
    { label: 'Vehicle distance', basis: scopeWord, get: (c) => c.dom?.vehicle_km, fmt: (v) => `${num(v, 1)} km` }];
  const csvTable = () => {
    // exactly the compared experiments: one value column per experiment and method, and the delta to the reference A
    const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
    const head = ['metric', 'basis', ...methodIds.flatMap((m) => sides.flatMap((s, i) => [`${m} ${s.label}`, ...(i > 0 ? [`${m} ${s.label}-A`] : [])]))];
    const val = (d: RowDef, m: string, i: number) => { const s = sides[i]; const c = cellOf(s.rows.get(m), scope, s.e); const v = c ? d.get(c, s.e) : null; return d.co2 && !co2Ok(i) ? null : v ?? null; };
    const lines = defs.map((d) => [q(d.label), q(d.basis), ...methodIds.flatMap((m) => sides.flatMap((_, i) => { const v = val(d, m, i), av = val(d, m, 0);
      return [v ?? '', ...(i > 0 ? [v != null && av != null ? v - av : ''] : [])]; }))].join(','));
    const legend = sides.map((s) => `# ${s.label}${s.label === 'A' ? ' (reference)' : ''}: ${s.e?.campaign.title ?? ''} [${s.e?.campaign.campaign_id ?? ''}]`);
    const blob = new Blob([[...legend, head.join(','), ...lines].join('\n') + '\n'], { type: 'text/csv' });
    const x = document.createElement('a'); x.href = URL.createObjectURL(blob); x.download = 'move_openlab_comparison.csv'; x.click();
  };
  const table = <div className="card table-card"><table className="compact cmp-table" aria-label="comparison by method"><thead>
    <tr><th rowSpan={2}>Metric</th><th rowSpan={2}>{t('cmp.basis')}</th>{methodIds.map((m) => <th key={m} colSpan={sides.length + (sides.length > 1 ? sides.length - 1 : 0)} className="center grp-l">{sides.map((s) => s.rows.get(m)?.name).find(Boolean) ?? m}</th>)}</tr>
    <tr>{methodIds.flatMap((m) => sides.flatMap((s, i) => [<th key={`${m}${s.label}`} className={`n ${i === 0 ? 'grp-l' : ''}`}><span className="dot" style={{ background: SERIES[i] }} /> {s.label}</th>,
      ...(i > 0 ? [<th key={`${m}${s.label}d`} className="n">{s.label} − A</th>] : [])]))}</tr></thead>
    <tbody>{defs.map((d) => <FragmentRow key={d.label} d={d} methodIds={methodIds} sides={sides} scope={scope} riders={riders} co2Ok={co2Ok} />)}</tbody></table></div>;

  // ---------------- charts
  const charts = <CompareCharts sides={sides} colors={sides.map((_, i) => SERIES[i % SERIES.length])} methodIds={methodIds} cands={cands} customs={customs} />;

  // ---------------- maps / replay
  const methodSel = (s: 'a' | 'b') => diff && <select aria-label={`method ${s}`} value={(s === 'a' ? diff.a : diff.b).method_id ?? ''} onChange={(e) => (s === 'a' ? setMa : setMb)(e.target.value)} className="small">
    {(s === 'a' ? diff.a : diff.b).methods.map((m) => <option key={m} value={m}>{(s === 'a' ? sides[0] : sides[Math.min(bi, bs.length - 1) + 1])?.rows.get(m)?.name ?? m}</option>)}</select>;
  const scenSel = diff && <label className="row small gap">Scenario <select aria-label="scenario" value={row} onChange={(e) => setRow(Number(e.target.value))}>{diff.rows.map((x, i) => <option key={i} value={i}>Sample {i + 1}{x.same_instance ? '' : ' (derived in B)'}</option>)}</select></label>;
  const maps = <div className="ab-maps">{(['a', 'b'] as const).map((s) => <div key={s} className="ab-map">
    <div className="mapcard ab-title row gap"><span className="badge" style={{ background: s === 'a' ? SERIES[0] : SERIES[Math.min(bi, bs.length - 1) + 1], color: '#fff' }}>{s === 'a' ? 'A' : bLabel(Math.min(bi, bs.length - 1))}</span>
      <b className="small ellipsis">{s === 'a' ? ea?.campaign.title : eb?.campaign.title}</b>{methodSel(s)}</div>
    <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={s === 'a' ? la.points : lb.points} lines={s === 'a' ? la.lines : lb.lines}
      dynamic={tab === 'replay' && (s === 'a' ? plans.a : plans.b) ? planPositions(s === 'a' ? plans.a! : plans.b!, replay.t) : []}
      fitKey={sync ? `ab|${row}|${plans.a ? 1 : 0}` : `${s}|${row}|${(s === 'a' ? plans.a : plans.b)?.run_id ?? ''}`} view={sync ? view : null} onView={sync ? setView : undefined} height="100%" />
  </div>)}</div>;
  const replayBar = merged && <div className="replay-bar row gap" aria-label="synchronised replay">
    <button className="play" onClick={() => { if (replay.t >= merged.t_max) replay.setT(merged.t_min); setPlaying(true); replay.setPlaying(!replay.playing); }} aria-label={replay.playing ? 'pause' : 'play'}>{replay.playing ? <Pause size={15} /> : <Play size={15} />}</button>
    <span className="time tnum">{hhmmss(replay.t || merged.t_min).slice(0, 5)}</span>
    <input type="range" min={merged.t_min} max={merged.t_max} step={1} value={replay.t || merged.t_min} aria-label="time" className="grow" onChange={(e) => { replay.setPlaying(false); replay.setT(Number(e.target.value)); }} />
    <select value={replay.speed} onChange={(e) => replay.setSpeed(Number(e.target.value))} aria-label="speed">{[10, 30, 60, 120, 300].map((x) => <option key={x} value={x}>×{x}</option>)}</select>
    <span className="small muted">{hhmm(merged.t_min)}–{hhmm(merged.t_max)} · both maps follow one clock</span></div>;

  // ---------------- diff
  const pa = insts.a?.params, pb = insts.b?.params;
  const paramRows: [string, string, string][] = pa && pb ? [
    ['Maximum detour', `${num(pa.max_detour_s / 60, 2)} min`, `${num(pb.max_detour_s / 60, 2)} min`], ['Maximum detour ratio', `${num(100 * pa.max_detour_ratio)} %`, `${num(100 * pb.max_detour_ratio)} %`],
    ['Drivers', String(insts.a!.drivers.length), String(insts.b!.drivers.length)], ['Riders', String(insts.a!.riders.length), String(insts.b!.riders.length)],
    ['Compatible pairs', String(insts.a!.pairs.length), String(insts.b!.pairs.length)]] : [];
  const changedRoutes = r?.assignments ? r.assignments.changed + r.assignments.only_a + r.assignments.only_b : 0;
  const diffView = r && <div className="diff-grid">
    <section className="card pad"><h3>Scenario definition</h3>{paramRows.length ? <table className="compact"><thead><tr><th /><th className="n">A</th><th className="n">B</th></tr></thead><tbody>
      {paramRows.map(([k, x, y]) => <tr key={k} className={x !== y ? 'hl' : ''}><td>{k}</td><td className="n">{x}</td><td className="n">{y}</td></tr>)}</tbody></table> : <p className="small muted">Loading…</p>}
      <p className="tiny muted">{r.same_instance ? 'Same scenario file in A and B.' : 'B uses a scenario derived from A\'s (highlighted fields differ).'}</p></section>
    <section className="card pad"><h3>Assignments and served riders</h3>{r.assignments ? <>
      <div className="row gap wrap"><span className="badge ok">{r.assignments.same} same</span><span className="badge warn">{r.assignments.changed} changed</span><span className="badge">{r.assignments.only_a} only in A</span><span className="badge">{r.assignments.only_b} only in B</span></div>
      <p className="small">Served riders · A {r.served!.a} · B {r.served!.b} · both {r.served!.both}{r.served!.only_a.length ? ` · only A: ${r.served!.only_a.join(', ')}` : ''}{r.served!.only_b.length ? ` · only B: ${r.served!.only_b.join(', ')}` : ''}</p>
      <p className="small">Routes that differ: <b>{changedRoutes}</b> of {insts.a && insts.b ? Math.max(insts.a.drivers.length, insts.b.drivers.length) : r.assignments.same + changedRoutes} drivers</p>
      {r.assignments.detail.length > 0 && <div className="table-scroll tall"><table className="compact" aria-label="assignment differences"><thead><tr><th>Driver</th><th>A carries</th><th>B carries</th></tr></thead>
        <tbody>{r.assignments.detail.map((d) => <tr key={d.driver}><td>{d.driver}</td><td>{d.a ?? <span className="muted">alone</span>}</td><td>{d.b ?? <span className="muted">alone</span>}</td></tr>)}</tbody></table></div>}
    </> : <p className="small muted">One side has no run for this scenario.</p>}</section>
    <section className="card pad"><h3>Vehicles and CO₂</h3>{r.emissions && sameEmissionSemantics([r.emissions.a, r.emissions.b]) ? <table className="compact"><tbody>
      <tr><td>Vehicles used</td><td className="n">A {r.emissions.a?.vehicles_used}</td><td className="n">B {r.emissions.b?.vehicles_used}</td></tr>
      <tr><td>Vehicle distance</td><td className="n">A {num(r.emissions.a?.vehicle_km, 1)} km</td><td className="n">B {num(r.emissions.b?.vehicle_km, 1)} km</td></tr>
      <tr><td>CO₂</td><td className="n">A {num((r.emissions.a?.solution_g ?? 0) / 1000, 1)} kg</td><td className="n">B {num((r.emissions.b?.solution_g ?? 0) / 1000, 1)} kg</td></tr></tbody></table>
      : <p className="small muted">Not compared: the two sides use different CO₂ calculations or one has no complete vehicle data.</p>}
      {r.runtime && <p className="small">Runtime (median of repetitions) · A {runtime(r.runtime.a)} · B {runtime(r.runtime.b)}</p>}</section>
  </div>;

  const verdictChip = (v: Verdict | null | undefined, label: string) => v ? <span className={`badge ${VERDICT[v].cls}`}>{label}</span> : null;
  const toggleSummary = () => { const n = !collapsed; setCollapsed(n); try { localStorage.setItem(SUMMARY_KEY, n ? 'collapsed' : 'open'); } catch { /* storage unavailable */ } };
  const others = sides.slice(1).map((s, i) => ({ ...s, id: bs[i], c: candOf(bs[i]) }));
  const notRepro = (c: Candidate | undefined, L: string) => c?.relation.startsWith('Controlled variant') ? `${L} is a controlled variant of A, not a re-execution`
    : c?.relation.startsWith('Extension') ? `${L} extends A with methods, it is not a re-execution` : `${L} is not a re-execution of A`;
  const reproLine = (c: Candidate | undefined) => { const x = c?.reproducibility;
    return x?.applicable ? (x.reproduced ? `${t('ev.reproduced')}: ${x.cells} of ${x.cells} results equal` : x.reproduced === false ? `${x.different} of ${x.cells} results differ` : 'not analysed yet') : 'not applicable'; };
  // what each comparison with the reference establishes, claim by claim: identical (re-execution), comparable, not applicable
  const shows = (o: typeof others[number]) => { const c = o.c; if (!c) return null; const x = c.reproducibility;
    const claims = ([['results', c.quality], ['runtime', c.runtime], ['CO₂', c.emissions]] as [string, Verdict | null][]).filter(([, v]) => v);
    const by = (v: Verdict) => claims.filter(([, y]) => y === v).map(([k]) => k).join(', ');
    return <p key={o.id} className="evsum small" aria-label={`what the comparison of ${o.label} with A shows`}><span className="evsum-k">{o.label} vs A</span>
      {x.applicable && x.reproduced && <span><b>Identical:</b> every validated result ({x.cells} of {x.cells} cells{x.identical != null ? `; identical solutions in ${x.identical}` : ''})</span>}
      {x.applicable && x.reproduced === false && <span><b>Different:</b> {x.different} of {x.cells} cells</span>}
      {by('direct') && <span><b>{VERDICT.direct.label}:</b> {by('direct')}</span>}
      {by('conditional') && <span><b>{VERDICT.conditional.label}:</b> {by('conditional')}</span>}
      {by('incompatible') && <span><b>{VERDICT.incompatible.label}:</b> {by('incompatible')}</span>}
      {x.applicable && <span><b>Reported, not required to match:</b> runtimes (measured again)</span>}
      {!x.applicable && <span><b>Not applicable:</b> reproducibility — {notRepro(c, o.label)}</span>}</p>; };
  const sideTitle = (i: number) => sides[i]?.e?.campaign.title ?? '…';
  return <div className="ab">
    <div className="cmp-head">
      <div className="row gap wrap"><button className="btn ghost icon" aria-label="back to the workspace" onClick={back}><ChevronLeft size={17} /></button>
        {sides.map((s, i) => <span key={s.label} className={`cmpchip ${i === 0 ? 'ref' : ''}`} title={i === 0 ? 'Reference: every delta is computed against this experiment' : undefined}>
          <span className="badge" style={{ background: SERIES[i % SERIES.length], color: '#fff' }}>{s.label}</span><span className="ellipsis">{sideTitle(i)}</span>
          {i === 0 && <span className="badge outline">Reference</span>}</span>)}
        <span className="grow" />
        {<label className="row small gap" title="The reference is column A; deltas are other − A">Reference
          <select aria-label="reference for deltas" value={a} onChange={(e) => go(toRoute(setReference(sel, e.target.value)))}>
            {ordered(sel).map((id, i) => <option key={id} value={id}>{letter(i)} · {sideTitle(i)}</option>)}</select></label>}
        <button className="btn ghost sm" aria-expanded={!collapsed} aria-controls="cmp-evidence" onClick={toggleSummary} title={collapsed ? 'Show the evidence summary' : 'Hide the evidence summary to give the table, charts and maps more room'}>
          {collapsed ? <><ChevronDown size={14} /> Show summary</> : <><ChevronUp size={14} /> Hide summary</>}</button>
        <button className="btn" onClick={() => setAdding(true)}><Plus size={14} /> Edit selection</button>
        <button className="btn" onClick={csvTable}><Download size={14} /> Export table</button></div>
      {collapsed ? <div className="evstrip row gap wrap" id="cmp-evidence" aria-label="evidence summary (collapsed)">
        <span className="badge ok"><ShieldCheck size={12} /> Validated {sides.map((s) => `${s.label} ${s.e?.validation.accepted ?? '—'}/${s.e?.validation.runs ?? '—'}`).join(' · ')}</span>
        {others.map((o) => <span key={o.id} className="row gap"><span className={`badge ${o.c?.reproducibility.applicable && o.c.reproducibility.reproduced ? 'ok' : ''}`}><RotateCcw size={12} /> {o.label}: {o.c?.reproducibility.applicable ? reproLine(o.c) : 'reproducibility n/a'}</span>
          {o.c && <span className="row gap"><Scale size={13} className="muted" />{verdictChip(o.c.quality, 'Results')}{verdictChip(o.c.runtime, 'Runtime')}{verdictChip(o.c.emissions, 'CO₂')}</span>}</span>)}
      </div> : <>
      <div className="evgrid" id="cmp-evidence">
        <div className="evcard"><span className="evi ok"><ShieldCheck size={16} /></span><div><div className="evh">{t('ev.validation')}</div>
          <b>{sides.map((s) => `${s.label} ${s.e?.validation.accepted ?? '—'} of ${s.e?.validation.runs ?? '—'}`).join(' · ')} runs accepted</b>
          <div className="small muted">every solution checked by validator {ea?.validation.validator_version ?? ''}, not by the method</div></div></div>
        <div className="evcard"><span className={`evi ${others.some((o) => o.c?.reproducibility.applicable && o.c.reproducibility.reproduced) ? 'ok' : ''}`}><RotateCcw size={16} /></span><div><div className="evh">{t('ev.reproducibility')}</div>
          {others.map((o) => <div key={o.id}><b className={o.c?.reproducibility.applicable ? '' : 'soft'}>{o.label}: {o.c?.reproducibility.applicable ? reproLine(o.c) : 'not applicable'}</b>
            {!o.c?.reproducibility.applicable && <span className="small muted"> — {notRepro(o.c, o.label)}</span>}</div>)}
          <div className="small muted">every validated metric must be equal; runtimes are reported, not required to match</div></div></div>
        <div className="evcard"><span className={`evi ${others.every((o) => o.c?.quality === 'direct') ? 'ok' : ''}`}><Scale size={16} /></span><div className="grow"><div className="evh">{t('ev.comparability')} with A</div>
          {others.map((o) => <div key={o.id} className="row gap wrap"><b className="small">{o.label}</b>{o.c ? <>{verdictChip(o.c.quality, 'Results')}{verdictChip(o.c.runtime, 'Runtime')}{verdictChip(o.c.emissions, 'CO₂')}
            <button className="btn link small" aria-expanded={why && b === o.id} onClick={() => { const i = bs.indexOf(o.id); setBi(i); setWhy(!(why && b === o.id)); }}>{t('ev.why')}</button></> : <span className="small muted">…</span>}</div>)}
          </div></div>
      </div>
      {others.map((o) => shows(o))}
      {why && cand && <ul className="note small reasons"><li><b>{bLabel(Math.min(bi, bs.length - 1))} vs A:</b></li>{cand.reasons.length ? cand.reasons.map((x) => <li key={x}>{x}</li>) : <li>Same problem, objective, validator and comparable environment.</li>}</ul>}
      </>}
      <div className="row gap tabsrow"><nav className="tabs" aria-label="comparison views">{(['results', 'charts', 'maps', 'replay', 'diff'] as Tab[]).map((x) => <button key={x} className={tab === x ? 'on' : ''} aria-pressed={tab === x} onClick={() => setTab(x)}>{t(`cmp.tab.${x}` as 'cmp.tab.results')}</button>)}</nav>
        <span className="grow" />
        {(tab === 'results') && nScen > 1 && <div className="seg" role="group" aria-label="scope"><button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All {nScen} scenarios</button>
          {Array.from({ length: nScen }, (_, i) => <button key={i} className={scope === i ? 'on' : ''} onClick={() => setScope(i)}>Sample {i + 1}</button>)}</div>}
        {(tab === 'maps' || tab === 'replay' || tab === 'diff') && bs.length > 1 && <div className="seg" role="group" aria-label="experiment shown next to A">
          {bs.map((x, i) => <button key={x} className={i === Math.min(bi, bs.length - 1) ? 'on' : ''} aria-pressed={i === Math.min(bi, bs.length - 1)} onClick={() => { setBi(i); setMb(undefined); }}>A vs {bLabel(i)}</button>)}</div>}
        {(tab === 'maps' || tab === 'replay' || tab === 'diff') && scenSel}
        {(tab === 'maps' || tab === 'replay') && <label className="row small gap"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> {t('cmp.sync')}</label>}</div>
    </div>
    {err && <div className="lab-notes"><ErrorNote text={err} /></div>}
    <div className={`cmp-body ${tab === 'maps' || tab === 'replay' ? 'maps' : ''}`}>
      {tab === 'results' && <>{table}<p className="small muted">{ea?.results?.rows.every((x) => x.repetitions_consistent) ? `Results identical in all ${ea?.campaign.repetitions} repetitions (values from repetition 1); runtime uses every run.` : 'Repetitions differ for some cells: values from repetition 1.'} Deltas are against the reference A ({ea?.campaign.title ?? '…'}). CO₂ is compared only when the calculation is the same.</p></>}
      {tab === 'charts' && charts}
      {(tab === 'maps' || tab === 'replay') && <>{maps}{tab === 'replay' && replayBar}</>}
      {tab === 'diff' && diffView}
      {!ea && !err && <p className="muted small">Loading…</p>}
    </div>
    {adding && <ComparePicker current={a} already={ordered(sel)} reference={a} onClose={() => setAdding(false)} onCompare={(next) => { setAdding(false); go(toRoute(next)); }} />}
  </div>;
}

function FragmentRow({ d, methodIds, sides, scope, riders, co2Ok }: {
  d: { group?: string; label: string; basis: string; get: (c: Cell, e: Experiment | null) => number | null | undefined; fmt: (v: number) => string; co2?: boolean };
  methodIds: string[]; sides: { label: string; e: Experiment | null; rows: Map<string, ResultRow> }[]; scope: number | 'all'; riders: (e: Experiment | null) => number | null; co2Ok: (i: number) => boolean;
}) {
  const cols = methodIds.reduce((n) => n + sides.length + (sides.length - 1), 0) + 2;
  return <>
    {d.group && <tr className="grp"><td colSpan={cols}>{d.group}</td></tr>}
    <tr><td className="strong">{d.label}</td><td className="tiny muted nowrap">{d.basis}</td>
      {methodIds.flatMap((m) => { const av = (() => { const c = cellOf(sides[0].rows.get(m), scope, sides[0].e); return c ? d.get(c, sides[0].e) : null; })();
        return sides.flatMap((s, i) => {
          const c = cellOf(s.rows.get(m), scope, s.e); const v = c ? d.get(c, s.e) : null; const hide = d.co2 && !co2Ok(i);
          const shown = hide ? <span className="muted" title="different CO₂ calculation">not compared</span> : v == null ? <span className="muted">—</span>
            : d.label === 'Served riders' ? <>{d.fmt(v)}<span className="muted"> / {riders(s.e) ?? '—'}</span></> : d.fmt(v);
          const cells = [<td key={`${m}${i}`} className={`n ${i === 0 ? 'grp-l' : ''}`}>{shown}</td>];
          if (i > 0) { const dv = !hide && v != null && av != null ? v - av : null; cells.push(<td key={`${m}${i}d`} className={`n strong ${dv === 0 ? 'muted' : ''}`}>{dv == null ? '—' : dv === 0 ? '0' : `${dv > 0 ? '+' : '−'}${d.fmt(Math.abs(dv))}`}</td>); }
          return cells;
        }); })}</tr>
  </>;
}
