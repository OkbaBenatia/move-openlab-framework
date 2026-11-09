import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Database, EyeOff, FlaskConical, Plus, Search, Sigma } from 'lucide-react';
import { KIND } from '../components/common';
import type { ExpItem, Group } from './api';

const GROUPS: [Group, string][] = [['demo', 'Public mobility demonstration'], ['mine', 'My experiments'], ['imported', 'Imported experiments'],
  ['reproduction', 'Reproductions'], ['benchmark', 'Benchmarks']];
export const ALL_AREAS = '';

const status = (x: ExpItem) => x.status === 'draft' ? <span className="badge">Draft</span>
  : x.validation.runs ? <span className={`badge ${x.validation.accepted === x.validation.runs ? 'ok' : 'warn'}`}>Validated {x.validation.accepted}/{x.validation.runs}</span> : null;

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
  const ctx = (x: ExpItem) => [x.area, x.data && (x.sampled ? `${x.data} · sampled` : x.data), `${x.scenarios} scenario${x.scenarios === 1 ? '' : 's'}`,
    x.synthetic ? x.problem : null, `${x.methods.length} method${x.methods.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  return <div className="picker" ref={ref}>
    <button className="exp-picker" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} data-tour="context">
      <span className="ico"><FlaskConical size={16} /></span>
      <span className="t"><b>{current?.title ?? 'Choose an experiment'}</b><span>{current ? `${KIND[current.kind] ?? current.kind}${current.area ? ` · ${current.area}` : ''}` : 'Public demonstration, your experiments, imports'}</span></span>
      <ChevronDown size={15} /></button>
    {open && <div className="picker-panel" role="listbox" aria-label="experiments">
      <div className="row gap"><label className="search grow"><Search size={14} /><input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search experiments" aria-label="search experiments" /></label>
        <select aria-label="area filter" value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)}><option value={ALL_AREAS}>All areas</option>{areas.map((a) => <option key={a} value={a}>Area: {a}</option>)}</select></div>
      <div className="row gap">
        <div className="seg" role="group" aria-label="groups"><button className={only === '' ? 'on' : ''} onClick={() => setOnly('')}>All</button>
          {GROUPS.map(([g, label]) => <button key={g} className={only === g ? 'on' : ''} onClick={() => setOnly(g)}>{g === 'demo' ? 'Demonstration' : label.replace(' experiments', '')}</button>)}</div>
        <span className="grow" />
        {nHidden > 0 && <label className="row small muted"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /><EyeOff size={13} /> Show hidden ({nHidden})</label>}</div>
      <div className="picker-list">
        {GROUPS.filter(([g]) => !only || only === g).map(([g, label]) => {
          const xs = shown.filter((x) => x.group === g);
          if (g !== 'benchmark' && !xs.length) return null;
          return <section key={g}><h4>{label}{g === 'demo' && <span className="h4-note">demand sampled from RPC 2026-10 observed trips · OpenStreetMap</span>}</h4>
            {xs.map((x) => <button key={x.campaign_id} role="option" aria-selected={x.campaign_id === current?.campaign_id} className={`pick ${x.campaign_id === current?.campaign_id ? 'on' : ''}`}
              onClick={() => { setOpen(false); onPick(x.campaign_id); }}>
              <span className="ico sm">{x.synthetic ? <Sigma size={14} /> : <FlaskConical size={14} />}</span>
              <span className="grow t"><b>{x.title}</b><span>{ctx(x)}</span></span>
              <span className="row gap chips">{status(x)}<span className="badge outline">{KIND[x.kind] ?? x.kind}</span>{x.hidden && <span className="badge">hidden</span>}</span>
              {x.campaign_id === current?.campaign_id ? <Check size={15} className="accent" /> : <span style={{ width: 15 }} />}</button>)}
            {g === 'benchmark' && <div className="pick planned" aria-disabled="true"><span className="ico sm"><Sigma size={14} /></span>
              <span className="grow t"><b>Synthetic scientific benchmark</b><span>Appears here once a reproducible version is integrated · no map · never mixed with the demonstration</span></span>
              <span className="tag-planned">Planned</span></div>}
          </section>;
        })}
        {!shown.length && <p className="muted small">No experiment matches. {areaFilter && <button className="btn link small" onClick={() => setAreaFilter(ALL_AREAS)}>Show all areas</button>}</p>}
      </div>
      <div className="row gap picker-foot"><span className="small muted grow">{areaFilter ? 'Filtered to one area; other areas stay available here.' : 'All areas.'}</span>
        <button className="btn sm" onClick={() => { setOpen(false); onNew(); }}><Plus size={13} /> New experiment from saved scenarios</button>
        <button className="btn sm" onClick={() => { setOpen(false); onLibrary(); }}><Database size={13} /> Open the Library</button></div>
    </div>}
  </div>;
}
