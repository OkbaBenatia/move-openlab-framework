import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { call, type Json, type Problem } from '../api/client';
import { tr } from '../i18n';
import { MetricsCell, errText, num } from './common';
import { ThresholdChart } from './ThresholdChart';

export function ThresholdReport({ id, problem, setErr }: { id: string; problem: Problem; setErr: (s: string | null) => void }) {
  const [d, setD] = useState<Json | null>(null);
  useEffect(() => { call(`/campaigns/${id}/threshold-report`).then(setD).catch((e) => setErr(errText(e))); }, [id, setErr]);
  if (!d) return null;
  return <div>
    <h3><SlidersHorizontal size={14} /> {tr('Threshold study')} — <span className="mono">{d.method.method_id}</span> · {tr('scorer')} {tr(d.scorer.label)}</h3>
    <p className="small muted">{d.selection_rule}. {tr('Reference:')} {d.definitions.reference}. {tr('Gap:')} {d.definitions.gap}. {tr('Recall:')} {d.definitions.recall}. {tr('Results on reduced instances are optimal for the reduced instance only, never a proof for the full problem.')}</p>
    <ThresholdChart summary={d.summary} mode={d.mode} />
    <div className="table-scroll"><table aria-label={tr('threshold summary')}><thead><tr><th>{d.mode === 'share' ? tr('Share kept') : tr('Threshold')}</th><th>{tr('Cells')}</th><th>{tr('Mean kept share')}</th><th>{tr('Mean reduction')}</th>{d.mode === 'share' && <th>{tr('Effective threshold (median)')}</th>}<th>{tr('Feasible on original')}</th>
      <th>{tr('Equal objective')}</th><th>{tr('{metric} shortfall', { metric: problem.objective[0].metric })}</th><th>{tr('Gap % mean / max')}</th><th>{tr('Mean recall')}</th><th>{tr('Median time ratio')}</th></tr></thead>
      <tbody>{d.summary.map((s: Json) => <tr key={s.threshold}><td className="mono">{s.threshold}</td><td>{s.cells}</td><td>{num(s.mean_kept_share, 3)}</td><td>{num(s.mean_reduction_pct, 1)} %</td>{d.mode === 'share' && <td>{num(s.effective_threshold?.median, 3)}</td>}
        <td>{s.feasible_on_original}/{s.cells}</td><td>{s.equal_objective}/{s.cells}</td><td>{num(s.level1_shortfall)}</td>
        <td>{s.final_level_gap_pct.n ? `${num(s.final_level_gap_pct.mean)} / ${num(s.final_level_gap_pct.max)}` : '—'}</td>
        <td>{num(s.mean_reference_recall, 3)}</td><td>{num(s.median_time_ratio, 3)}</td></tr>)}</tbody></table></div>
    <h3>{tr('Cells')}</h3>
    <div className="table-scroll tall"><table aria-label={tr('threshold cells')}><thead><tr><th>{tr('Scenario')}</th><th>{tr('Threshold')}</th><th>{tr('Kept')}</th><th>{tr('Full instance')}</th><th>{tr('Pruned')}</th><th>{tr('Equal')}</th><th>{tr('Gap %')}</th><th>{tr('Recall')}</th><th>{tr('What it proves')}</th></tr></thead>
      <tbody>{d.rows.map((r: Json) => <tr key={r.scenario + r.threshold}><td className="mono">{r.scenario}</td><td className="mono">{r.threshold}</td>
        <td>{r.candidates_kept}/{r.candidates_total}</td><td><MetricsCell metrics={r.reference_metrics} defs={problem.metrics} /></td>
        <td><MetricsCell metrics={r.pruned_metrics} defs={problem.metrics} /></td><td>{r.equal_objective ? tr('yes') : tr('no')}</td>
        <td>{num(r.final_level_gap_pct)}</td><td>{num(r.reference_recall, 3)}</td><td className="small">{tr(r.optimality_scope)}</td></tr>)}</tbody></table></div>
  </div>;
}
