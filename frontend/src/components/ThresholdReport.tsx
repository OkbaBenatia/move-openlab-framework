import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { call, type Json, type Problem } from '../api/client';
import { MetricsCell, errText, num } from './common';
import { ThresholdChart } from './ThresholdChart';

export function ThresholdReport({ id, problem, setErr }: { id: string; problem: Problem; setErr: (s: string | null) => void }) {
  const [d, setD] = useState<Json | null>(null);
  useEffect(() => { call(`/campaigns/${id}/threshold-report`).then(setD).catch((e) => setErr(errText(e))); }, [id, setErr]);
  if (!d) return null;
  return <div>
    <h3><SlidersHorizontal size={14} /> Threshold study — <span className="mono">{d.method.method_id}</span> · scorer {d.scorer.label}</h3>
    <p className="small muted">{d.selection_rule}. Reference: {d.definitions.reference}. Gap: {d.definitions.gap}. Recall: {d.definitions.recall}.
      Results on reduced instances are optimal for the reduced instance only, never a proof for the full problem.</p>
    <ThresholdChart summary={d.summary} mode={d.mode} />
    <div className="table-scroll"><table aria-label="threshold summary"><thead><tr><th>{d.mode === 'share' ? 'Share kept' : 'Threshold'}</th><th>Cells</th><th>Mean kept share</th><th>Mean reduction</th>{d.mode === 'share' && <th>Effective threshold (median)</th>}<th>Feasible on original</th>
      <th>Equal objective</th><th>{problem.objective[0].metric} shortfall</th><th>Gap % mean / max</th><th>Mean recall</th><th>Median time ratio</th></tr></thead>
      <tbody>{d.summary.map((s: Json) => <tr key={s.threshold}><td className="mono">{s.threshold}</td><td>{s.cells}</td><td>{num(s.mean_kept_share, 3)}</td><td>{num(s.mean_reduction_pct, 1)} %</td>{d.mode === 'share' && <td>{num(s.effective_threshold?.median, 3)}</td>}
        <td>{s.feasible_on_original}/{s.cells}</td><td>{s.equal_objective}/{s.cells}</td><td>{num(s.level1_shortfall)}</td>
        <td>{s.final_level_gap_pct.n ? `${num(s.final_level_gap_pct.mean)} / ${num(s.final_level_gap_pct.max)}` : '—'}</td>
        <td>{num(s.mean_reference_recall, 3)}</td><td>{num(s.median_time_ratio, 3)}</td></tr>)}</tbody></table></div>
    <h3>Cells</h3>
    <div className="table-scroll tall"><table aria-label="threshold cells"><thead><tr><th>Scenario</th><th>Threshold</th><th>Kept</th><th>Full instance</th><th>Pruned</th><th>Equal</th><th>Gap %</th><th>Recall</th><th>What it proves</th></tr></thead>
      <tbody>{d.rows.map((r: Json) => <tr key={r.scenario + r.threshold}><td className="mono">{r.scenario}</td><td className="mono">{r.threshold}</td>
        <td>{r.candidates_kept}/{r.candidates_total}</td><td><MetricsCell metrics={r.reference_metrics} defs={problem.metrics} /></td>
        <td><MetricsCell metrics={r.pruned_metrics} defs={problem.metrics} /></td><td>{r.equal_objective ? 'yes' : 'no'}</td>
        <td>{num(r.final_level_gap_pct)}</td><td>{num(r.reference_recall, 3)}</td><td className="small">{r.optimality_scope}</td></tr>)}</tbody></table></div>
  </div>;
}
