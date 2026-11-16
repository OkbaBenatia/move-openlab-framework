import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { tr } from '../i18n';
import { scenarioLabel } from './scenarioNames';

interface Named { instance_hash: string; name?: string | null }

/** Scenario navigation shared by the Workspace and the comparisons: an explicit scope ("All N scenarios" or one
 *  scenario by its real name), previous / next, a list, and a search box that jumps to a scenario by name. */
export function ScenarioNav({ scenarios, value, onChange, allowAll = true, compact = false }: {
  scenarios: Named[]; value: number | 'all'; onChange: (k: number | 'all') => void; allowAll?: boolean; compact?: boolean;
}) {
  const n = scenarios.length;
  const [q, setQ] = useState('');
  if (n === 0) return null;
  const labels = scenarios.map((s, i) => scenarioLabel(s, i));
  const k = value === 'all' ? -1 : value;
  const step = (d: number) => onChange(k < 0 ? (d > 0 ? 0 : n - 1) : (k + d + n) % n);
  const jump = (text: string) => {
    setQ(text);
    const want = text.trim().toLowerCase();
    if (!want) return;
    const exact = labels.findIndex((l) => l.toLowerCase() === want);
    const hit = exact >= 0 ? exact : labels.filter((l) => l.toLowerCase().includes(want)).length === 1 ? labels.findIndex((l) => l.toLowerCase().includes(want)) : -1;
    if (hit >= 0) { onChange(hit); setQ(''); }
  };
  if (n <= 6 && !compact) return <div className="seg" role="group" aria-label={tr('scope')}>
    {allowAll && n > 1 && <button className={value === 'all' ? 'on' : ''} aria-pressed={value === 'all'} onClick={() => onChange('all')}>{tr('All {n} scenarios', { n })}</button>}
    {labels.map((l, i) => <button key={scenarios[i].instance_hash} className={value === i ? 'on' : ''} aria-pressed={value === i} title={scenarios[i].name ?? l} onClick={() => onChange(i)}>{l}</button>)}</div>;
  const select = <select aria-label={tr('scenario')} value={k < 0 ? '' : scenarios[k].instance_hash} onChange={(e) => { const i = scenarios.findIndex((s) => s.instance_hash === e.target.value); if (i >= 0) onChange(i); }}>
    {k < 0 && <option value="">{tr('choose a scenario…')}</option>}
    {labels.map((l, i) => <option key={scenarios[i].instance_hash} value={scenarios[i].instance_hash}>{scenarios[i].name && scenarios[i].name !== l ? scenarios[i].name : l}</option>)}</select>;
  const search = n > 8 && <><input className="scenario-search" list="scenario-names" aria-label={tr('search a scenario')} placeholder={tr('Search…')} value={q} onChange={(e) => jump(e.target.value)} size={9} />
    <datalist id="scenario-names">{labels.map((l, i) => <option key={scenarios[i].instance_hash} value={l} />)}</datalist></>;
  const prev = <button className="btn icon sm" aria-label={tr('previous scenario')} title={tr('Previous scenario')} onClick={() => step(-1)}><ChevronLeft size={14} /></button>;
  const next = <button className="btn icon sm" aria-label={tr('next scenario')} title={tr('Next scenario')} onClick={() => step(1)}><ChevronRight size={14} /></button>;
  const pos = <span className="small muted nowrap">{k < 0 ? `${n}` : `${k + 1} / ${n}`}</span>;
  if (compact) return <div className="scenario-nav stacked" role="group" aria-label={tr('scenario navigation')}>{select}<div className="row gap">{prev}{next}{pos}<span className="grow" />{search}</div></div>;
  return <div className="row gap scenario-nav" role="group" aria-label={tr('scenario navigation')}>
    {allowAll && <div className="seg"><button className={value === 'all' ? 'on' : ''} aria-pressed={value === 'all'} onClick={() => onChange('all')} title={tr('Values aggregated over every scenario')}>{tr('All {n} scenarios', { n })}</button>
      <button className={value !== 'all' ? 'on' : ''} aria-pressed={value !== 'all'} onClick={() => onChange(k < 0 ? 0 : k)} title={tr('Values of one scenario')}>{tr('One scenario')}</button></div>}
    {prev}{select}{next}{pos}{search}
  </div>;
}
