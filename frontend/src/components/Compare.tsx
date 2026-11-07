import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { call, download, type Json, type Problem } from '../api/client';
import { Lineage, errText, num, secs, sh } from './common';

export function Compare({ id, problem, setErr }: { id: string; problem: Problem; setErr: (s: string | null) => void }) {
  const [d, setD] = useState<Json | null>(null);
  useEffect(() => { call(`/campaigns/${id}/compare`).then(setD).catch((e) => setErr(errText(e))); }, [id, setErr]);
  if (!d) return null;
  const rows: Json[] = d.rows;
  const groups = Object.keys(rows[0]?.by_group ?? {});
  const first = problem.objective[0];
  return <div>
    <Lineage lineage={d.lineage} />
    <p className="muted small">{d.scenarios} scenarios (identical instance hashes across campaigns: {d.instance_hashes_identical ? 'yes' : 'NO'})
      {d.reference && <> · reference: <span className="mono">{d.reference.method_id}</span> of {d.reference.owner_display}'s campaign</>} · ranking: {d.ranking_rule}.</p>
    {d.warnings.map((w: string) => <p key={w} className="note warn" role="note">{w}</p>)}
    <div className="row gap actions">
      <button className="btn" onClick={() => download(`/campaigns/${id}/report.md`, `comparison_${id}.md`).catch((e) => setErr(errText(e)))}><Download size={13} /> Report (Markdown)</button>
      <button className="btn" onClick={() => download(`/campaigns/${id}/report.csv`, `comparison_${id}.csv`).catch((e) => setErr(errText(e)))}><Download size={13} /> Table (CSV)</button>
    </div>
    <div className="table-scroll"><table aria-label="method comparison">
      <thead><tr><th>Method</th><th>Origin</th><th>Researcher</th><th>Validation</th>{problem.metrics.map((m) => <th key={m.id} title="sum over all scenarios">{m.label}</th>)}
        <th title="scenarios where every objective level equals the exact reference">Equals reference optimum</th><th>Shortfall ({first.metric})</th><th>Gap % mean / max*</th><th>Mean rank</th><th>What it proves</th><th>Median time: solver · total</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.method_id + r.campaign_id} className={r.campaign_kind === 'extended' ? 'hl' : ''}>
        <td><b>{r.name}</b><div className="mono small">{r.method_id}@{r.version}{r.code_sha256 ? ` · code ${sh(r.code_sha256, 8)}` : ''}</div></td>
        <td>{r.origin}</td><td>{r.researcher}</td>
        <td>{r.all_feasible ? <span className="badge ok">{r.scenarios}/{r.scenarios} valid</span> : <span className="badge bad">invalid</span>}</td>
        {problem.metrics.map((m) => <td key={m.id}>{num(r.totals[m.id])}</td>)}
        <td>{r.optimal ?? '—'}/{r.scenarios}</td><td>{num(r.shortfall)}</td>
        <td>{r.final_level_gap_pct?.n ? `${num(r.final_level_gap_pct.mean)} % / ${num(r.final_level_gap_pct.max)} %` : '—'}</td>
        <td>{num(r.mean_rank)}</td><td className="small">{Object.entries((r.optimality_scope ?? {}) as Record<string, number>).map(([k, n]) => <div key={k}>{n} × {k}</div>)}</td><td>{secs(r.median_solver_time_s)} · {secs(r.median_total_time_s)}</td>
        <td>{r.reproduction_status ?? r.origin}</td></tr>)}</tbody></table></div>
    <p className="small muted">* relative gap on the last objective level, only on scenarios where every previous level equals the reference (positive = worse).
      Solver time = time reported by the solver (method time otherwise); total time = platform wall time of the isolated execution.</p>
    {groups.length > 0 && <><h3>By group</h3>
      <div className="table-scroll"><table aria-label="by group"><thead><tr><th>Method</th><th>Origin</th>{groups.map((g) => <th key={g}>{g}: {problem.metrics.map((m) => m.id).join(' · ')} · = ref. optimum · solver</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={'g' + r.method_id + r.campaign_id}><td className="mono">{r.method_id}</td><td>{r.origin}</td>
          {groups.map((g) => { const b = r.by_group[g]; return <td key={g}>{b ? `${problem.metrics.map((m) => num(b.totals[m.id])).join(' · ')} · ${b.optimal ?? '—'}/${b.scenarios} · ${secs(b.median_solver_time_s)}` : '—'}</td>; })}</tr>)}</tbody></table></div></>}
  </div>;
}
