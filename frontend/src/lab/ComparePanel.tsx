import { useState } from 'react';
import { BarChart3, Columns2, Table2, X } from 'lucide-react';
import { secs, num } from '../components/common';
import { dur } from '../geo/api';
import { tr } from '../i18n';
import { BASELINE_LABEL, SCOPE_LABEL, grams, pct, sameEmissionSemantics } from '../mobility/api';
import { Charts, rowLabel } from './Charts';
import type { Experiment, ResultRow } from './api';

export const statusOf = (r: ResultRow) => !r.valid ? { label: tr('Invalid'), cls: 'bad' }
  : r.proven_optimal === r.scenarios ? { label: tr('Proven optimal'), cls: 'ok' }
  : r.proven_optimal > 0 ? { label: tr('Proven optimal {n}/{m}', { n: r.proven_optimal, m: r.scenarios }), cls: 'ok' }
  // a hybrid (learned candidate reduction + exact solver) proves at most optimality of the model it reduced
  : r.kind === 'hybrid' && (r.reduced_optimal ?? 0) > 0 ? { label: tr('Optimal on reduced model {n}/{m}', { n: r.reduced_optimal ?? 0, m: r.scenarios }), cls: 'warn' }
  : r.kind === 'exact' || r.kind === 'hybrid' ? { label: tr('Not proven'), cls: 'warn' } : { label: tr('Heuristic'), cls: '' };

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
  return <div className="overlay" role="dialog" aria-label={tr('compare methods')} onClick={onClose}>
    <div className="drawer wide" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><h2>{tr('Compare methods')}</h2><span className="muted small">{exp.campaign.title}</span><span className="grow" />
        <button className="btn icon" aria-label={tr('close')} onClick={onClose}><X size={15} /></button></div>
      <nav className="subtabs" aria-label={tr('comparison views')}>
        <button className={`btn sm ${tab === 'table' ? 'primary' : ''}`} onClick={() => setTab('table')}><Table2 size={12} /> {tr('Table')}</button>
        <button className={`btn sm ${tab === 'charts' ? 'primary' : ''}`} onClick={() => setTab('charts')}><BarChart3 size={12} /> {tr('Charts')}</button>
        <span className="grow" />
        <button className="btn sm" onClick={onPick}><Columns2 size={12} /> {tr('Compare with other experiments…')}</button></nav>
      {rows.length === 0 && <p className="muted">{tr('Run the experiment to compare its methods.')}</p>}
      {rows.length > 0 && tab === 'table' && <div className="table-scroll"><table aria-label={tr('method comparison')}>
        <thead><tr><th>{tr('Method')}</th><th>{tr('Status')}</th><th title={exp.problem.objective.map((o) => `${o.sense} ${o.metric}`).join(tr(', then '))}>{tr('Objective')}</th>
          <th>{tr('Runtime')}</th>{hasGap && <th title={tr('relative gap on the last objective level, where every earlier level equals the exact reference')}>{tr('Gap')}</th>}
          {served && <th>{tr(served.label)}</th>}{rate && <th>{tr('Service rate')}</th>}{rate && <th>{tr('Mean detour')}</th>}
          {emissions && <th title={`${tr(SCOPE_LABEL[dom!.scope] ?? dom!.scope)} · ${tr('baseline: {baseline}', { baseline: tr(BASELINE_LABEL[dom!.baseline] ?? dom!.baseline) })}`}>CO₂</th>}{emissions && <th>{tr('Avoided CO₂')}</th>}</tr></thead>
        <tbody>{rows.map((r) => { const st = statusOf(r); return <tr key={r.method_id + r.campaign_id} className={r.campaign_kind === 'extended' ? 'hl' : ''}>
          <td><b>{rowLabel(r, rows)}</b></td><td><span className={`badge ${st.cls}`}>{st.label}</span></td>
          <td>{exp.problem.objective.map((o) => (metrics.find((m) => m.id === o.metric)?.unit === 's' ? dur(r.totals[o.metric]) : num(r.totals[o.metric]))).join(' · ')}</td>
          <td>{secs(r.total_time_s)}</td>{hasGap && <td>{r.gap_pct == null ? '—' : `${num(r.gap_pct)} %`}</td>}
          {served && <td>{num(r.totals.served)}</td>}{rate && <td>{desc(r, 'service_rate') == null ? '—' : `${desc(r, 'service_rate')} %`}</td>}
          {rate && <td>{desc(r, 'mean_detour_s') == null ? '—' : secs(desc(r, 'mean_detour_s'))}</td>}
          {emissions && <td>{grams(r.domain?.solution_g)}</td>}{emissions && <td>{r.domain?.complete ? `${grams(r.domain.avoided_g)} · ${pct(r.domain.avoided_pct)}` : '—'}</td>}</tr>; })}</tbody></table>
        {emissions && dom && <p className="small muted">{tr('CO₂: {scope}. Baseline ({label}): {definition}.', { scope: dom.scope_definition ?? '', label: tr(BASELINE_LABEL[dom.baseline] ?? dom.baseline), definition: dom.baseline_definition ?? '' })}</p>}</div>}
      {rows.length > 0 && tab === 'charts' && <Charts metrics={metrics} rows={rows} title={exp.campaign.title} domain={exp.problem.domain_metrics} />}
      {(exp.results?.warnings.length ?? 0) > 0 && <details className="small"><summary>{tr('Notes ({n})', { n: exp.results!.warnings.length })}</summary>{exp.results!.warnings.map((w) => <p key={w} className="muted">{w}</p>)}</details>}
      <button className="btn sm" onClick={onDetails}>{tr('Full comparison report')}</button>
    </div>
  </div>;
}
