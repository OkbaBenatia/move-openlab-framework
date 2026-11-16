import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { call, type Json, type Problem } from '../api/client';
import { tr } from '../i18n';
import { MetricsCell, errText, secs, sh } from './common';

export function Reproducibility({ id, problem, setErr }: { id: string; problem: Problem; setErr: (s: string | null) => void }) {
  const [d, setD] = useState<Json | null>(null);
  useEffect(() => { call(`/campaigns/${id}/reproducibility`).then(setD).catch((e) => setErr(errText(e))); }, [id, setErr]);
  if (!d) return null;
  const metricsHead = problem.metrics.map((m) => tr(m.label).toLowerCase()).join(' · ');
  return <div>
    <h3><ShieldCheck size={14} /> {tr('Reproducibility verification')} — {d.numerically_reproduced ? <span className="badge ok">{tr('NUMERICALLY REPRODUCED')}</span> : <span className="badge bad">{tr('NOT REPRODUCED')}</span>}</h3>
    <table className="kv"><tbody>
      <tr><th>{tr('Original')}</th><td>{d.original_researcher} · {tr('installation')} <span className="mono">{d.original_installation}</span> · {tr('campaign')} <span className="mono">{d.parent_campaign_id}</span> ({tr('checksum')} <span className="mono">{sh(d.parent_checksum, 16)}</span>)</td></tr>
      <tr><th>{tr('Independent re-execution')}</th><td>{d.reexecuting_researcher} · {tr('installation')} <span className="mono">{d.reexecution_installation}</span> · {tr('campaign')} <span className="mono">{d.campaign_id}</span> {tr('(new method executions)')}</td></tr>
      <tr><th>{tr('Agreement')}</th><td>{tr('{n} cells: {a} identical solutions · {b} equal objective, different solution · {c} different', { n: d.cells, a: d.agreement.identical_solution, b: d.agreement.equal_objective, c: d.agreement.different })}</td></tr>
      <tr><th>{tr('Validation')}</th><td>{tr('all re-executed solutions independently feasible: {v}', { v: d.all_feasible ? tr('yes') : tr('NO') })}</td></tr>
    </tbody></table>
    <p className="small muted">{tr(d.note)}</p>
    <div className="table-scroll tall"><table aria-label={tr('reproduction cells')}><thead><tr><th>{tr('Scenario')}</th><th>{tr('Method')}</th><th>{tr('Original ({metrics})', { metrics: metricsHead })}</th><th>{tr('Re-executed')}</th><th>{tr('Status')}</th><th>{tr('Median total: original · re-executed')}</th></tr></thead>
      <tbody>{d.rows.map((r: Json) => <tr key={r.instance_hash + r.method_id}><td className="mono">{r.instance_id}</td><td className="mono small">{r.method_id}</td>
        <td><MetricsCell metrics={r.original?.metrics} defs={problem.metrics} /></td><td><MetricsCell metrics={r.reexecuted?.metrics} defs={problem.metrics} /></td>
        <td><span className={`badge ${r.status === 'DIFFERENT' || r.status === 'MISSING' ? 'bad' : 'ok'}`}>{tr(r.status.replace('_', ' '))}</span></td>
        <td>{secs(r.original?.median_total_time_s)} · {secs(r.reexecuted?.median_total_time_s)}</td></tr>)}</tbody></table></div>
  </div>;
}
