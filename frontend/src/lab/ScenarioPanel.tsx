import { useState } from 'react';
import { Car, CheckCircle2, ChevronDown, CircleDashed, Database, ExternalLink, Eye, EyeOff, Fuel, Layers, MapPin, Play, Route, User, Zap } from 'lucide-react';
import type { Json } from '../api/client';
import { KIND } from '../components/common';
import { hhmm } from '../geo/api';
import { t } from '../i18n';
import { BASELINE_LABEL, POWERTRAIN_LABEL, SCOPE_LABEL } from '../mobility/api';
import type { Experiment } from './api';

export function ExperimentBadges({ exp }: { exp: Experiment }) {
  const c = exp.campaign;
  return <div className="row gap badges">
    <span className="badge info">{KIND[c.kind] ?? c.kind}</span>
    {c.category === 'Demo' && <span className="badge outline">Public demonstration</span>}
    {c.category === 'Imported' && <span className="badge outline">Imported{c.imported_from ? ` from ${c.imported_from}` : ''}</span>}
    {exp.reproduction && <span className={`badge ${exp.reproduction.reproduced ? 'ok' : 'bad'}`}>{exp.reproduction.reproduced ? t('ev.reproduced') : t('ev.notReproduced')}</span>}
    {c.locked && <span className="badge">Locked</span>}
    {!c.locked && c.status !== 'completed' && <span className="badge">{c.status === 'draft' ? 'Draft' : c.status}</span>}
  </div>;
}

function Ctx({ icon, k, v, d, extra }: { icon: React.ReactNode; k: string; v: React.ReactNode; d?: React.ReactNode; extra?: React.ReactNode }) {
  return <div className="ctx-row"><span className="ci">{icon}</span><div className="grow"><div className="k">{k}</div><div className="v">{v}</div>{d && <div className="d">{d}</div>}{extra}</div></div>;
}

/** Left panel: the experiment, then Area · Road network · Mobility data (the source) · Scenario (the demand derived from
 *  it) on separate lines, then the participants and vehicles of the scenario shown on the map. */
export function ScenarioPanel({ exp, hash, setHash, inst, plan, onFocus, onDetails, parentTitle, hidden, onHide }: {
  exp: Experiment; hash: string; setHash: (h: string) => void; inst: Json | null; plan: Json | null;
  onFocus: (lat: number, lon: number) => void; onDetails: () => void; parentTitle: string | null; hidden: boolean; onHide: () => void;
}) {
  const [who, setWho] = useState<'drivers' | 'riders'>('drivers');
  const served = new Set<string>((plan?.vehicles ?? []).filter((v: Json) => v.rider).map((v: Json) => v.rider));
  const matched = new Map<string, string>((plan?.vehicles ?? []).filter((v: Json) => v.rider).map((v: Json) => [v.driver, v.rider]));
  const ctx = exp.context, pv = exp.provenance;
  const prov = inst?.provenance ?? {};
  const k = Math.max(0, exp.scenarios.findIndex((s) => s.instance_hash === hash));
  const sc = exp.scenarios[k];
  const vehicles = sc?.vehicles ?? null;
  const emis = sc?.emissions ?? exp.campaign.emissions;
  const net = inst?.network;
  const network = net ? 'OpenStreetMap' : ctx.area.network_id ? 'OpenStreetMap' : null;
  const netDetail = net?.osm_timestamp ? `extract of ${new Date(net.osm_timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}${net.profile_label ? ` · ${net.profile_label}` : ''}` : null;
  const source = pv.source === 'open-data' ? `RPC ${pv.release ?? ''} observed trips`.replace('  ', ' ') : pv.source === 'dataset' ? (ctx.dataset ?? 'Uploaded trips') : pv.source === 'generator' ? 'Synthetic demand' : pv.source === 'editor' ? 'Placed on the map' : (ctx.dataset ?? '—');
  const sourceDetail = pv.source === 'open-data' ? [pv.observed_trips != null ? `${pv.observed_trips} trips in the area` : null, 'not used one-to-one'].filter(Boolean).join(' · ')
    : pv.source === 'dataset' ? 'uploaded file · not used one-to-one' : pv.source === 'generator' ? 'random trips on the road network' : null;
  const derived = pv.sampled ? `drawn from the observed trips · sample ${k + 1} of ${exp.scenarios.length}${sc?.seed != null ? ` (seed ${sc.seed})` : ''}`
    : pv.source === 'generator' ? `seeded synthetic demand · scenario ${k + 1} of ${exp.scenarios.length}${sc?.seed != null ? ` (seed ${sc.seed})` : ''}` : `scenario ${k + 1} of ${exp.scenarios.length}`;
  const people: Json[] = who === 'drivers' ? inst?.drivers ?? [] : inst?.riders ?? [];
  const fleetCount = (pt: string[]) => (vehicles?.fleet ?? []).filter((f) => pt.includes(f.powertrain)).reduce((n, f) => n + f.drivers, 0);
  return <div className="panel-body">
    <section className="sec">
      <span className="eyebrow">{t('ws.experiment')}</span>
      <h2 className="title">{exp.campaign.title}</h2>
      <ExperimentBadges exp={exp} />
      {exp.campaign.parent && <p className="small muted">{exp.campaign.parent.relation === 'perturbs' ? 'Controlled variant of' : exp.campaign.parent.relation === 'reproduces' ? 'Re-execution of' : 'Extends'} {parentTitle ?? 'its parent experiment'}{exp.campaign.variant ? ` — ${exp.campaign.variant}` : ''}</p>}
    </section>
    <section className="sec ctx" aria-label="area, road network, mobility data and scenario">
      <Ctx icon={<MapPin size={15} />} k={t('ws.area')} v={ctx.area.label ?? '—'} />
      <Ctx icon={<Route size={15} />} k={t('ws.network')} v={network ?? '—'} d={netDetail} />
      <Ctx icon={<Database size={15} />} k={pv.sampled ? t('ws.dataSource') : 'Mobility data'} v={source} d={sourceDetail} />
      <Ctx icon={<Layers size={15} />} k={pv.sampled ? t('ws.scenarioSampled') : t('ws.scenario')}
        v={exp.scenarios.length > 1 ? <span className="sel-inline"><select aria-label="scenario" value={hash} onChange={(e) => setHash(e.target.value)}>
          {exp.scenarios.map((s) => <option key={s.instance_hash} value={s.instance_hash}>{s.name ?? s.instance_id}</option>)}</select><ChevronDown size={13} /></span> : (sc?.name ?? ctx.scenario)}
        d={derived} />
    </section>
    {inst?.drivers && <section className="sec">
      <div className="row gap"><h3 className="grow">{t('ws.participants')}</h3>
        <div className="seg" role="group" aria-label="participants"><button className={who === 'drivers' ? 'on' : ''} onClick={() => setWho('drivers')}>Drivers {inst.drivers.length}</button>
          <button className={who === 'riders' ? 'on' : ''} onClick={() => setWho('riders')}>Riders {inst.riders.length}</button></div></div>
      <div className="row gap small muted wrap stats">
        {pv.sampled && <span className="badge outline"><Database size={11} /> Sampled · sample {k + 1}</span>}
        {(sc?.edited?.length ?? 0) > 0 && <span className="badge warn" title={sc!.edited.join(', ')}>Edited: {sc!.edited.length}</span>}
        {vehicles && <span><Car size={12} /> {fleetCount(['ICE', 'HEV'])} combustion/hybrid · {fleetCount(['BEV', 'PHEV'])} plug-in/electric</span>}
        {plan && <span><CheckCircle2 size={12} /> {served.size} of {inst.riders.length} riders matched</span>}</div>
      <ul className="people" aria-label={who}>
        {people.map((p) => <li key={p.id}><button onClick={() => onFocus(p.origin[0], p.origin[1])}>
          <span className={`pid ${who === 'drivers' ? 'drv' : 'rdr'}`}>{p.id}</span>
          <span className="grow"><span className="strong">{hhmm(p.earliest)}</span><span className="muted"> – {hhmm(p.latest)}</span>
            {who === 'drivers' && p.vehicle && <span className="small muted block">{p.vehicle.powertrain === 'BEV' ? <Zap size={11} /> : <Fuel size={11} />} {POWERTRAIN_LABEL[p.vehicle.powertrain] ?? p.vehicle.powertrain}</span>}</span>
          {plan && who === 'drivers' && <span className="small">{matched.get(p.id) ? <>carries <b>{matched.get(p.id)}</b></> : <span className="muted">drives alone</span>}</span>}
          {plan && who === 'riders' && <span className="small">{served.has(p.id) ? <span className="ok-text"><CheckCircle2 size={11} /> matched</span> : <span className="muted"><CircleDashed size={11} /> not matched</span>}</span>}
        </button></li>)}
      </ul></section>}
    <details className="sec small">
      <summary>Details</summary>
      <dl className="facts">
        {pv.attribution && <><dt>Source</dt><dd>{pv.attribution}</dd></>}
        {pv.method && <><dt>Derivation</dt><dd>{pv.method}{pv.pool_size ? ` · sampling pool of ${pv.pool_size} trips` : ''}{pv.window ? ` · departures ${hhmm(pv.window[0])}–${hhmm(pv.window[1])}` : ''}</dd></>}
        {prov.seed != null && <><dt>Seed</dt><dd>{prov.seed}{prov.edited_agents ? ` · edited: ${prov.edited_agents.join(', ')}` : ''}</dd></>}
        {net && <><dt>Road network</dt><dd>{net.attribution} ({net.licence}) · OSM data {net.osm_timestamp ?? 'n/a'} · {net.travel_model}</dd></>}
        {inst?.params && <><dt>Limits</dt><dd>detour ≤ {Math.round(inst.params.max_detour_s / 60)} min and ≤ {Math.round(100 * inst.params.max_detour_ratio)} % of the direct trip</dd></>}
        {vehicles && <><dt>Vehicles</dt><dd>{vehicles.fleet.map((f) => <div key={f.id}>{f.name} ×{f.drivers} · {POWERTRAIN_LABEL[f.powertrain] ?? f.powertrain} · {f.passenger_capacity} seats · {f.provenance}
          {Object.entries(f.parameters as Record<string, Json>).filter(([, r]) => r.value != null).map(([key, r]) => <div key={key} className="muted">{key.replace(/_/g, ' ')}: {r.value} {r.unit}{r.basis ? ` ${r.basis}` : ''}{r.source ? ` — ${r.source}${r.source_version ? ` (${r.source_version})` : ''}` : ''}</div>)}</div>)}
          {vehicles.default && <div>riders' baseline vehicle: {vehicles.default.name}</div>}</dd></>}
        {emis && <><dt>CO₂ calculation</dt><dd>{SCOPE_LABEL[emis.scope] ?? emis.scope} · baseline: {BASELINE_LABEL[emis.baseline] ?? emis.baseline}</dd></>}
        <dt>Researcher</dt><dd>{exp.campaign.owner_display}</dd>
        <dt>Identifiers</dt><dd className="mono wrap-anywhere">{exp.campaign.campaign_id}<br />{hash}</dd>
      </dl>
      <div className="row gap"><button className="btn sm" onClick={onDetails}><ExternalLink size={12} /> Full record</button>
        <button className="btn sm" onClick={onHide} aria-pressed={hidden}>{hidden ? <><Eye size={12} /> Show in lists</> : <><EyeOff size={12} /> Hide from lists</>}</button></div>
    </details>
  </div>;
}

/** Left panel when starting a new experiment from saved scenarios (the wizard's Save Scenario leads here). */
export function NewExperimentPanel({ lib, picked, setPicked, title, setTitle, onGenerate, onRun, canRun, runTitle }: {
  lib: Json[]; picked: string[]; setPicked: (h: string[]) => void; title: string; setTitle: (t: string) => void; onGenerate: () => void;
  onRun: () => void; canRun: boolean; runTitle: string;
}) {
  const toggle = (h: string) => setPicked(picked.includes(h) ? picked.filter((x) => x !== h) : [...picked, h]);
  return <div className="panel-body">
    <section className="sec"><span className="eyebrow">{t('ws.experiment')}</span><h2 className="title">New experiment</h2>
      <label className="field">Name <input aria-label="experiment name" value={title} onChange={(e) => setTitle(e.target.value)} className="full" /></label></section>
    <section className="sec"><h3>Saved scenarios</h3>
      {lib.length === 0 ? <p className="small muted">No saved scenario yet. <button className="btn sm" onClick={onGenerate}>Generate one</button></p> :
        <ul className="people" aria-label="scenarios">{lib.map((s) => <li key={s.instance_hash}><label className="row">
          <input type="checkbox" aria-label={s.name} checked={picked.includes(s.instance_hash)} onChange={() => toggle(s.instance_hash)} />
          <span className="grow"><b>{s.name}</b><br /><span className="muted small">{s.drivers} drivers · {s.riders} riders · {s.category ?? s.source}</span></span></label></li>)}</ul>}
      <p className="small muted"><User size={11} /> Tick the scenarios, choose the methods on the right, then run.</p>
      <div className="row gap"><button className="btn primary" onClick={onRun} disabled={!canRun} title={runTitle}><Play size={13} /> Save &amp; Run</button></div></section>
  </div>;
}
