import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { call, type Json, type Problem } from '../api/client';
import { MetricsCell, errText, secs, sh } from './common';

export function Reproducibility({ id, problem, setErr }: { id: string; problem: Problem; setErr: (s: string | null) => void }) {
  const [d, setD] = useState<Json | null>(null);
  useEffect(() => { call(`/campaigns/${id}/reproducibility`).then(setD).catch((e) => setErr(errText(e))); }, [id, setErr]);
  if (!d) return null;
  const metricsHead = problem.metrics.map((m) => m.label.toLowerCase()).join(' · ');
  return <div>
    <h3><ShieldCheck size={14} /> Reproducibility verification — {d.numerically_reproduced ? <span className="badge ok">NUMERICALLY REPRODUCED</span> : <span className="badge bad">NOT REPRODUCED</span>}</h3>
    <table className="kv"><tbody>
      <tr><th>Original</th><td>{d.original_researcher} · installation <span className="mono">{d.original_installation}</span> · campaign <span className="mono">{d.parent_campaign_id}</span> (checksum <span className="mono">{sh(d.parent_checksum, 16)}</span>)</td></tr>
      <tr><th>Independent re-execution</th><td>{d.reexecuting_researcher} · installation <span className="mono">{d.reexecution_installation}</span> · campaign <span className="mono">{d.campaign_id}</span> (new method executions)</td></tr>
      <tr><th>Agreement</th><td>{d.cells} cells: {d.agreement.identical_solution} identical solutions · {d.agreement.equal_objective} equal objective, different solution · {d.agreement.different} different</td></tr>
      <tr><th>Validation</th><td>all re-executed solutions independently feasible: {d.all_feasible ? 'yes' : 'NO'}</td></tr>
    </tbody></table>
    <p className="small muted">{d.note}</p>
    <div className="table-scroll tall"><table aria-label="reproduction cells"><thead><tr><th>Scenario</th><th>Method</th><th>Original ({metricsHead})</th><th>Re-executed</th><th>Status</th><th>Median total: original · re-executed</th></tr></thead>
      <tbody>{d.rows.map((r: Json) => <tr key={r.instance_hash + r.method_id}><td className="mono">{r.instance_id}</td><td className="mono small">{r.method_id}</td>
        <td><MetricsCell metrics={r.original?.metrics} defs={problem.metrics} /></td><td><MetricsCell metrics={r.reexecuted?.metrics} defs={problem.metrics} /></td>
        <td><span className={`badge ${r.status === 'DIFFERENT' || r.status === 'MISSING' ? 'bad' : 'ok'}`}>{r.status.replace('_', ' ')}</span></td>
        <td>{secs(r.original?.median_total_time_s)} · {secs(r.reexecuted?.median_total_time_s)}</td></tr>)}</tbody></table></div>
  </div>;
}
