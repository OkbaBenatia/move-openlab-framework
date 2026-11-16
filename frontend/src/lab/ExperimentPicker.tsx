import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Database, FlaskConical, Plus, Search, Sigma } from 'lucide-react';
import { HiddenFilter } from '../components/HiddenFilter';
import { KIND } from '../components/common';
import { tr } from '../i18n';
import type { ExpItem, Group } from './api';

const GROUPS: [Group, string][] = [['demo', 'Public mobility demonstration'], ['mine', 'My experiments'], ['imported', 'Imported experiments'],
  ['reproduction', 'Reproductions'], ['benchmark', 'Benchmarks']];
export const ALL_AREAS = '';

const status = (x: ExpItem) => x.status === 'draft' ? <span className="badge">{tr('Draft')}</span>
  : x.validation.runs ? <span className={`badge ${x.validation.accepted === x.validation.runs ? 'ok' : 'warn'}`}>{tr('Validated {n}/{m}', { n: x.validation.accepted, m: x.validation.runs })}</span> : null;

/** The experiment selector: experiments grouped by origin, each with a short context (area, mobility data, scenarios,
 *  problem, methods, status), an area filter (new accounts start on the demonstration area) and hidden records on demand. */
export function ExperimentPicker({ experiments, current, areaFilter, setAreaFilter, onPick, onNew, onLibrary }: {
  experiments: ExpItem[]; current: ExpItem | null; areaFilter: string; setAreaFilter: (a: string) => void;
  onPick: (id: string) => void; onNew: () => void; onLibrary: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState(false);
  const [only, setOnly] = useState<Group | ''>('');
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  const areas = useMemo(() => Array.from(new Set(experiments.map((x) => x.area).filter(Boolean) as string[])).sort(), [experiments]);
  const nHidden = experiments.filter((x) => x.hidden).length;
  const shown = experiments.filter((x) => (hidden || !x.hidden || x.campaign_id === current?.campaign_id)
    && (!areaFilter || x.area === areaFilter || x.synthetic) && (!only || x.group === only)
    && (!q || `${x.title} ${x.area ?? ''} ${x.data ?? ''} ${x.methods.join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  const ctx = (x: ExpItem) => [x.area, x.data && (x.sampled ? `${tr(x.data)} · ${tr('sampled')}` : tr(x.data)), x.scenarios === 1 ? tr('{n} scenario', { n: x.scenarios }) : tr('{n} scenarios', { n: x.scenarios }),
    x.synthetic ? x.problem : null, x.methods.length === 1 ? tr('{n} method', { n: x.methods.length }) : tr('{n} methods', { n: x.methods.length })].filter(Boolean).join(' · ');
  return <div className="picker" ref={ref}>
    <button className="exp-picker" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} data-tour="context">
      <span className="ico"><FlaskConical size={16} /></span>
      <span className="t"><b>{current?.title ?? tr('Choose an experiment')}</b><span>{current ? `${tr(KIND[current.kind] ?? current.kind)}${current.area ? ` · ${current.area}` : ''}` : tr('Public demonstration, your experiments, imports')}</span></span>
      <ChevronDown size={15} /></button>
    {open && <div className="picker-panel" role="listbox" aria-label={tr('experiments')}>
      <div className="row gap"><label className="search grow"><Search size={14} /><input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search experiments')} aria-label={tr('search experiments')} /></label>
        <select aria-label={tr('area filter')} value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)}><option value={ALL_AREAS}>{tr('All areas')}</option>{areas.map((a) => <option key={a} value={a}>{tr('Area: {name}', { name: a })}</option>)}</select></div>
      <div className="row gap">
        <div className="seg" role="group" aria-label={tr('groups')}><button className={only === '' ? 'on' : ''} onClick={() => setOnly('')}>{tr('All')}</button>
          {GROUPS.map(([g, label]) => <button key={g} className={only === g ? 'on' : ''} onClick={() => setOnly(g)}>{tr(g === 'demo' ? 'Demonstration' : label.replace(' experiments', ''))}</button>)}</div>
        <span className="grow" />
        <HiddenFilter n={nHidden} on={hidden} setOn={setHidden} /></div>
      <div className="picker-list">
        {GROUPS.filter(([g]) => !only || only === g).map(([g, label]) => {
          const xs = shown.filter((x) => x.group === g);
          if (g !== 'benchmark' && !xs.length) return null;
          return <section key={g}><h4>{tr(label)}{g === 'demo' && <span className="h4-note">{tr('demand sampled from RPC 2026-10 observed trips · OpenStreetMap')}</span>}</h4>
            {xs.map((x) => <button key={x.campaign_id} role="option" aria-selected={x.campaign_id === current?.campaign_id} className={`pick ${x.campaign_id === current?.campaign_id ? 'on' : ''}`}
              onClick={() => { setOpen(false); onPick(x.campaign_id); }}>
              <span className="ico sm">{x.synthetic ? <Sigma size={14} /> : <FlaskConical size={14} />}</span>
              <span className="grow t"><b>{x.title}</b><span>{ctx(x)}</span></span>
              <span className="row gap chips">{status(x)}<span className="badge outline">{tr(KIND[x.kind] ?? x.kind)}</span>{x.hidden && <span className="badge">{tr('hidden')}</span>}</span>
              {x.campaign_id === current?.campaign_id ? <Check size={15} className="accent" /> : <span style={{ width: 15 }} />}</button>)}
          </section>;
        })}
        {!shown.length && <p className="muted small">{tr('No experiment matches.')} {areaFilter && <button className="btn link small" onClick={() => setAreaFilter(ALL_AREAS)}>{tr('Show all areas')}</button>}</p>}
      </div>
      <div className="row gap picker-foot"><span className="small muted grow">{areaFilter ? tr('Filtered to one area; other areas stay available here.') : tr('All areas.')}</span>
        <button className="btn sm" onClick={() => { setOpen(false); onNew(); }}><Plus size={13} /> {tr('New experiment from saved scenarios')}</button>
        <button className="btn sm" onClick={() => { setOpen(false); onLibrary(); }}><Database size={13} /> {tr('Open the Library')}</button></div>
    </div>}
  </div>;
}
