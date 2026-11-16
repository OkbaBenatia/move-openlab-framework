import { X } from 'lucide-react';
import { useState } from 'react';
import { tr } from '../i18n';
import { defaultIds, ordered, selectAll, selectNone, setGroup, toggleId } from './metricChoice';
import { GROUPS, type MetricDef } from './metrics';

/** "Choose metrics": one dialog with a checkbox per metric, in groups (validation, optimization, ML evaluation,
 *  performance, mobility and CO₂, custom). The choice applies to the Workspace results, both comparisons, the charts and
 *  the exported tables of this problem. A metric the problem cannot provide is listed with the reason; a metric without
 *  data is never shown as zero. */
export function MetricChooser({ defs, chosen, onApply, onClose, unavailable, compact = false, remembered = true }: {
  defs: MetricDef[]; chosen: Set<string>; onApply: (ids: string[], remember: boolean) => void; onClose: () => void; unavailable: (d: MetricDef) => string | null;
  /** The defaults of a narrow results table (the Workspace panel) instead of the full default set. */
  compact?: boolean; remembered?: boolean;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set(chosen));
  const [remember, setRemember] = useState(remembered);
  return <div className="overlay" role="dialog" aria-label={tr('Choose metrics')} onClick={onClose}>
    <div className="drawer metric-chooser" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><h2>{tr('Choose metrics')}</h2><span className="grow" />
        <button className="btn icon" aria-label={tr('close')} onClick={onClose}><X size={15} /></button></div>
      <p className="small muted">{tr('Tick the metrics to show. The same choice applies to the Workspace results, Compare › Methods, Compare › Experiments, the charts and the exported tables of this problem. Hover a metric for its definition and how it is aggregated.')}</p>
      <div className="row gap wrap metric-bulk" role="group" aria-label={tr('selection')}>
        <button className="btn sm" onClick={() => setSel(selectAll(defs))}>{tr('Select all')}</button>
        <button className="btn sm" onClick={() => setSel(selectNone())}>{tr('Deselect all')}</button>
        <button className="btn sm" onClick={() => setSel(new Set(defaultIds(defs, compact)))}>{tr('Reset to defaults')}</button>
        <span className="grow" /><span className="small muted" aria-live="polite">{tr('{n} of {m} selected', { n: sel.size, m: defs.length })}</span></div>
      {GROUPS.map(([g, label]) => { const list = defs.filter((d) => d.group === g); if (!list.length) return null;
        return <fieldset key={g} className="metric-group"><legend>{tr(label)}</legend>
          <div className="row gap small metric-group-actions"><button className="btn link" onClick={() => setSel((s) => setGroup(s, defs, g, true))}>{tr('all')}</button>
            <button className="btn link" onClick={() => setSel((s) => setGroup(s, defs, g, false))}>{tr('none')}</button></div>
          {list.map((d) => { const why = unavailable(d);
            return <label key={d.id} className={`row metric-choice ${why ? 'unsupported' : ''}`} title={[d.help, `${tr('Aggregation')}: ${d.basis('all')}`].filter(Boolean).join('\n')}>
              <input type="checkbox" checked={sel.has(d.id)} onChange={() => setSel((s) => toggleId(s, d.id))} aria-label={d.label} />
              <span className="grow">{d.label}{d.unit && d.unit !== '%' ? <span className="muted"> ({d.unit})</span> : null}
                {why && <span className="tiny warn-text block">{tr(why)}</span>}</span></label>; })}</fieldset>; })}
      <label className="row gap small remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>{tr('Keep this choice for my account')}<span className="muted block tiny">{tr('Otherwise it applies until you close this browser tab.')}</span></span></label>
      <div className="row gap drawer-foot">{sel.size === 0 && <span className="small warn-text" role="status">{tr('Select at least one metric.')}</span>}<span className="grow" />
        <button className="btn" onClick={onClose}>{tr('Cancel')}</button>
        <button className="btn primary" disabled={sel.size === 0} onClick={() => onApply(ordered(defs, sel), remember)}>{tr('Apply')}</button></div>
    </div>
  </div>;
}
