import { useEffect, useState } from 'react';
import { Scale } from 'lucide-react';
import { call, type Json, type Problem } from '../api/client';
import { MetricsCell, STATUS_CLASS, STATUS_LABEL, errText } from './common';

export function Semantic({ ids, problem, setErr }: { ids: string; problem: Problem; setErr: (s: string | null) => void }) {
  const [reference, candidate] = ids.split('|');
  const [d, setD] = useState<Json | null>(null);
  const [scen, setScen] = useState('');
  useEffect(() => {
    call(`/semantic-compare?reference=${encodeURIComponent(reference)}&candidate=${encodeURIComponent(candidate)}`).then((r) => {
      setD(r); setScen(r.candidate.variant?.modifications?.[0]?.parent_instance_id ?? r.rows[0]?.scenario ?? '');
    }).catch((e) => setErr(errText(e)));
  }, [reference, candidate, setErr]);
  if (!d) return null;
  const scenarios: string[] = Array.from(new Set((d.rows as Json[]).map((r) => r.scenario)));
  const rows = (d.rows as Json[]).filter((r) => r.scenario === scen);
  const mod = d.candidate.variant?.modifications?.find((m: Json) => m.parent_instance_id === scen);
  const reasons = (x: Json): string[] => [...x.incompatible, ...x.qualifications, ...x.notes];
  return <div>
    <h3><Scale size={14} /> Semantic comparability <span className="muted small">contract {d.contract}</span></h3>
    <table className="kv"><tbody>
      <tr><th>Reference</th><td>{d.reference.title} · {d.reference.researcher} · <span className="mono small">{d.reference.campaign_id}</span> · reference method <span className="mono">{d.reference_method}</span></td></tr>
      <tr><th>Candidate</th><td>{d.candidate.title} · {d.candidate.researcher} · <span className="mono small">{d.candidate.campaign_id}</span>{d.candidate.variant && <> · variant <b>{d.candidate.variant.variant}</b>: {d.candidate.variant.description}</>}</td></tr>
      <tr><th>All scenarios</th><td>{d.claims.map((cl: string) => <span key={cl} className="sum"><b>{cl === 'quality' ? 'Objective-quality claim' : 'Runtime claim'}:</b> {Object.entries(d.summary[cl]).map(([k, n]) => <span key={k} className={`badge ${STATUS_CLASS[k]}`}>{n as number} {STATUS_LABEL[k]}</span>)}</span>)}</td></tr>
    </tbody></table>
    <div className="row gap actions"><label className="row">Scenario <select aria-label="scenario" value={scen} onChange={(e) => setScen(e.target.value)}>{scenarios.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
      {mod && <span className="small muted">Modification: <span className="mono">{mod.modification.field}</span> {mod.modification.old !== undefined && <>{String(mod.modification.old)} → {String(mod.modification.new)}</>} ({mod.modification.intent})</span>}</div>
    <div className="table-scroll"><table aria-label="semantic comparability">
      <thead><tr><th>Method</th><th>Researcher · side</th><th>Instance file</th><th>Problem fingerprint (ref → cand)</th><th>Reference</th><th>Candidate</th><th>Quality claim</th><th>Runtime claim</th><th>Reasons</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.method + r.campaign}>
        <td className="mono small">{r.method}</td><td className="small">{r.researcher} · {r.side}</td><td className="small">{r.raw_hash_equal ? 'identical' : 'different file'}</td>
        <td className="mono small">{r.problem_fingerprint.reference} → {r.problem_fingerprint.candidate} {r.problem_fingerprint.reference === r.problem_fingerprint.candidate ? '(same problem)' : '(different problem)'}</td>
        <td><MetricsCell metrics={r.reference.metrics} defs={problem.metrics} />{r.reference.certified_optimal ? ' (optimal)' : ''}</td><td><MetricsCell metrics={r.candidate.metrics} defs={problem.metrics} /></td>
        <td><span className={`badge ${STATUS_CLASS[r.quality.status]}`}>{STATUS_LABEL[r.quality.status]}</span></td>
        <td><span className={`badge ${STATUS_CLASS[r.runtime.status]}`}>{STATUS_LABEL[r.runtime.status]}</span></td>
        <td className="small desc">{reasons(r.quality).concat(r.runtime.qualifications.filter((q: string) => !r.quality.qualifications.includes(q))).map((x) => <div key={x}>{x}</div>)}
          {reasons(r.quality).length === 0 && r.runtime.qualifications.length === 0 && <span className="muted">same problem, objective, metrics, budget and environment</span>}</td></tr>)}</tbody></table></div>
    <p className="small muted">A decision applies to the stated claim only. Different methods never make a comparison invalid; a different feasible region, objective or metric
      definition does. Non-binding changes change the instance file hash but not the problem fingerprint.</p>
  </div>;
}
