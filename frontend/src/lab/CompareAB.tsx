import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronUp, Download, ListChecks, Pause, Play, Plus, RotateCcw, Scale, ShieldCheck } from 'lucide-react';
import type { Json } from '../api/client';
import { ErrorNote, errText, num } from '../components/common';
import { LeafletMap, type MapView } from '../geo/LeafletMap';
import { geo, hhmm, hhmmss, type GeoConfig } from '../geo/api';
import { t, tr } from '../i18n';
import { BASELINE_LABEL, SCOPE_LABEL, mob, sameEmissionSemantics, type Diff } from '../mobility/api';
import { VERDICT, lab, type Experiment, type ResultRow, type Verdict } from './api';
import { ComparePicker, type Candidate } from './ComparePicker';
import { fromRoute, letter, ordered, setReference, toRoute } from './compareSelection';
import { CompareCharts } from './CompareCharts';
import { CompareTabs } from './CompareTabs';
import { OPEN_ACTION, handOff } from './handoff';
import { ScenarioNav } from './ScenarioNav';
import { scenarioLabel } from './scenarioNames';
import { planLayers, planPositions } from './layers';
import { useReplay } from './ReplayBar';
import { runtime } from './ResultPanel';
import { byMethod, cellOf, plain, ridersOf, sameScenarios, servedOf, type Side } from './compareData';
import { MetricChooser } from './MetricChooser';
import { GROUPS, metricDefs, missingWord, shownValue, type Ctx, type MetricDef } from './metrics';
import { useMetricChoice, useMlEvaluations } from './useMetrics';

const SUMMARY_KEY = 'move-openlab.compare-summary';   // collapsed / open, remembered on this browser

type Tab = 'results' | 'charts' | 'maps' | 'replay' | 'diff';
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', '#9085e9', '#e87ba4'];

/** The comparison workspace: experiment A against one or several Bs (`#/compare/A|B1,B2`). The three kinds of evidence
 *  stay apart (validation, reproducibility, semantic comparability). Results: a method-grouped table with the basis of
 *  every value and a scope (all scenarios or one); Charts with CSV/PNG/SVG export; synchronised maps and replay; Diff
 *  scenario by scenario (definition, assignments, served riders, routes, vehicles, CO₂ where comparable). */
export function CompareAB({ arg, go, back, onMethods }: { arg: string; go: (route: string) => void; back: () => void; onMethods?: (cid: string) => void }) {
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
  useEffect(() => { geo.config().then(setCfg).catch((e) => setErr(errText(e))); }, []);
  // experiments are compared as their own records (a study view belongs to the Methods tab)
  useEffect(() => { lab.experiment(a, 'records').then(setEa).catch((e) => setErr(errText(e))); }, [a]);
  useEffect(() => { Promise.all(bs.map((x) => lab.experiment(x, 'records').catch(() => null))).then(setEbs); }, [bs]);
  // only one experiment in the address: choose what to compare it with
  useEffect(() => { if (a && bs.length === 0) setAdding(true); }, [a, bs.length]);
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
  // the metrics shown: the account's choice for this problem, the same one as in the Workspace and Compare › Methods
  const mc = useMetricChoice(ea);
  const everyRow = useMemo(() => [ea, ...ebs].flatMap((e) => Array.from(byMethod(e).values())), [ea, ebs]);
  const { mlOf } = useMlEvaluations(everyRow, mc.visible.some((d) => d.group === 'ml'));
  if (!cfg) return <ErrorNote text={err} />;

  // ---------------- results table
  const sides: { label: string; e: Experiment | null; rows: Map<string, ResultRow> }[] = [{ label: 'A', e: ea, rows: byMethod(ea) }, ...bs.map((_, i) => ({ label: bLabel(i), e: ebs[i] ?? null, rows: byMethod(ebs[i] ?? null) }))];
  const methodIds = Array.from(new Set(sides.flatMap((s) => Array.from(s.rows.keys()))));
  const nScen = ea?.scenarios.length ?? 0;
  const riders = (e: Experiment | null) => ridersOf(e, scope, ea);
  const otherSets = sides.slice(1).filter((s) => s.e && !sameScenarios(s.e, ea)).map((s) => s.label);
  const co2Ok = (i: number) => !!sides[i].e && (i === 0 || (cands.find((c) => c.campaign_id === sides[i].e!.campaign.campaign_id)?.emissions ?? 'direct') !== 'incompatible');
  // every value is read through the shared metric model; the speed-up of a method is against the reference method of
  // its own experiment, and a CO₂ figure is put beside A's only when the two CO₂ calculations are comparable
  const refOf = (s: Side) => { const id = (s.e?.results?.reference as { method_id?: string } | null)?.method_id; return id ? s.rows.get(id) : undefined; };
  const ctxOf = (s: Side): Ctx => ({ ref: cellOf(refOf(s), scope, s.e, ea), refRow: refOf(s) ?? null, ml: mlOf });
  const isCo2 = (d: MetricDef) => d.id.startsWith('co2');
  const valueOf = (d: MetricDef, m: string, i: number): number | null => { const s = sides[i], r = s.rows.get(m), c = cellOf(r, scope, s.e, ea);
    return !r || !c || d.text || (isCo2(d) && !co2Ok(i)) ? null : d.get(c, r, scope, ctxOf(s)) ?? null; };
  const whyOf = (d: MetricDef, m: string, i: number) => { const r = sides[i].rows.get(m); return r ? d.why?.(r, scope, ctxOf(sides[i])) ?? null : null; };
  const rowHas = (d: MetricDef) => methodIds.some((m) => sides.some((s, i) => { const r = s.rows.get(m), c = cellOf(r, scope, s.e, ea); if (!r || !c) return false;
    return d.text ? d.text(c, r) !== '—' : valueOf(d, m, i) != null || /not configured|not available|not applicable|needed|not computed/i.test(whyOf(d, m, i) ?? ''); }));
  const shownDefs = mc.visible.filter(rowHas);
  const csvTable = () => {
    // exactly the compared experiments and the chosen metrics: one value column per experiment and method, and the delta
    // to the reference A; the file is in English whatever the interface language
    const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
    const en = new Map(metricDefs(ea, mc.customs, { nScen, reps: ea?.campaign.repetitions ?? 1, riders: (k) => servedOf(ea, k), population: 0, names: (k) => scenarioLabel(ea?.scenarios[k], k, plain) }, plain).map((d) => [d.id, d]));
    const head = ['group', 'metric', 'unit', 'aggregation', ...methodIds.flatMap((m) => sides.flatMap((s, i) => [`${m} ${s.label}`, ...(i > 0 ? [`${m} ${s.label}-A`] : [])]))];
    const lines = shownDefs.map((d) => { const e = en.get(d.id) ?? d; return [q(d.group), q(e.label), q(e.unit), q(e.basis(scope)), ...methodIds.flatMap((m) => sides.flatMap((s, i) => { const v = valueOf(d, m, i), av = valueOf(d, m, 0);
      const r = s.rows.get(m), c = cellOf(r, scope, s.e, ea);
      const cell = v != null ? v : e.text && r && c ? q(e.text(c, r)) : isCo2(d) && !co2Ok(i) ? q('not compared') : q(missingWord(whyOf(e, m, i)).replace('—', ''));
      return [cell, ...(i > 0 ? [v != null && av != null ? v - av : ''] : [])]; }))].join(','); });
    const legend = [...sides.map((s) => `# ${s.label}${s.label === 'A' ? ' (reference)' : ''}: ${s.e?.campaign.title ?? ''} [${s.e?.campaign.campaign_id ?? ''}]`),
      `# scope: ${scope === 'all' ? `all ${nScen} scenarios` : scenarioLabel(ea?.scenarios[scope], scope, plain)}`];
    const blob = new Blob([[...legend, head.join(','), ...lines].join('\n') + '\n'], { type: 'text/csv' });
    const x = document.createElement('a'); x.href = URL.createObjectURL(blob); x.download = 'move_openlab_comparison.csv'; x.click();
  };
  // one column group per method id; when the experiments name that method differently (e.g. another policy of the same
  // method), every distinct name is shown with its side so B's values are never read under A's name
  const headName = (m: string) => {
    const named = sides.map((s) => [s.label, s.rows.get(m)?.name] as const).filter((x): x is readonly [string, string] => !!x[1]);
    const distinct = [...new Set(named.map((x) => x[1]))];
    return distinct.length <= 1 ? (distinct[0] ?? m) : named.map(([l, n]) => `${l}: ${n}`).join(' · ');
  };
  const cols = methodIds.reduce((n) => n + sides.length + (sides.length - 1), 0) + 1;
  const emis = ea?.campaign.emissions;
  const table = <><div className="card table-card"><table className="compact cmp-table" aria-label={tr('comparison by method')}><thead>
    <tr><th rowSpan={2}>{tr('Metric')}</th>{methodIds.map((m) => <th key={m} colSpan={sides.length + (sides.length > 1 ? sides.length - 1 : 0)} className="center grp-l">{headName(m)}</th>)}</tr>
    <tr>{methodIds.flatMap((m) => sides.flatMap((s, i) => [<th key={`${m}${s.label}`} className={`n ${i === 0 ? 'grp-l' : ''}`}><span className="dot" style={{ background: SERIES[i] }} /> {s.label}</th>,
      ...(i > 0 ? [<th key={`${m}${s.label}d`} className="n">{s.label} − A</th>] : [])]))}</tr></thead>
    <tbody>{GROUPS.map(([g, label]) => { const list = shownDefs.filter((d) => d.group === g); if (!list.length) return null;
      return [<tr key={g} className="grp"><td colSpan={cols}>{tr(label)}</td></tr>,
        ...list.map((d) => <tr key={d.id} data-metric={d.id}><td className="strong" title={[d.help, `${tr('Aggregation')}: ${d.basis(scope)}`].filter(Boolean).join('\n')}>{d.label}</td>
          {methodIds.flatMap((m) => { const av = valueOf(d, m, 0);
            return sides.flatMap((s, i) => { const r = s.rows.get(m), c = cellOf(r, scope, s.e, ea); const v = valueOf(d, m, i); const hide = isCo2(d) && !co2Ok(i); const why = v == null ? whyOf(d, m, i) : null;
              const shown = !r || !c ? <span className="muted">—</span> : d.text ? d.text(c, r) : hide ? <span className="muted" title={tr('different CO₂ calculation')}>{tr('not compared')}</span>
                : v == null ? <span className="muted na" title={why ? tr(why) : tr('No value recorded')}>{tr(missingWord(why))}</span>
                : d.id === 'served' ? <>{d.fmt(v)}<span className="muted"> / {riders(s.e) ?? '—'}</span></> : shownValue(d, v);
              const cells = [<td key={`${m}${i}`} className={`n ${i === 0 ? 'grp-l' : ''}`}>{shown}</td>];
              if (i > 0) { const dv = v != null && av != null ? v - av : null; cells.push(<td key={`${m}${i}d`} className={`n strong ${dv === 0 ? 'muted' : ''}`}>{dv == null ? '—' : dv === 0 ? '0' : `${dv > 0 ? '+' : '−'}${shownValue(d, Math.abs(dv)).replace(/^\+/, '')}`}</td>); }
              return cells; }); })}</tr>)]; })}</tbody></table></div>
    {shownDefs.some(isCo2) && <p className="small muted co2-basis">{emis ? tr('CO₂ · {scope} · vs {baseline}', { scope: tr(SCOPE_LABEL[emis.scope] ?? emis.scope), baseline: tr(BASELINE_LABEL[emis.baseline] ?? emis.baseline).toLowerCase() }) : tr('CO₂ · not configured')}</p>}
    {shownDefs.filter((d) => d.caveat).map((d) => <p key={d.id} className="small warn-text" role="note"><b>{d.label}</b>: {d.caveat}</p>)}</>;

  // ---------------- charts
  const charts = <CompareCharts sides={sides} colors={sides.map((_, i) => SERIES[i % SERIES.length])} methodIds={methodIds} cands={cands} customs={mc.customs} chosen={mc.chosen} mlOf={mlOf} onChoose={mc.open} />;

  // ---------------- maps / replay
  const methodSel = (s: 'a' | 'b') => diff && <select aria-label={`${tr('method')} ${s}`} value={(s === 'a' ? diff.a : diff.b).method_id ?? ''} onChange={(e) => (s === 'a' ? setMa : setMb)(e.target.value)} className="small">
    {(s === 'a' ? diff.a : diff.b).methods.map((m) => <option key={m} value={m}>{(s === 'a' ? sides[0] : sides[Math.min(bi, bs.length - 1) + 1])?.rows.get(m)?.name ?? m}</option>)}</select>;
  const scenSel = diff && <label className="row small gap">{tr('Scenario')} <select aria-label={tr('scenario')} value={row} onChange={(e) => setRow(Number(e.target.value))}>{diff.rows.map((x, i) => <option key={i} value={i}>{scenarioLabel(ea?.scenarios[i], i)}{x.same_instance ? '' : ` (${tr('derived in B')})`}</option>)}</select></label>;
  const maps = <div className="ab-maps">{(['a', 'b'] as const).map((s) => <div key={s} className="ab-map">
    <div className="mapcard ab-title row gap"><span className="badge" style={{ background: s === 'a' ? SERIES[0] : SERIES[Math.min(bi, bs.length - 1) + 1], color: '#fff' }}>{s === 'a' ? 'A' : bLabel(Math.min(bi, bs.length - 1))}</span>
      <b className="small ellipsis">{s === 'a' ? ea?.campaign.title : eb?.campaign.title}</b>{methodSel(s)}</div>
    <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={s === 'a' ? la.points : lb.points} lines={s === 'a' ? la.lines : lb.lines}
      dynamic={tab === 'replay' && (s === 'a' ? plans.a : plans.b) ? planPositions(s === 'a' ? plans.a! : plans.b!, replay.t) : []}
      fitKey={sync ? `ab|${row}|${plans.a ? 1 : 0}` : `${s}|${row}|${(s === 'a' ? plans.a : plans.b)?.run_id ?? ''}`} view={sync ? view : null} onView={sync ? setView : undefined} height="100%" />
  </div>)}</div>;
  const replayBar = merged && <div className="replay-bar row gap" aria-label={tr('synchronised replay')}>
    <button className="play" onClick={() => { if (replay.t >= merged.t_max) replay.setT(merged.t_min); setPlaying(true); replay.setPlaying(!replay.playing); }} aria-label={replay.playing ? tr('pause') : tr('play')}>{replay.playing ? <Pause size={15} /> : <Play size={15} />}</button>
    <span className="time tnum">{hhmmss(replay.t || merged.t_min).slice(0, 5)}</span>
    <input type="range" min={merged.t_min} max={merged.t_max} step={1} value={replay.t || merged.t_min} aria-label={tr('time')} className="grow" onChange={(e) => { replay.setPlaying(false); replay.setT(Number(e.target.value)); }} />
    <select value={replay.speed} onChange={(e) => replay.setSpeed(Number(e.target.value))} aria-label={tr('speed')}>{[10, 30, 60, 120, 300].map((x) => <option key={x} value={x}>×{x}</option>)}</select>
    <span className="small muted">{hhmm(merged.t_min)}–{hhmm(merged.t_max)} · {tr('both maps follow one clock')}</span></div>;

  // ---------------- diff
  const pa = insts.a?.params, pb = insts.b?.params;
  const paramRows: [string, string, string][] = pa && pb ? [
    [tr('Maximum detour'), `${num(pa.max_detour_s / 60, 2)} min`, `${num(pb.max_detour_s / 60, 2)} min`], [tr('Maximum detour ratio'), `${num(100 * pa.max_detour_ratio)} %`, `${num(100 * pb.max_detour_ratio)} %`],
    [tr('Drivers'), String(insts.a!.drivers.length), String(insts.b!.drivers.length)], [tr('Riders'), String(insts.a!.riders.length), String(insts.b!.riders.length)],
    [tr('Compatible pairs'), String(insts.a!.pairs.length), String(insts.b!.pairs.length)]] : [];
  const changedRoutes = r?.assignments ? r.assignments.changed + r.assignments.only_a + r.assignments.only_b : 0;
  const diffView = r && <div className="diff-grid">
    <section className="card pad"><h3>{tr('Scenario definition')}</h3>{paramRows.length ? <table className="compact"><thead><tr><th /><th className="n">A</th><th className="n">B</th></tr></thead><tbody>
      {paramRows.map(([k, x, y]) => <tr key={k} className={x !== y ? 'hl' : ''}><td>{k}</td><td className="n">{x}</td><td className="n">{y}</td></tr>)}</tbody></table> : <p className="small muted">{tr('Loading…')}</p>}
      <p className="tiny muted">{r.same_instance ? tr('Same scenario file in A and B.') : tr("B uses a scenario derived from A's (highlighted fields differ).")}</p></section>
    <section className="card pad"><h3>{tr('Assignments and served riders')}</h3>{r.assignments ? <>
      <div className="row gap wrap"><span className="badge ok">{tr('{n} same', { n: r.assignments.same })}</span><span className="badge warn">{tr('{n} changed', { n: r.assignments.changed })}</span><span className="badge">{tr('{n} only in A', { n: r.assignments.only_a })}</span><span className="badge">{tr('{n} only in B', { n: r.assignments.only_b })}</span></div>
      <p className="small">{tr('Served riders · A {a} · B {b} · both {both}', { a: r.served!.a, b: r.served!.b, both: r.served!.both })}{r.served!.only_a.length ? ` · ${tr('only A: {ids}', { ids: r.served!.only_a.join(', ') })}` : ''}{r.served!.only_b.length ? ` · ${tr('only B: {ids}', { ids: r.served!.only_b.join(', ') })}` : ''}</p>
      <p className="small">{tr('Routes that differ:')} <b>{changedRoutes}</b> {tr('of {n} drivers', { n: insts.a && insts.b ? Math.max(insts.a.drivers.length, insts.b.drivers.length) : r.assignments.same + changedRoutes })}</p>
      {r.assignments.detail.length > 0 && <div className="table-scroll tall"><table className="compact" aria-label={tr('assignment differences')}><thead><tr><th>{tr('Driver')}</th><th>{tr('A carries')}</th><th>{tr('B carries')}</th></tr></thead>
        <tbody>{r.assignments.detail.map((d) => <tr key={d.driver}><td>{d.driver}</td><td>{d.a ?? <span className="muted">{tr('alone')}</span>}</td><td>{d.b ?? <span className="muted">{tr('alone')}</span>}</td></tr>)}</tbody></table></div>}
    </> : <p className="small muted">{tr('One side has no run for this scenario.')}</p>}</section>
    <section className="card pad"><h3>{tr('Vehicles and CO₂')}</h3>{r.emissions && sameEmissionSemantics([r.emissions.a, r.emissions.b]) ? <table className="compact"><tbody>
      <tr><td>{tr('Vehicles used')}</td><td className="n">A {r.emissions.a?.vehicles_used}</td><td className="n">B {r.emissions.b?.vehicles_used}</td></tr>
      <tr><td>{tr('Vehicle distance')}</td><td className="n">A {num(r.emissions.a?.vehicle_km, 1)} km</td><td className="n">B {num(r.emissions.b?.vehicle_km, 1)} km</td></tr>
      <tr><td>CO₂</td><td className="n">A {num((r.emissions.a?.solution_g ?? 0) / 1000, 1)} kg</td><td className="n">B {num((r.emissions.b?.solution_g ?? 0) / 1000, 1)} kg</td></tr></tbody></table>
      : <p className="small muted">{tr('Not compared: the two sides use different CO₂ calculations or one has no complete vehicle data.')}</p>}
      {r.runtime && <p className="small">{tr('Runtime (median of repetitions) · A {a} · B {b}', { a: runtime(r.runtime.a), b: runtime(r.runtime.b) })}</p>}</section>
  </div>;

  const verdictChip = (v: Verdict | null | undefined, label: string) => v ? <span className={`badge ${VERDICT[v].cls}`}>{label}</span> : null;
  const toggleSummary = () => { const n = !collapsed; setCollapsed(n); try { localStorage.setItem(SUMMARY_KEY, n ? 'collapsed' : 'open'); } catch { /* storage unavailable */ } };
  const others = sides.slice(1).map((s, i) => ({ ...s, id: bs[i], c: candOf(bs[i]) }));
  const notRepro = (c: Candidate | undefined, L: string) => c?.relation.startsWith('Controlled variant') ? tr('{L} is a controlled variant of A, not a re-execution', { L })
    : c?.relation.startsWith('Extension') ? tr('{L} extends A with methods, it is not a re-execution', { L }) : tr('{L} is not a re-execution of A', { L });
  const reproLine = (c: Candidate | undefined) => { const x = c?.reproducibility;
    return x?.applicable ? (x.reproduced ? `${t('ev.reproduced')}: ${tr('{n} of {m} results equal', { n: x.cells ?? '', m: x.cells ?? '' })}` : x.reproduced === false ? tr('{n} of {m} results differ', { n: x.different ?? '', m: x.cells ?? '' }) : tr('not analysed yet')) : tr('not applicable'); };
  // what each comparison with the reference establishes, claim by claim: identical (re-execution), comparable, not applicable
  const shows = (o: typeof others[number]) => { const c = o.c; if (!c) return null; const x = c.reproducibility;
    const claims = ([[tr('results'), c.quality], [tr('runtime'), c.runtime], ['CO₂', c.emissions]] as [string, Verdict | null][]).filter(([, v]) => v);
    const by = (v: Verdict) => claims.filter(([, y]) => y === v).map(([k]) => k).join(', ');
    return <p key={o.id} className="evsum small" aria-label={tr('what the comparison of {x} with A shows', { x: o.label })}><span className="evsum-k">{tr('{x} vs A', { x: o.label })}</span>
      {x.applicable && x.reproduced && <span><b>{tr('Identical:')}</b> {tr('every validated result ({n} of {n} cells{more})', { n: x.cells ?? '', more: x.identical != null ? tr('; identical solutions in {k}', { k: x.identical }) : '' })}</span>}
      {x.applicable && x.reproduced === false && <span><b>{tr('Different:')}</b> {tr('{n} of {m} cells', { n: x.different ?? '', m: x.cells ?? '' })}</span>}
      {by('direct') && <span><b>{tr('{label}:', { label: tr(VERDICT.direct.label) })}</b> {by('direct')}</span>}
      {by('conditional') && <span><b>{tr('{label}:', { label: tr(VERDICT.conditional.label) })}</b> {by('conditional')}</span>}
      {by('incompatible') && <span><b>{tr('{label}:', { label: tr(VERDICT.incompatible.label) })}</b> {by('incompatible')}</span>}
      {x.applicable && <span><b>{tr('Reported, not required to match:')}</b> {tr('runtimes (measured again)')}</span>}
      {!x.applicable && <span><b>{tr('Not applicable:')}</b> {tr('reproducibility')} — {notRepro(c, o.label)}</span>}</p>; };
  const sideTitle = (i: number) => sides[i]?.e?.campaign.title ?? '…';
  return <div className="ab">
    <div className="cmp-head">
      <div className="row gap wrap"><button className="btn ghost icon" aria-label={tr('back to the workspace')} onClick={back}><ChevronLeft size={17} /></button>
        <h2 className="cmp-title">{tr('Compare')}</h2><CompareTabs active="experiments" onMethods={onMethods && a ? () => onMethods(a) : undefined} />
        {sides.map((s, i) => <span key={s.label} className={`cmpchip ${i === 0 ? 'ref' : ''}`} title={i === 0 ? tr('Reference: every delta is computed against this experiment') : undefined}>
          <span className="badge" style={{ background: SERIES[i % SERIES.length], color: '#fff' }}>{s.label}</span><span className="ellipsis">{sideTitle(i)}</span>
          {i === 0 && <span className="badge outline">{tr('Reference')}</span>}</span>)}
        <span className="grow" />
        {<label className="row small gap" title={tr('The reference is column A; deltas are other − A')}>{tr('Reference')}
          <select aria-label={tr('reference for deltas')} value={a} onChange={(e) => go(toRoute(setReference(sel, e.target.value)))}>
            {ordered(sel).map((id, i) => <option key={id} value={id}>{letter(i)} · {sideTitle(i)}</option>)}</select></label>}
        <button className="btn ghost sm" aria-expanded={!collapsed} aria-controls="cmp-evidence" onClick={toggleSummary} title={collapsed ? tr('Show the evidence summary') : tr('Hide the evidence summary to give the table, charts and maps more room')}>
          {collapsed ? <><ChevronDown size={14} /> {tr('Show summary')}</> : <><ChevronUp size={14} /> {tr('Hide summary')}</>}</button>
        <button className="btn" onClick={() => setAdding(true)}><Plus size={14} /> {tr('Edit selection')}</button>
        <button className="btn" onClick={mc.open} disabled={!ea?.results}><ListChecks size={14} /> {tr('Choose metrics')}</button>
        <button className="btn" onClick={csvTable}><Download size={14} /> {tr('Export table')}</button></div>
      {collapsed ? <div className="evstrip row gap wrap" id="cmp-evidence" aria-label={tr('evidence summary (collapsed)')}>
        <span className="badge ok"><ShieldCheck size={12} /> {tr('Validated')} {sides.map((s) => `${s.label} ${s.e?.validation.accepted ?? '—'}/${s.e?.validation.runs ?? '—'}`).join(' · ')}</span>
        {others.map((o) => <span key={o.id} className="row gap"><span className={`badge ${o.c?.reproducibility.applicable && o.c.reproducibility.reproduced ? 'ok' : ''}`}><RotateCcw size={12} /> {o.label}: {o.c?.reproducibility.applicable ? reproLine(o.c) : tr('reproducibility n/a')}</span>
          {o.c && <span className="row gap"><Scale size={13} className="muted" />{verdictChip(o.c.quality, tr('Results'))}{verdictChip(o.c.runtime, tr('Runtime'))}{verdictChip(o.c.emissions, 'CO₂')}</span>}</span>)}
      </div> : <>
      <div className="evgrid" id="cmp-evidence">
        <div className="evcard"><span className="evi ok"><ShieldCheck size={16} /></span><div><div className="evh">{t('ev.validation')}</div>
          <b>{sides.map((s) => `${s.label} ${tr('{a} of {n}', { a: s.e?.validation.accepted ?? '—', n: s.e?.validation.runs ?? '—' })}`).join(' · ')} {tr('runs accepted')}</b>
          <div className="small muted">{tr('every solution checked by validator {v}, not by the method', { v: ea?.validation.validator_version ?? '' })}</div></div></div>
        <div className="evcard"><span className={`evi ${others.some((o) => o.c?.reproducibility.applicable && o.c.reproducibility.reproduced) ? 'ok' : ''}`}><RotateCcw size={16} /></span><div><div className="evh">{t('ev.reproducibility')}</div>
          {others.map((o) => <div key={o.id}><b className={o.c?.reproducibility.applicable ? '' : 'soft'}>{o.label}: {o.c?.reproducibility.applicable ? reproLine(o.c) : tr('not applicable')}</b>
            {!o.c?.reproducibility.applicable && <span className="small muted"> — {notRepro(o.c, o.label)}</span>}</div>)}
          <div className="small muted">{tr('every validated metric must be equal; runtimes are reported, not required to match')}</div></div></div>
        <div className="evcard"><span className={`evi ${others.every((o) => o.c?.quality === 'direct') ? 'ok' : ''}`}><Scale size={16} /></span><div className="grow"><div className="evh">{tr('{x} with A', { x: t('ev.comparability') })}</div>
          {others.map((o) => <div key={o.id} className="row gap wrap"><b className="small">{o.label}</b>{o.c ? <>{verdictChip(o.c.quality, tr('Results'))}{verdictChip(o.c.runtime, tr('Runtime'))}{verdictChip(o.c.emissions, 'CO₂')}
            <button className="btn link small" aria-expanded={why && b === o.id} onClick={() => { const i = bs.indexOf(o.id); setBi(i); setWhy(!(why && b === o.id)); }}>{t('ev.why')}</button></> : <span className="small muted">…</span>}</div>)}
          </div></div>
      </div>
      {others.map((o) => shows(o))}
      {why && cand && <ul className="note small reasons"><li><b>{tr('{x} vs A:', { x: bLabel(Math.min(bi, bs.length - 1)) })}</b></li>{cand.reasons.length ? cand.reasons.map((x) => <li key={x}>{tr(x)}</li>) : <li>{tr('Same problem, objective, validator and comparable environment.')}</li>}</ul>}
      </>}
      <div className="row gap tabsrow"><nav className="tabs" aria-label={tr('comparison views')}>{(['results', 'charts', 'maps', 'replay', 'diff'] as Tab[]).map((x) => <button key={x} className={tab === x ? 'on' : ''} aria-pressed={tab === x} onClick={() => setTab(x)}>{t(`cmp.tab.${x}` as 'cmp.tab.results')}</button>)}</nav>
        <span className="grow" />
        {(tab === 'results') && nScen > 1 && ea && <ScenarioNav scenarios={ea.scenarios} value={scope} onChange={setScope} />}
        {(tab === 'maps' || tab === 'replay' || tab === 'diff') && bs.length > 1 && <div className="seg" role="group" aria-label={tr('experiment shown next to A')}>
          {bs.map((x, i) => <button key={x} className={i === Math.min(bi, bs.length - 1) ? 'on' : ''} aria-pressed={i === Math.min(bi, bs.length - 1)} onClick={() => { setBi(i); setMb(undefined); }}>A vs {bLabel(i)}</button>)}</div>}
        {(tab === 'maps' || tab === 'replay' || tab === 'diff') && scenSel}
        {(tab === 'maps' || tab === 'replay') && <label className="row small gap"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> {t('cmp.sync')}</label>}</div>
    </div>
    {err && <div className="lab-notes"><ErrorNote text={err} /></div>}
    <div className={`cmp-body ${tab === 'maps' || tab === 'replay' ? 'maps' : ''}`}>
      {tab === 'results' && <>{table}{scope !== 'all' && (ea?.scenarios[scope]?.notes ?? []).map((n) => <p key={n} className="small warn-text" role="note">{n}</p>)}<p className="small muted">{ea?.results?.rows.every((x) => x.repetitions_consistent) ? tr('Results identical in all {n} repetitions (values from repetition 1); runtime uses every run.', { n: ea?.campaign.repetitions ?? '' }) : tr('Repetitions differ for some cells: values from repetition 1.')} {tr('Deltas are against the reference A ({title}). CO₂ is compared only when the calculation is the same.', { title: ea?.campaign.title ?? '…' })}{otherSets.length > 0 && ` ${otherSets.length > 1 ? tr("{s} cover other scenarios than A: totals are not compared; each sample is matched to A's scenario by its frozen instance.", { s: otherSets.join(', ') }) : tr("{s} covers other scenarios than A: totals are not compared; each sample is matched to A's scenario by its frozen instance.", { s: otherSets.join(', ') })}`}</p></>}
      {tab === 'charts' && charts}
      {(tab === 'maps' || tab === 'replay') && <>{maps}{tab === 'replay' && replayBar}</>}
      {tab === 'diff' && diffView}
      {!ea && !err && <p className="muted small">{tr('Loading…')}</p>}
      {ea && bs.length === 0 && <p className="muted">{tr('Choose the experiments to compare with this one (Edit selection): variants, imported results, reproductions.')}</p>}
    </div>
    {mc.choosing && <MetricChooser defs={mc.defs} chosen={mc.chosen} onApply={mc.apply} onClose={mc.close} remembered={mc.remembered} unavailable={(d) => mc.unavailable(d, everyRow, { ref: null, refRow: null, ml: mlOf })} />}
    {adding && <ComparePicker current={a} already={ordered(sel)} reference={a} onClose={() => setAdding(false)} onCompare={(next) => { setAdding(false); go(toRoute(next)); }}
      onMethods={onMethods && (ea?.results?.rows.length ?? 0) > 1 ? () => onMethods(a) : undefined}
      onAddMethod={() => { handOff(OPEN_ACTION, { action: 'add-method', cid: a }); back(); }}
      onReproduce={ea?.campaign.locked ? () => { handOff(OPEN_ACTION, { action: 'reproduce', cid: a }); back(); } : undefined} />}
  </div>;
}
