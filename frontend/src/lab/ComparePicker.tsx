import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleX, Columns2, RotateCcw, Scale, ShieldCheck, X } from 'lucide-react';
import { call } from '../api/client';
import { errText } from '../components/common';
import { t } from '../i18n';
import { type Validation, type Verdict } from './api';

export interface Candidate {
  campaign_id: string; title: string; kind: string; owner_display: string; imported: boolean; hidden: boolean; category: string; relation: string;
  methods: string[]; created_at: string; quality: Verdict; runtime: Verdict; emissions: Verdict | null; overall: Verdict; reasons: string[];
  validation: Validation; reproducibility: { applicable: boolean; reproduced?: boolean | null; cells?: number; different?: number };
}
interface Compatible { a: { campaign_id: string; title: string; validation: Validation }; candidates: Candidate[]; counts: Record<Verdict, number>; hidden: number }

const GROUPS = ['Reproduction', 'Controlled variant', 'Extension', 'Reproduction (parent)', 'Controlled variant (parent)', 'Extension (parent)', 'Same scenario', 'Same problem, other file', 'Different scenario', 'Derived'];
const ICON = { direct: <CheckCircle2 size={13} />, conditional: <AlertTriangle size={13} />, incompatible: <CircleX size={13} /> };
const CLS = { direct: 'ok', conditional: 'warn', incompatible: 'bad' };

const reproText = (c: Candidate) => {
  const r = c.reproducibility;
  if (!r.applicable) return <span className="muted">{c.relation.startsWith('Controlled variant') ? t('ev.na.variant') : c.relation.startsWith('Extension') ? t('ev.na.extension') : t('ev.na.other')}</span>;
  if (r.reproduced == null) return <span className="muted">re-execution not analysed yet</span>;
  return r.reproduced ? <b className="ok-text">{t('ev.reproduced')}: {r.cells} of {r.cells} results equal</b> : <b className="bad-text">{r.different} of {r.cells} results differ</b>;
};

/** Choose what to compare experiment A with. The server lists every executed experiment of the same problem with its
 *  relation to A; for each, the three kinds of evidence stay separate: independent validation of its solutions,
 *  reproducibility (only for a re-execution), semantic comparability per claim. Not comparable candidates are folded
 *  and cannot be selected; hidden records are neither shown nor counted unless asked for. */
export function ComparePicker({ a, onClose, onCompare }: { a: string; onClose: () => void; onCompare: (ids: string[]) => void }) {
  const [data, setData] = useState<Compatible | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [showIncompatible, setShowIncompatible] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => { call<Compatible>(`/lab/compatible?a=${encodeURIComponent(a)}`).then(setData).catch((e) => setErr(errText(e))); }, [a]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const visible = useMemo(() => (data?.candidates ?? []).filter((c) => showHidden || !c.hidden), [data, showHidden]);
  const nIncompatible = visible.filter((c) => c.overall === 'incompatible').length;
  const groups = useMemo(() => GROUPS.map((g) => [g, visible.filter((c) => c.relation === g && (showIncompatible || c.overall !== 'incompatible'))] as const).filter(([, xs]) => xs.length), [visible, showIncompatible]);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  return <div className="overlay" role="dialog" aria-label={t('cmp.with')} onClick={onClose}>
    <div className="drawer wide picker-drawer" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><div className="grow"><h2>{t('cmp.with')}</h2>{data && <div className="small muted">Experiment A · {data.a.title}</div>}</div>
        <button className="btn icon ghost" aria-label="close" onClick={onClose}><X size={16} /></button></div>
      {err && <p className="note warn" role="alert">{err}</p>}
      {!data && !err && <p className="muted small">Checking comparability…</p>}
      {data && <>
        <div className="row gap small wrap">
          <span className="strong">Comparability</span><span className="badge ok">{ICON.direct} Direct {data.counts.direct}</span><span className="badge warn">{ICON.conditional} With conditions {data.counts.conditional}</span>
          <span className="grow" />
          {nIncompatible > 0 && <label className="row small"><input type="checkbox" checked={showIncompatible} onChange={(e) => setShowIncompatible(e.target.checked)} /> {t('cmp.showIncompatible', { n: nIncompatible })}</label>}
          {data.hidden > 0 && <label className="row small"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> {t('cmp.showHidden', { n: data.hidden })}</label>}
        </div>
        <div className="evlegend"><span><ShieldCheck size={13} /><b>Validation</b> each solution checked by the validator</span><span><RotateCcw size={13} /><b>Reproducibility</b> same results when re-executed</span><span><Scale size={13} /><b>Comparability</b> whether the numbers may be compared</span></div>
        {groups.length === 0 && <p className="muted">{t('cmp.none')}</p>}
        <div className="cands-scroll">{groups.map(([g, xs]) => <section key={g} className="cands"><h4>{g}</h4>
          {xs.map((c) => { const dis = c.overall === 'incompatible'; const on = picked.includes(c.campaign_id); return <div key={c.campaign_id} className={`cand ${on ? 'sel' : ''} ${dis ? 'dim' : ''}`}>
            <label className="row gap top"><input type="checkbox" aria-label={c.title} disabled={dis} checked={on} onChange={() => toggle(c.campaign_id)} />
              <span className="grow"><b>{c.title}</b><span className="small muted block">{c.category} · {c.owner_display} · {c.methods.length} method{c.methods.length === 1 ? '' : 's'}{c.hidden ? ' · hidden' : ''}</span></span></label>
            <div className="ev">
              <span className="evk"><ShieldCheck size={13} />Validation</span><span>{c.validation.runs ? <><b>{c.validation.accepted} of {c.validation.runs}</b> runs accepted</> : <span className="muted">not run</span>}</span>
              <span className="evk"><RotateCcw size={13} />Reproducibility</span><span>{reproText(c)}</span>
              <span className="evk"><Scale size={13} />Comparability</span><span className="row gap wrap">
                <span className={`badge ${CLS[c.quality]}`}>{ICON[c.quality]}Results</span><span className={`badge ${CLS[c.runtime]}`}>{ICON[c.runtime]}Runtime</span>
                {c.emissions && <span className={`badge ${CLS[c.emissions]}`}>{ICON[c.emissions]}CO₂</span>}
                {c.reasons.length > 0 && <button className="btn link small" type="button" aria-expanded={why === c.campaign_id} onClick={() => setWhy(why === c.campaign_id ? null : c.campaign_id)}>{t('ev.why')}</button>}</span>
            </div>
            {why === c.campaign_id && <ul className="note small reasons">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          </div>; })}</section>)}</div>
        <div className="row gap drawer-foot"><span className="small muted grow">{picked.length} selected</span><button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!picked.length} onClick={() => onCompare(picked)}><Columns2 size={14} /> {t('cmp.selected')}{picked.length > 1 ? ` (${picked.length})` : ''}</button></div>
      </>}
    </div>
  </div>;
}
