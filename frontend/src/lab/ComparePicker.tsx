import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleX, Columns2, RotateCcw, Scale, ShieldCheck, X } from 'lucide-react';
import { HiddenFilter } from '../components/HiddenFilter';
import { call } from '../api/client';
import { errText } from '../components/common';
import { t } from '../i18n';
import { type Validation, type Verdict } from './api';
import { canCompare, initialSelection, letter, ordered, setReference, toggle, type Selection } from './compareSelection';

export interface Candidate {
  campaign_id: string; title: string; kind: string; owner_display: string; imported: boolean; hidden: boolean; category: string; relation: string;
  methods: string[]; created_at: string; quality: Verdict; runtime: Verdict; emissions: Verdict | null; overall: Verdict; reasons: string[];
  validation: Validation; reproducibility: { applicable: boolean; reproduced?: boolean | null; cells?: number; different?: number; identical?: number };
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

/** Choose exactly the experiments to compare. The current experiment is listed first, ticked, and can be unticked;
 *  any ticked experiment can be made the reference for the deltas. The server lists every executed experiment of the
 *  same problem with its relation to the current one; the three kinds of evidence stay separate for each: independent
 *  validation, reproducibility (only for a re-execution), semantic comparability per claim. Not comparable candidates
 *  are folded and cannot be ticked; hidden records are neither shown nor counted unless the filter asks for them. */
export function ComparePicker({ current, already = [], reference, onClose, onCompare }: {
  current: string; already?: string[]; reference?: string; onClose: () => void; onCompare: (sel: Selection) => void;
}) {
  const [data, setData] = useState<Compatible | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(() => { const s = initialSelection(current, already); return reference ? setReference(s, reference) : s; });
  const [showIncompatible, setShowIncompatible] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => { call<Compatible>(`/lab/compatible?a=${encodeURIComponent(current)}`).then(setData).catch((e) => setErr(errText(e))); }, [current]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const visible = useMemo(() => (data?.candidates ?? []).filter((c) => showHidden || !c.hidden || sel.ids.includes(c.campaign_id)), [data, showHidden, sel.ids]);
  const nIncompatible = visible.filter((c) => c.overall === 'incompatible').length;
  const groups = useMemo(() => GROUPS.map((g) => [g, visible.filter((c) => c.relation === g && (showIncompatible || c.overall !== 'incompatible'))] as const).filter(([, xs]) => xs.length), [visible, showIncompatible]);
  const title = (id: string) => id === current ? data?.a.title ?? id : data?.candidates.find((c) => c.campaign_id === id)?.title ?? id;
  const n = sel.ids.length;
  const refRadio = (id: string) => sel.ids.includes(id) && <label className="row small refpick" title="Deltas are computed against the reference">
    <input type="radio" name="reference" checked={sel.reference === id} onChange={() => setSel(setReference(sel, id))} aria-label={`use ${title(id)} as reference`} />Reference</label>;
  return <div className="overlay" role="dialog" aria-label="compare experiments" onClick={onClose}>
    <div className="drawer wide picker-drawer" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><div className="grow"><h2>{t('cmp.with')}</h2><div className="small muted">{t('cmp.pick')}</div></div>
        <button className="btn icon ghost" aria-label="close" onClick={onClose}><X size={16} /></button></div>
      {err && <p className="note warn" role="alert">{err}</p>}
      {!data && !err && <p className="muted small">Checking comparability…</p>}
      {data && <>
        <div className="row gap small wrap">
          <span className="strong">Comparability with {letterOf(sel, current) ?? 'the current experiment'}</span><span className="badge ok">{ICON.direct} Direct {data.counts.direct}</span><span className="badge warn">{ICON.conditional} With conditions {data.counts.conditional}</span>
          <span className="grow" />
          {nIncompatible > 0 && <label className="row small"><input type="checkbox" checked={showIncompatible} onChange={(e) => setShowIncompatible(e.target.checked)} /> {t('cmp.showIncompatible', { n: nIncompatible })}</label>}
          <HiddenFilter n={data.hidden} on={showHidden} setOn={setShowHidden} />
        </div>
        <div className="evlegend"><span><ShieldCheck size={13} /><b>Validation</b> each solution checked by the validator</span><span><RotateCcw size={13} /><b>Reproducibility</b> same results when re-executed</span><span><Scale size={13} /><b>Comparability</b> whether the numbers may be compared</span></div>
        <div className="cands-scroll">
          <section className="cands"><h4>This experiment</h4>
            <div className={`cand ${sel.ids.includes(current) ? 'sel' : ''}`}>
              <div className="row gap top"><label className="row gap top grow"><input type="checkbox" aria-label={data.a.title} checked={sel.ids.includes(current)} onChange={() => setSel(toggle(sel, current))} />
                <span className="grow"><b>{data.a.title}</b><span className="small muted block">the experiment you opened{letterOf(sel, current) ? ` · column ${letterOf(sel, current)}` : ' · not in the comparison'}</span></span></label>{refRadio(current)}</div>
              <div className="ev"><span className="evk"><ShieldCheck size={13} />Validation</span><span>{data.a.validation.runs ? <><b>{data.a.validation.accepted} of {data.a.validation.runs}</b> runs accepted</> : <span className="muted">not run</span>}</span></div>
            </div></section>
          {groups.length === 0 && <p className="muted">{t('cmp.none')}</p>}
          {groups.map(([g, xs]) => <section key={g} className="cands"><h4>{g}</h4>
          {xs.map((c) => { const dis = c.overall === 'incompatible' && !sel.ids.includes(c.campaign_id); const on = sel.ids.includes(c.campaign_id); return <div key={c.campaign_id} className={`cand ${on ? 'sel' : ''} ${dis ? 'dim' : ''}`}>
            <div className="row gap top"><label className="row gap top grow"><input type="checkbox" aria-label={c.title} disabled={dis} checked={on} onChange={() => setSel(toggle(sel, c.campaign_id))} />
              <span className="grow"><b>{c.title}</b><span className="small muted block">{c.category} · {c.owner_display} · {c.methods.length} method{c.methods.length === 1 ? '' : 's'}{c.hidden ? ' · hidden' : ''}{on ? ` · column ${letterOf(sel, c.campaign_id)}` : ''}</span></span></label>{refRadio(c.campaign_id)}</div>
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
        <div className="row gap drawer-foot"><span className="small muted grow" aria-live="polite">{n} selected{n ? ` · reference ${letterOf(sel, sel.reference)}: ${title(sel.reference)}` : ''}{n === 1 ? ' · tick at least one more' : ''}</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canCompare(sel)} onClick={() => onCompare(sel)}><Columns2 size={14} /> {t('cmp.selected')} ({n})</button></div>
      </>}
    </div>
  </div>;
}

/** The column letter an experiment gets in the comparison (A for the reference), or null when it is not ticked. */
function letterOf(sel: Selection, id: string): string | null {
  const i = ordered(sel).indexOf(id);
  return i < 0 ? null : letter(i);
}
