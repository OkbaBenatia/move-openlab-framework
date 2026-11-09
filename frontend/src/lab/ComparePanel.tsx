import { useState } from 'react';
import { BarChart3, Columns2, Table2, X } from 'lucide-react';
import { secs, num } from '../components/common';
import { dur } from '../geo/api';
import { BASELINE_LABEL, SCOPE_LABEL, grams, pct, sameEmissionSemantics } from '../mobility/api';
import { Charts, rowLabel } from './Charts';
import type { Experiment, ResultRow } from './api';

export const statusOf = (r: ResultRow) => !r.valid ? { label: 'Invalid', cls: 'bad' }
  : r.proven_optimal === r.scenarios ? { label: 'Proven optimal', cls: 'ok' }
  : r.proven_optimal > 0 ? { label: `Proven optimal ${r.proven_optimal}/${r.scenarios}`, cls: 'ok' }
  : r.kind === 'exact' ? { label: 'Not proven', cls: 'warn' } : { label: 'Heuristic', cls: '' };

const desc = (r: ResultRow, id: string) => r.descriptive.find((d) => d.id === id)?.value ?? null;

/** Comparison of the methods of one experiment: a concise table, then charts of any metric the problem supports;
 *  or two experiments side by side (A/B). */
export function ComparePanel({ exp, onClose, onDetails, onPick }: { exp: Experiment; onClose: () => void; onDetails: () => void; onPick: () => void }) {
  const [tab, setTab] = useState<'table' | 'charts'>('table');
  const rows = exp.results?.rows ?? [];
  const metrics = exp.problem.metrics;
  const hasGap = rows.some((r) => r.gap_pct != null);
  const served = metrics.find((m) => m.id === 'served');
  const rate = rows.some((r) => desc(r, 'service_rate') != null);
  const emissions = sameEmissionSemantics(rows.map((r) => r.domain));
  const dom = rows.find((r) => r.domain?.complete)?.domain;
  return <div className="overlay" role="dialog" aria-label="compare methods" onClick={onClose}>
    <div className="drawer wide" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><h2>Compare methods</h2><span className="muted small">{exp.campaign.title}</span><span className="grow" />
        <button className="btn icon" aria-label="close" onClick={onClose}><X size={15} /></button></div>
      <nav className="subtabs" aria-label="comparison views">
        <button className={`btn sm ${tab === 'table' ? 'primary' : ''}`} onClick={() => setTab('table')}><Table2 size={12} /> Table</button>
        <button className={`btn sm ${tab === 'charts' ? 'primary' : ''}`} onClick={() => setTab('charts')}><BarChart3 size={12} /> Charts</button>
        <span className="grow" />
        <button className="btn sm" onClick={onPick}><Columns2 size={12} /> Compare with other experiments…</button></nav>
      {rows.length === 0 && <p className="muted">Run the experiment to compare its methods.</p>}
      {rows.length > 0 && tab === 'table' && <div className="table-scroll"><table aria-label="method comparison">
        <thead><tr><th>Method</th><th>Status</th><th title={exp.problem.objective.map((o) => `${o.sense} ${o.metric}`).join(', then ')}>Objective</th>
          <th>Runtime</th>{hasGap && <th title="relative gap on the last objective level, where every earlier level equals the exact reference">Gap</th>}
          {served && <th>{served.label}</th>}{rate && <th>Service rate</th>}{rate && <th>Mean detour</th>}
          {emissions && <th title={`${SCOPE_LABEL[dom!.scope]} · baseline: ${BASELINE_LABEL[dom!.baseline]}`}>CO₂</th>}{emissions && <th>Avoided CO₂</th>}</tr></thead>
        <tbody>{rows.map((r) => { const st = statusOf(r); return <tr key={r.method_id + r.campaign_id} className={r.campaign_kind === 'extended' ? 'hl' : ''}>
          <td><b>{rowLabel(r, rows)}</b></td><td><span className={`badge ${st.cls}`}>{st.label}</span></td>
          <td>{exp.problem.objective.map((o) => (metrics.find((m) => m.id === o.metric)?.unit === 's' ? dur(r.totals[o.metric]) : num(r.totals[o.metric]))).join(' · ')}</td>
          <td>{secs(r.total_time_s)}</td>{hasGap && <td>{r.gap_pct == null ? '—' : `${num(r.gap_pct)} %`}</td>}
          {served && <td>{num(r.totals.served)}</td>}{rate && <td>{desc(r, 'service_rate') == null ? '—' : `${desc(r, 'service_rate')} %`}</td>}
          {rate && <td>{desc(r, 'mean_detour_s') == null ? '—' : secs(desc(r, 'mean_detour_s'))}</td>}
          {emissions && <td>{grams(r.domain?.solution_g)}</td>}{emissions && <td>{r.domain?.complete ? `${grams(r.domain.avoided_g)} · ${pct(r.domain.avoided_pct)}` : '—'}</td>}</tr>; })}</tbody></table>
        {emissions && dom && <p className="small muted">CO₂: {dom.scope_definition}. Baseline ({BASELINE_LABEL[dom.baseline]}): {dom.baseline_definition}.</p>}</div>}
      {rows.length > 0 && tab === 'charts' && <Charts metrics={metrics} rows={rows} title={exp.campaign.title} domain={exp.problem.domain_metrics} />}
      {(exp.results?.warnings.length ?? 0) > 0 && <details className="small"><summary>Notes ({exp.results!.warnings.length})</summary>{exp.results!.warnings.map((w) => <p key={w} className="muted">{w}</p>)}</details>}
      <button className="btn sm" onClick={onDetails}>Full comparison report</button>
    </div>
  </div>;
}
