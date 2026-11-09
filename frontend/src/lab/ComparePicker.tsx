import { useEffect, useMemo, useState } from 'react';
import { Columns2, X } from 'lucide-react';
import { call } from '../api/client';
import { errText } from '../components/common';
import { VERDICT, type Verdict } from './api';

export interface Candidate {
  campaign_id: string; title: string; kind: string; owner_display: string; imported: boolean; hidden: boolean; category: string; relation: string;
  methods: string[]; created_at: string; quality: Verdict; runtime: Verdict; emissions: Verdict | null; overall: Verdict; reasons: string[];
}
interface Compatible { a: { campaign_id: string; title: string }; candidates: Candidate[]; counts: Record<Verdict, number> }

const GROUPS = ['Reproduction', 'Controlled variant', 'Extension', 'Reproduction (parent)', 'Controlled variant (parent)', 'Extension (parent)', 'Same scenario', 'Same problem, other file', 'Different scenario', 'Derived'];

/** Choose what to compare experiment A with: the server lists every executed experiment of the same problem with its
 *  relation to A and the verdicts of the semantic engine; directly and conditionally comparable candidates are shown
 *  first, incompatible ones under a fold and cannot be selected. */
export function ComparePicker({ a, onClose, onCompare }: { a: string; onClose: () => void; onCompare: (ids: string[]) => void }) {
  const [data, setData] = useState<Compatible | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [showIncompatible, setShowIncompatible] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => { call<Compatible>(`/lab/compatible?a=${encodeURIComponent(a)}`).then(setData).catch((e) => setErr(errText(e))); }, [a]);
  const groups = useMemo(() => {
    const cs = (data?.candidates ?? []).filter((c) => (showHidden || !c.hidden) && (showIncompatible || c.overall !== 'incompatible'));
    return GROUPS.map((g) => [g, cs.filter((c) => c.relation === g)] as const).filter(([, xs]) => xs.length);
  }, [data, showIncompatible, showHidden]);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const chip = (v: Verdict | null, label: string) => v && <span className={`badge ${VERDICT[v].cls}`} title={label}>{label}: {VERDICT[v].label.toLowerCase()}</span>;
  return <div className="overlay" role="dialog" aria-label="choose experiments to compare" onClick={onClose}>
    <div className="drawer wide" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><h2>Compare with…</h2>{data && <span className="muted small">A = {data.a.title}</span>}<span className="grow" />
        <button className="btn icon" aria-label="close" onClick={onClose}><X size={15} /></button></div>
      {err && <p className="note warn" role="alert">{err}</p>}
      {!data && !err && <p className="muted small">Checking compatibility…</p>}
      {data && <>
        <div className="row gap small">
          <span className="badge ok">{data.counts.direct} directly comparable</span><span className="badge warn">{data.counts.conditional} with conditions</span>
          <span className="grow" />
          {data.counts.incompatible > 0 && <label className="row small"><input type="checkbox" checked={showIncompatible} onChange={(e) => setShowIncompatible(e.target.checked)} /> Show incompatible ({data.counts.incompatible})</label>}
          {data.candidates.some((c) => c.hidden) && <label className="row small"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden</label>}
        </div>
        {groups.length === 0 && <p className="muted">No comparable experiment yet. Reproduce this experiment, extend it with a method, or create a controlled variant.</p>}
        {groups.map(([g, xs]) => <section key={g} className="cands"><h3>{g}</h3>
          <ul className="cards" aria-label={g}>{xs.map((c) => { const dis = c.overall === 'incompatible'; return <li key={c.campaign_id} className={`card-row ${picked.includes(c.campaign_id) ? 'hl' : ''} ${dis ? 'dim' : ''}`}>
            <label className="row gap"><input type="checkbox" aria-label={c.title} disabled={dis} checked={picked.includes(c.campaign_id)} onChange={() => toggle(c.campaign_id)} />
              <span className="grow"><b>{c.title}</b><span className="muted small"> · {c.category} · {c.owner_display}{c.hidden ? ' · hidden' : ''}</span>
                <div className="row gap chips">{chip(c.quality, 'results')}{chip(c.runtime, 'runtime')}{chip(c.emissions, 'CO₂')}
                  {c.reasons.length > 0 && <button className="btn link small" type="button" onClick={() => setWhy(why === c.campaign_id ? null : c.campaign_id)}>Why?</button>}</div>
                {why === c.campaign_id && <ul className="small muted reasons">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}</span></label></li>; })}</ul>
        </section>)}
        <div className="row gap"><span className="grow" /><button className="btn primary" disabled={!picked.length} onClick={() => onCompare(picked)}><Columns2 size={14} /> Compare selected{picked.length > 1 ? ` (${picked.length})` : ''}</button></div>
      </>}
    </div>
  </div>;
}
