import { Car, CheckCircle2, CircleDashed, ExternalLink, User } from 'lucide-react';
import type { Json } from '../api/client';
import { KIND } from '../components/common';
import { hhmm } from '../geo/api';
import type { Experiment } from './api';

export function ExperimentBadges({ exp }: { exp: Experiment }) {
  const c = exp.campaign;
  return <div className="row gap badges">
    <span className="badge">{KIND[c.kind] ?? c.kind}</span>
    {c.imported && <span className="badge warn">Imported{c.imported_from ? ` from ${c.imported_from}` : ''}</span>}
    {exp.reproduction && <span className={`badge ${exp.reproduction.reproduced ? 'ok' : 'bad'}`}>{exp.reproduction.reproduced ? 'Reproduced ✓' : 'Not reproduced'}</span>}
    {c.locked ? <span className="badge ok">Locked</span> : <span className="badge">{c.status}</span>}
  </div>;
}

/** Left panel: the experiment, its Area + Dataset + Scenario context, and the participants of one scenario. */
export function ScenarioPanel({ exp, hash, setHash, inst, plan, onFocus, onDetails, parentTitle }: {
  exp: Experiment; hash: string; setHash: (h: string) => void; inst: Json | null; plan: Json | null;
  onFocus: (lat: number, lon: number) => void; onDetails: () => void; parentTitle: string | null;
}) {
  const served = new Set<string>((plan?.vehicles ?? []).filter((v: Json) => v.rider).map((v: Json) => v.rider));
  const matched = new Map<string, string>((plan?.vehicles ?? []).filter((v: Json) => v.rider).map((v: Json) => [v.driver, v.rider]));
  const ctx = exp.context;
  const prov = inst?.provenance ?? {};
  return <div className="panel-body">
    <div className="card">
      <h2 className="title">{exp.campaign.title}</h2>
      <ExperimentBadges exp={exp} />
      {exp.campaign.parent && <p className="small muted">{exp.campaign.parent.relation === 'perturbs' ? 'Variant of' : exp.campaign.parent.relation === 'reproduces' ? 'Re-execution of' : 'Extends'} {parentTitle ?? 'its parent experiment'}{exp.campaign.variant ? ` — ${exp.campaign.variant}` : ''}</p>}
      <p className="context" aria-label="area, dataset and scenario"><b>{ctx.area.label ?? 'No area'}</b> · {ctx.dataset ?? 'no dataset'} · {ctx.scenario}</p>
    </div>
    {exp.scenarios.length > 1 && <label className="row small">Scenario <select aria-label="scenario" value={hash} onChange={(e) => setHash(e.target.value)} className="grow">
      {exp.scenarios.map((s) => <option key={s.instance_hash} value={s.instance_hash}>{s.name ?? s.instance_id}</option>)}</select></label>}
    {inst?.drivers && <>
      <div className="row gap small muted"><span><Car size={12} /> {inst.drivers.length} drivers</span><span><User size={12} /> {inst.riders.length} riders</span>
        {plan && <span><CheckCircle2 size={12} /> {served.size} served</span>}</div>
      <ul className="people" aria-label="participants">
        {(inst.drivers as Json[]).map((d) => <li key={d.id}><button onClick={() => onFocus(d.origin[0], d.origin[1])}>
          <Car size={12} className="drv" /> <b>{d.id}</b> <span className="muted">{hhmm(d.earliest)}–{hhmm(d.latest)}</span>
          {plan && <span className="grow right small">{matched.get(d.id) ? `carries ${matched.get(d.id)}` : <span className="muted">alone</span>}</span>}</button></li>)}
        {(inst.riders as Json[]).map((r) => <li key={r.id}><button onClick={() => onFocus(r.origin[0], r.origin[1])}>
          <User size={12} className="rdr" /> <b>{r.id}</b> <span className="muted">{hhmm(r.earliest)}–{hhmm(r.latest)}</span>
          {plan && <span className="grow right small">{served.has(r.id) ? <span className="ok-text"><CheckCircle2 size={11} /> served</span> : <span className="bad-text"><CircleDashed size={11} /> unserved</span>}</span>}</button></li>)}
      </ul></>}
    <details className="small">
      <summary>Details</summary>
      <dl className="facts">
        {prov.attribution && <><dt>Data</dt><dd>{prov.attribution}</dd></>}
        {inst?.network && <><dt>Road network</dt><dd>{inst.network.attribution} ({inst.network.licence}) · OSM data {inst.network.osm_timestamp ?? 'n/a'} · {inst.network.travel_model}</dd></>}
        {prov.seed != null && <><dt>Sampling</dt><dd>seed {prov.seed}{prov.window ? ` · ${hhmm(prov.window[0])}–${hhmm(prov.window[1])}` : ''}{prov.method ? ` · ${prov.method}` : ''}</dd></>}
        {inst?.params && <><dt>Limits</dt><dd>detour ≤ {Math.round(inst.params.max_detour_s / 60)} min and ≤ {Math.round(100 * inst.params.max_detour_ratio)} % of the direct trip</dd></>}
        <dt>Researcher</dt><dd>{exp.campaign.owner_display}</dd>
        <dt>Identifiers</dt><dd className="mono wrap-anywhere">{exp.campaign.campaign_id}<br />{hash}</dd>
      </dl>
      <button className="btn sm" onClick={onDetails}><ExternalLink size={12} /> Full record</button>
    </details>
  </div>;
}

/** Left panel when starting a new experiment: scenarios of the scenario library, filtered by the selected area. */
export function NewExperimentPanel({ lib, picked, setPicked, title, setTitle, onGenerate }: {
  lib: Json[]; picked: string[]; setPicked: (h: string[]) => void; title: string; setTitle: (t: string) => void; onGenerate: () => void;
}) {
  const toggle = (h: string) => setPicked(picked.includes(h) ? picked.filter((x) => x !== h) : [...picked, h]);
  return <div className="panel-body">
    <div className="card"><h2 className="title">New experiment</h2>
      <label className="small">Name <input aria-label="experiment name" value={title} onChange={(e) => setTitle(e.target.value)} className="full" /></label></div>
    <h3>Scenarios</h3>
    {lib.length === 0 ? <p className="small muted">No scenario yet. <button className="btn sm" onClick={onGenerate}>Generate one</button></p> :
      <ul className="people" aria-label="scenarios">{lib.map((s) => <li key={s.instance_hash}><label className="row">
        <input type="checkbox" aria-label={s.name} checked={picked.includes(s.instance_hash)} onChange={() => toggle(s.instance_hash)} />
        <span className="grow"><b>{s.name}</b><br /><span className="muted small">{s.drivers} drivers · {s.riders} riders · {s.source}</span></span></label></li>)}</ul>}
  </div>;
}
