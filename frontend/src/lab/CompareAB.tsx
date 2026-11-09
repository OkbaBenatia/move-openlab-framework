import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Link2, Pause, Play } from 'lucide-react';
import type { Json } from '../api/client';
import { ErrorNote, errText, num, secs } from '../components/common';
import { LeafletMap, type MapView } from '../geo/LeafletMap';
import { dur, geo, hhmm, hhmmss, type GeoConfig } from '../geo/api';
import { BASELINE_LABEL, SCOPE_LABEL, grams, mob, pct, sameEmissionSemantics, type Diff, type DiffRow } from '../mobility/api';
import { VERDICT, lab, type ExpItem, type Verdict } from './api';
import { planLayers, planPositions } from './layers';
import { useReplay } from './ReplayBar';

/** Comparison workspace: experiment A against one or several others (`#/compare/A|B1,B2`). Two maps side by side
 *  (A and the selected B, optionally synchronised), one replay clock, compatible metrics for every B in one table,
 *  and the differences between the solutions of A and the selected B, scenario by scenario. */
export function CompareAB({ arg, go }: { arg: string; go: (a: string, b: string) => void }) {
  const [a, bArg] = arg.split('|');
  const bs = useMemo(() => (bArg ?? '').split(',').filter(Boolean), [bArg]);
  const [bi, setBi] = useState(0);
  const b = bs[Math.min(bi, Math.max(0, bs.length - 1))] ?? '';
  const [cfg, setCfg] = useState<GeoConfig | null>(null);
  const [exps, setExps] = useState<ExpItem[]>([]);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [diffs, setDiffs] = useState<(Diff | null)[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [ma, setMa] = useState<string | undefined>(); const [mb, setMb] = useState<string | undefined>();
  const [row, setRow] = useState(0);
  const [plans, setPlans] = useState<{ a: Json | null; b: Json | null }>({ a: null, b: null });
  const [sync, setSync] = useState(true);
  const [syncReplay, setSyncReplay] = useState(true);
  const [view, setView] = useState<MapView | null>(null);
  const [tab, setTab] = useState<'metrics' | 'diff'>('metrics');
  const [replaying, setReplaying] = useState(false);
  useEffect(() => { geo.config().then(setCfg).catch((e) => setErr(errText(e))); lab.experiments().then((r) => setExps(r.experiments)).catch((e) => setErr(errText(e))); }, []);
  useEffect(() => {
    if (!a || !b) return;
    let live = true;
    setDiff(null); setErr(null); setRow(0);
    mob.diff(a, b, ma, mb).then((d) => live && setDiff(d)).catch((e) => live && setErr(errText(e)));
    return () => { live = false; };
  }, [a, b, ma, mb]);
  // several Bs: one diff per B (A's method fixed) for the metrics table
  useEffect(() => {
    if (bs.length < 2) { setDiffs([]); return; }
    let live = true;
    Promise.all(bs.map((x) => mob.diff(a, x, ma).catch(() => null))).then((ds) => live && setDiffs(ds));
    return () => { live = false; };
  }, [a, bs, ma]);
  const r: DiffRow | undefined = diff?.rows[row];
  useEffect(() => {
    let live = true;
    setPlans({ a: null, b: null });
    if (!r || !diff) return;
    const load = (cid: string, run: string | null) => run ? geo.playback(cid, run).catch(() => null) : Promise.resolve(null);
    Promise.all([load(diff.a.campaign_id, r.run_a), load(diff.b.campaign_id, r.run_b)]).then(([pa, pb]) => live && setPlans({ a: pa, b: pb }));
    return () => { live = false; };
  }, [diff, r]);
  // one replay clock over both plans (their union of time ranges)
  const merged = useMemo(() => plans.a || plans.b ? { t_min: Math.min(...[plans.a, plans.b].filter(Boolean).map((p) => p!.t_min)), t_max: Math.max(...[plans.a, plans.b].filter(Boolean).map((p) => p!.t_max)) } : null, [plans]);
  const replay = useReplay(merged, replaying && syncReplay);
  const la = useMemo(() => (plans.a ? planLayers(plans.a) : { points: [], lines: [] }), [plans.a]);
  const lb = useMemo(() => (plans.b ? planLayers(plans.b) : { points: [], lines: [] }), [plans.b]);
  const pick = (side: 'a' | 'b', id: string) => {
    if (!id) return;
    if (side === 'a') go(id, bs.join(','));
    else { const next = [...bs]; next[Math.min(bi, bs.length - 1)] = id; go(a, next.join(',')); }
  };
  if (!cfg) return <ErrorNote text={err} />;
  const same = diff ? sameEmissionSemantics([diff.totals.emissions.a, diff.totals.emissions.b]) : false;
  const verdict = (v: Verdict | string | null | undefined) => v && VERDICT[v as Verdict] ? <span className={`badge ${VERDICT[v as Verdict].cls}`}>{VERDICT[v as Verdict].label}</span> : null;
  const delta = (x: number | null | undefined, y: number | null | undefined, unit = '') => (x == null || y == null ? '—' : `${y - x > 0 ? '+' : ''}${num(y - x)}${unit}`);
  const title = (id: string) => exps.find((x) => x.campaign_id === id)?.title ?? id;
  const bLabel = (i: number) => (bs.length > 1 ? `B${i + 1}` : 'B');
  const side = (s: 'a' | 'b') => <label className="sel grow"><span>Experiment {s === 'a' ? 'A' : bLabel(Math.min(bi, bs.length - 1))}</span>
    <select aria-label={`experiment ${s}`} value={s === 'a' ? a : b} onChange={(e) => pick(s, e.target.value)}>{exps.filter((x) => !x.hidden || x.campaign_id === (s === 'a' ? a : b)).map((x) => <option key={x.campaign_id} value={x.campaign_id}>{x.title}</option>)}</select></label>;
  const methodSel = (s: 'a' | 'b') => diff && <select aria-label={`method ${s}`} value={(s === 'a' ? diff.a : diff.b).method_id ?? ''} onChange={(e) => (s === 'a' ? setMa : setMb)(e.target.value)} className="small">
    {(s === 'a' ? diff.a : diff.b).methods.map((m) => <option key={m} value={m}>{m}</option>)}</select>;
  const fmt = (m: { unit: string }, v: number | null | undefined) => (v == null ? '—' : m.unit === 's' ? dur(v) : num(v));
  const multi = bs.length > 1 && diffs.length === bs.length;
  return <div className="ab">
    <div className="labbar" role="toolbar" aria-label="comparison">
      <div className="row gap selectors">{side('a')}{side('b')}
        {bs.length > 1 && <nav className="subtabs ab-tabs" aria-label="experiments compared" style={{ margin: 0 }}>{bs.map((x, i) => <button key={x} className={`btn sm ${i === bi ? 'primary' : ''}`} onClick={() => { setBi(i); setMb(undefined); }} title={title(x)}>{bLabel(i)}</button>)}</nav>}</div>
      <div className="row gap actions-bar">
        <label className="row small"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> Sync maps</label>
        <label className="row small"><input type="checkbox" checked={syncReplay} onChange={(e) => setSyncReplay(e.target.checked)} /> Sync replay</label>
        <button className={`btn ${replaying ? 'primary' : ''}`} disabled={!merged} aria-pressed={replaying} onClick={() => setReplaying(!replaying)}><Play size={14} /> Replay</button>
        <a className="btn" href={`#/workspace/${encodeURIComponent(a)}`} target="_blank" rel="noopener"><ExternalLink size={13} /> A</a>
        <a className="btn" href={`#/workspace/${encodeURIComponent(b)}`} target="_blank" rel="noopener"><ExternalLink size={13} /> {bLabel(Math.min(bi, bs.length - 1))}</a>
      </div>
    </div>
    {err && <div className="lab-notes"><ErrorNote text={err} /></div>}
    <div className="ab-maps">
      {(['a', 'b'] as const).map((s) => <div key={s} className="ab-map">
        <div className="row gap ab-title"><b>{s === 'a' ? 'A' : bLabel(Math.min(bi, bs.length - 1))}</b><span className="grow ellipsis">{s === 'a' ? diff?.a.title : diff?.b.title}</span>{methodSel(s)}</div>
        <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={s === 'a' ? la.points : lb.points} lines={s === 'a' ? la.lines : lb.lines}
          dynamic={replaying && (s === 'a' ? plans.a : plans.b) ? planPositions(s === 'a' ? plans.a! : plans.b!, replay.t) : []}
          fitKey={sync ? `ab|${row}` : `${s}|${row}|${(s === 'a' ? plans.a : plans.b)?.run_id ?? ''}`} view={sync ? view : null} onView={sync ? setView : undefined} height="100%" />
      </div>)}
    </div>
    {replaying && merged && <div className="replay ab-replay" aria-label="synchronised replay"><div className="row gap">
      <button className="btn icon" onClick={() => { if (replay.t >= merged.t_max) replay.setT(merged.t_min); replay.setPlaying(!replay.playing); }} aria-label={replay.playing ? 'pause' : 'play'}>{replay.playing ? <Pause size={14} /> : <Play size={14} />}</button>
      <span className="mono">{hhmmss(replay.t)}</span>
      <input type="range" min={merged.t_min} max={merged.t_max} step={1} value={replay.t} aria-label="time" className="grow" onChange={(e) => { replay.setPlaying(false); replay.setT(Number(e.target.value)); }} />
      <select value={replay.speed} onChange={(e) => replay.setSpeed(Number(e.target.value))} aria-label="speed">{[10, 30, 60, 120, 300].map((s) => <option key={s} value={s}>×{s}</option>)}</select>
      <span className="small muted">{hhmm(merged.t_min)}–{hhmm(merged.t_max)}</span></div></div>}
    <div className="ab-panel">
      {diff && <div className="row gap">
        <label className="row small">Scenario <select aria-label="scenario" value={row} onChange={(e) => setRow(Number(e.target.value))}>{diff.rows.map((x, i) => <option key={i} value={i}>{x.instance_id}{x.same_instance ? '' : ' ↔ ' + x.instance_id_b}</option>)}</select></label>
        <span className="small muted">{diff.matched} matched{diff.unmatched.a + diff.unmatched.b ? ` · ${diff.unmatched.a + diff.unmatched.b} unmatched` : ''}</span>
        <span className="grow" />
        {diff.comparability && <span className="row gap small"><Link2 size={12} /> results {verdict(diff.comparability.quality)} runtime {verdict(diff.comparability.runtime)} {diff.comparability.emissions && <>emissions {verdict(diff.comparability.emissions)}</>}</span>}
        <nav className="subtabs" aria-label="comparison views" style={{ margin: 0 }}>
          <button className={`btn sm ${tab === 'metrics' ? 'primary' : ''}`} onClick={() => setTab('metrics')}>Metrics</button>
          <button className={`btn sm ${tab === 'diff' ? 'primary' : ''}`} onClick={() => setTab('diff')}>Diff</button></nav></div>}
      {diff && diff.comparability && diff.comparability.reasons.length > 0 && <details className="small"><summary>Why?</summary><ul>{diff.comparability.reasons.map((x) => <li key={x}>{x}</li>)}</ul></details>}
      {diff && tab === 'metrics' && !multi && <div className="table-scroll"><table className="compact" aria-label="metrics A and B"><thead><tr><th>Metric</th><th>A · {diff.a.method_id}</th><th>B · {diff.b.method_id}</th><th>B − A</th></tr></thead><tbody>
        {diff.metrics.map((m) => <tr key={m.id}><td>{m.label} <span className="muted small">(all matched scenarios)</span></td><td>{fmt(m, diff.totals.metrics.a[m.id])}</td><td>{fmt(m, diff.totals.metrics.b[m.id])}</td><td>{delta(diff.totals.metrics.a[m.id], diff.totals.metrics.b[m.id])}</td></tr>)}
        <tr><td>Served riders</td><td>{diff.totals.served.a}</td><td>{diff.totals.served.b}</td><td>{delta(diff.totals.served.a, diff.totals.served.b)}</td></tr>
        <tr><td>Runtime (median per scenario)</td><td>{secs(diff.totals.runtime.a)}</td><td>{secs(diff.totals.runtime.b)}</td><td>{delta(diff.totals.runtime.a, diff.totals.runtime.b, ' s')}</td></tr>
        {same && <>
          <tr><td>Vehicles used</td><td>{diff.totals.emissions.a?.vehicles_used}</td><td>{diff.totals.emissions.b?.vehicles_used}</td><td>{delta(diff.totals.emissions.a?.vehicles_used, diff.totals.emissions.b?.vehicles_used)}</td></tr>
          <tr><td>Vehicle distance</td><td>{num(diff.totals.emissions.a?.vehicle_km, 1)} km</td><td>{num(diff.totals.emissions.b?.vehicle_km, 1)} km</td><td>{delta(diff.totals.emissions.a?.vehicle_km, diff.totals.emissions.b?.vehicle_km, ' km')}</td></tr>
          <tr><td>CO₂ <span className="muted small">({SCOPE_LABEL[diff.totals.emissions.a!.scope]}, baseline: {BASELINE_LABEL[diff.totals.emissions.a!.baseline]})</span></td><td>{grams(diff.totals.emissions.a?.solution_g)}</td><td>{grams(diff.totals.emissions.b?.solution_g)}</td><td>{grams((diff.totals.emissions.b?.solution_g ?? 0) - (diff.totals.emissions.a?.solution_g ?? 0))}</td></tr>
          <tr><td>Avoided CO₂</td><td>{grams(diff.totals.emissions.a?.avoided_g)} · {pct(diff.totals.emissions.a?.avoided_pct)}</td><td>{grams(diff.totals.emissions.b?.avoided_g)} · {pct(diff.totals.emissions.b?.avoided_pct)}</td><td>{grams((diff.totals.emissions.b?.avoided_g ?? 0) - (diff.totals.emissions.a?.avoided_g ?? 0))}</td></tr></>}
        {!same && (diff.totals.emissions.a || diff.totals.emissions.b) && <tr><td colSpan={4} className="small muted">Emission figures are not shown side by side: {!diff.totals.emissions.a?.complete || !diff.totals.emissions.b?.complete ? 'one side has no complete emission data' : 'the two experiments use different emission scopes, baselines or units'}.</td></tr>}
      </tbody></table></div>}
      {diff && tab === 'metrics' && multi && <div className="table-scroll"><table className="compact" aria-label="metrics of every experiment"><thead><tr><th>Metric</th><th>A · {diff.a.method_id}</th>
        {bs.map((x, i) => <th key={x} className={i === bi ? 'hl' : ''}>{bLabel(i)} · {diffs[i]?.b.method_id ?? '—'}<div className="small muted ellipsis" style={{ maxWidth: 160 }}>{title(x)}</div></th>)}</tr></thead><tbody>
        {diff.metrics.map((m) => <tr key={m.id}><td>{m.label}</td><td>{fmt(m, diff.totals.metrics.a[m.id])}</td>
          {bs.map((x, i) => { const d = diffs[i]; return <td key={x}>{d ? <>{fmt(m, d.totals.metrics.b[m.id])} <span className="small muted">({delta(d.totals.metrics.a[m.id], d.totals.metrics.b[m.id])})</span></> : <span className="muted">not comparable</span>}</td>; })}</tr>)}
        <tr><td>Served riders</td><td>{diff.totals.served.a}</td>{bs.map((x, i) => <td key={x}>{diffs[i] ? <>{diffs[i]!.totals.served.b} <span className="small muted">({delta(diffs[i]!.totals.served.a, diffs[i]!.totals.served.b)})</span></> : '—'}</td>)}</tr>
        <tr><td>Runtime (median per scenario)</td><td>{secs(diff.totals.runtime.a)}</td>{bs.map((x, i) => <td key={x}>{diffs[i] ? secs(diffs[i]!.totals.runtime.b) : '—'}</td>)}</tr>
        <tr><td>CO₂ <span className="muted small">(where the calculation is the same as A's)</span></td><td>{grams(diff.totals.emissions.a?.solution_g)}</td>
          {bs.map((x, i) => { const d = diffs[i]; const ok = d && sameEmissionSemantics([d.totals.emissions.a, d.totals.emissions.b]); return <td key={x}>{ok ? grams(d!.totals.emissions.b?.solution_g) : <span className="muted">—</span>}</td>; })}</tr>
        <tr><td>Comparability</td><td /> {bs.map((x, i) => <td key={x}>{diffs[i]?.comparability ? <>{verdict(diffs[i]!.comparability!.quality)}</> : <span className="muted">—</span>}</td>)}</tr>
      </tbody></table><p className="small muted">Deltas are B − A. Click a B above to show it on the right map and in the Diff view.</p></div>}
      {diff && tab === 'diff' && r && <div className="ab-diff">
        <p className="small"><b>{r.instance_id}</b>{!r.same_instance && <span className="muted"> ↔ {r.instance_id_b} (same problem, other vehicle or emission data)</span>}</p>
        {r.assignments ? <>
          <div className="row gap small"><span className="badge ok">{r.assignments.same} same</span><span className="badge warn">{r.assignments.changed} changed</span><span className="badge">{r.assignments.only_a} only A</span><span className="badge">{r.assignments.only_b} only B</span>
            <span className="grow" /><span>served A {r.served!.a} · B {r.served!.b} · both {r.served!.both}</span></div>
          {r.assignments.detail.length > 0 && <div className="table-scroll tall"><table className="compact" aria-label="assignment differences"><thead><tr><th>Driver</th><th>A</th><th>B</th></tr></thead>
            <tbody>{r.assignments.detail.map((d) => <tr key={d.driver}><td className="mono">{d.driver}</td><td>{d.a ?? <span className="muted">alone</span>}</td><td>{d.b ?? <span className="muted">alone</span>}</td></tr>)}</tbody></table></div>}
          {(r.served!.only_a.length > 0 || r.served!.only_b.length > 0) && <p className="small muted">Served only in A: {r.served!.only_a.join(', ') || '—'} · only in B: {r.served!.only_b.join(', ') || '—'}</p>}
          {r.metrics && <p className="small muted">Objective A {Object.entries(r.metrics.a).map(([k, v]) => `${k} ${v}`).join(' · ')} · B {Object.entries(r.metrics.b).map(([k, v]) => `${k} ${v}`).join(' · ')} · runtime {secs(r.runtime?.a)} / {secs(r.runtime?.b)}</p>}
          {r.emissions && sameEmissionSemantics([r.emissions.a, r.emissions.b]) && <p className="small muted">CO₂ A {grams(r.emissions.a?.solution_g)} · B {grams(r.emissions.b?.solution_g)} · vehicles {r.emissions.a?.vehicles_used} / {r.emissions.b?.vehicles_used}</p>}
        </> : <p className="small muted">One side has no run for this scenario.</p>}
      </div>}
      {!diff && !err && <p className="muted small">Loading…</p>}
    </div>
  </div>;
}
