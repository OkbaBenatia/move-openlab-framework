import { ScenarioNav } from './ScenarioNav';
import { useState } from 'react';
import { CheckCircle2, CircleDashed, Database, ExternalLink, Eye, EyeOff, Layers, MapPin, Play, Plus, ShieldCheck, Shuffle, User } from 'lucide-react';
import { CarIcon, ElectricCarIcon, RiderIcon, VehicleIcon } from '../components/DomainIcons';
import type { Json } from '../api/client';
import { KIND } from '../components/common';
import { hhmm } from '../geo/api';
import { t, tr } from '../i18n';
import { BASELINE_LABEL, POWERTRAIN_LABEL, SCOPE_LABEL } from '../mobility/api';
import type { Experiment } from './api';

export function ExperimentBadges({ exp }: { exp: Experiment }) {
  const c = exp.campaign;
  return <div className="row gap badges">
    <span className="badge info">{tr(KIND[c.kind] ?? c.kind)}</span>
    {c.category === 'Demo' && <span className="badge outline">{tr('Public demonstration')}</span>}
    {c.result_import && <span className="badge outline" title={c.result_import.source ? tr('Results computed elsewhere ({source}); every decision set re-validated here; nothing executed here', { source: c.result_import.source }) : tr('Results computed elsewhere; every decision set re-validated here; nothing executed here')}>{tr('Imported results')}</span>}
    {c.category === 'Imported' && <span className="badge outline">{c.imported_from ? tr('Imported from {name}', { name: c.imported_from }) : tr('Imported')}</span>}
    {exp.reproduction && <span className={`badge ${exp.reproduction.reproduced ? 'ok' : 'bad'}`}>{exp.reproduction.reproduced ? t('ev.reproduced') : t('ev.notReproduced')}</span>}
    {c.locked && <span className="badge" tabIndex={0} title={t('ws.locked.tip')} aria-label={`${tr('Locked')}. ${t('ws.locked.tip')}`}>{tr('Locked')}</span>}
    {!c.locked && c.status !== 'completed' && <span className="badge">{tr(c.status === 'draft' ? 'Draft' : c.status)}</span>}
  </div>;
}

function Ctx({ icon, k, v, d, extra }: { icon: React.ReactNode; k: string; v: React.ReactNode; d?: React.ReactNode; extra?: React.ReactNode }) {
  return <div className="ctx-row"><span className="ci">{icon}</span><div className="grow"><div className="k">{k}</div><div className="v">{v}</div>{d && <div className="d">{d}</div>}{extra}</div></div>;
}

/** Left panel: the experiment, then Area · Road network · Mobility data (the source) · Scenario (the demand derived from
 *  it) on separate lines, then the participants and vehicles of the scenario shown on the map. */
export function ScenarioPanel({ exp, hash, setHash, inst, plan, onFocus, onDetails, parentTitle, hidden, onHide, onEdit, detailsOpen = false, setDetailsOpen }: {
  exp: Experiment; hash: string; setHash: (h: string) => void; inst: Json | null; plan: Json | null;
  onFocus: (lat: number, lon: number) => void; onDetails: () => void; parentTitle: string | null; hidden: boolean; onHide: () => void;
  /** + Driver, + Rider, Randomize: always a NEW version of the shown frozen scenario (absent: not a geographic scenario) */
  onEdit?: (action: 'driver' | 'rider' | 'randomize') => void;
  detailsOpen?: boolean; setDetailsOpen?: (open: boolean) => void;
}) {
  const [who, setWho] = useState<'drivers' | 'riders'>('drivers');
  // riders a vehicle picks up: its pick-up stops name each one (a vehicle may carry several), else its `rider`
  const pickedUp = (v: Json): string[] => { const p = (v.stops ?? []).filter((s: Json) => s.type === 'pickup' && s.rider).map((s: Json) => s.rider); return p.length ? p : v.rider ? [v.rider] : []; };
  const served = new Set<string>((plan?.vehicles ?? []).flatMap(pickedUp));
  const matched = new Map<string, string>((plan?.vehicles ?? []).filter((v: Json) => v.rider).map((v: Json) => [v.driver, v.rider]));
  const ctx = exp.context, pv = exp.provenance;
  const prov = inst?.provenance ?? {};
  const k = Math.max(0, exp.scenarios.findIndex((s) => s.instance_hash === hash));
  const sc = exp.scenarios[k];
  const vehicles = sc?.vehicles ?? null;
  const emis = sc?.emissions ?? exp.campaign.emissions;
  const net = inst?.network;
  const network = net ? 'OpenStreetMap' : ctx.area.network_id ? 'OpenStreetMap' : null;
  const netDetail = net?.osm_timestamp ? `${tr('extract of {date}', { date: new Date(net.osm_timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })}${net.profile_label ? ` · ${tr(net.profile_label)}` : ''}` : null;
  const source = pv.source === 'open-data' ? (pv.release ? tr('RPC {release} observed trips', { release: pv.release }) : tr('RPC observed trips')) : pv.source === 'dataset' ? (ctx.dataset ?? tr('Uploaded trips')) : pv.source === 'generator' ? tr('Synthetic demand') : pv.source === 'editor' ? tr('Placed on the map') : (ctx.dataset ?? '—');
  const sourceDetail = pv.source === 'open-data' ? [pv.observed_trips != null ? tr('{n} trips in the area', { n: pv.observed_trips }) : null, tr('not used one-to-one')].filter(Boolean).join(' · ')
    : pv.source === 'dataset' ? tr('uploaded file · not used one-to-one') : pv.source === 'generator' ? tr('random trips on the road network') : null;
  const seedNote = sc?.seed != null ? ` (${tr('seed {seed}', { seed: sc.seed })})` : '';
  const derived = pv.sampled ? `${tr('drawn from the observed trips · sample {k} of {n}', { k: k + 1, n: exp.scenarios.length })}${seedNote}`
    : pv.source === 'generator' ? `${tr('seeded synthetic demand · scenario {k} of {n}', { k: k + 1, n: exp.scenarios.length })}${seedNote}` : tr('scenario {k} of {n}', { k: k + 1, n: exp.scenarios.length });
  const people: Json[] = who === 'drivers' ? inst?.drivers ?? [] : inst?.riders ?? [];
  const fleetCount = (pt: string[]) => (vehicles?.fleet ?? []).filter((f) => pt.includes(f.powertrain)).reduce((n, f) => n + f.drivers, 0);
  return <div className="panel-body">
    <section className="sec">
      <span className="eyebrow">{t('ws.experiment')}</span>
      <h2 className="title">{exp.campaign.title}</h2>
      <ExperimentBadges exp={exp} />
      {exp.validation.runs > 0 && <div className="small muted summary-line"><ShieldCheck size={12} /> {tr('{n}/{m} runs validated', { n: exp.validation.accepted, m: exp.validation.runs })} · {exp.methods.length === 1 ? tr('{n} method', { n: exp.methods.length }) : tr('{n} methods', { n: exp.methods.length })} · {exp.scenarios.length === 1 ? tr('{n} scenario', { n: exp.scenarios.length }) : tr('{n} scenarios', { n: exp.scenarios.length })}</div>}
    </section>
    <section className="sec ctx" aria-label={tr('area, road network, mobility data and scenario')}>
      <Ctx icon={<MapPin size={15} />} k={t('ws.area')} v={ctx.area.label ?? '—'} />
      <Ctx icon={<Database size={15} />} k={pv.sampled ? t('ws.dataSource') : tr('Mobility data')} v={source} />
      <Ctx icon={<Layers size={15} />} k={pv.sampled ? t('ws.scenarioSampled') : t('ws.scenario')}
        v={exp.scenarios.length > 1 ? <ScenarioNav compact allowAll={false} scenarios={exp.scenarios} value={Math.max(0, exp.scenarios.findIndex((s) => s.instance_hash === hash))} onChange={(i) => typeof i === 'number' && setHash(exp.scenarios[i].instance_hash)} /> : (sc?.name ?? ctx.scenario)}
      />
    </section>
    {inst?.drivers && <section className="sec">
      <div className="row gap"><h3 className="grow">{t('ws.participants')}</h3>
        {onEdit && <div className="row gap edit-people" role="group" aria-label={tr('edit as new scenario')} title={tr('Edit as new scenario: a new version of this frozen scenario; this experiment and its results stay unchanged')}>
          <button className="btn sm" onClick={() => onEdit('driver')}><Plus size={12} /> {tr('Driver')}</button><button className="btn sm" onClick={() => onEdit('rider')}><Plus size={12} /> {tr('Rider')}</button>
          <button className="btn sm" onClick={() => onEdit('randomize')}><Shuffle size={12} /> {tr('Randomize')}</button></div>}</div>
      <div className="row gap"><span className="grow" />
        <div className="seg" role="group" aria-label={tr('participants')}><button className={who === 'drivers' ? 'on' : ''} onClick={() => setWho('drivers')}><CarIcon size={14} />{tr('Drivers {n}', { n: inst.drivers.length })}</button>
          <button className={who === 'riders' ? 'on' : ''} onClick={() => setWho('riders')}><RiderIcon size={14} />{tr('Riders {n}', { n: inst.riders.length })}</button></div></div>
      <div className="row gap small muted wrap stats">
        {pv.sampled && <span className="badge outline"><Database size={11} /> {tr('Sampled · scenario {k}', { k: k + 1 })}</span>}
        {(sc?.edited?.length ?? 0) > 0 && <span className="badge warn" title={sc!.edited.join(', ')}>{tr('Edited: {n}', { n: sc!.edited.length })}</span>}
        {vehicles && <span className="fleet"><span title={tr('Combustion and hybrid cars')}><CarIcon size={14} /> {tr('{n} combustion/hybrid', { n: fleetCount(['ICE', 'HEV', 'custom']) })}</span>
          <span title={tr('Battery-electric and plug-in hybrid cars')}><ElectricCarIcon size={14} /> {tr('{n} plug-in/electric', { n: fleetCount(['BEV', 'PHEV']) })}</span></span>}
        {plan && <span><CheckCircle2 size={12} /> {tr('{n} of {m} riders matched', { n: served.size, m: inst.riders.length })}</span>}</div>
      <ul className="people" aria-label={tr(who)}>
        {people.map((p) => <li key={p.id}><button onClick={() => onFocus(p.origin[0], p.origin[1])}>
          <span className={`pid ${who === 'drivers' ? 'drv' : 'rdr'}`}>{p.id}</span>
          <span className="grow"><span className="strong">{hhmm(p.earliest)}</span><span className="muted"> – {hhmm(p.latest)}</span>
            {who === 'drivers' && p.vehicle && <span className="small muted block vline"><VehicleIcon powertrain={p.vehicle.powertrain} size={14} /> {tr(POWERTRAIN_LABEL[p.vehicle.powertrain] ?? p.vehicle.powertrain)}</span>}</span>
          {plan && who === 'drivers' && <span className="small">{matched.get(p.id) ? <>{tr('carries')} <b>{matched.get(p.id)}</b></> : <span className="muted">{tr('drives alone')}</span>}</span>}
          {plan && who === 'riders' && <span className="small">{served.has(p.id) ? <span className="ok-text"><CheckCircle2 size={11} /> {tr('matched')}</span> : <span className="muted"><CircleDashed size={11} /> {tr('not matched')}</span>}</span>}
        </button></li>)}
      </ul></section>}
    <details className="sec small" open={detailsOpen} onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== detailsOpen) setDetailsOpen?.(o); }}>
      <summary>{tr('Experiment details')}</summary>
      <dl className="facts">
        <dt>{t('ws.network')}</dt><dd>{network ?? '—'}{netDetail ? ` · ${netDetail}` : ''}</dd>
        {sourceDetail && <><dt>{tr('Mobility data')}</dt><dd>{sourceDetail}</dd></>}
        <dt>{tr('Scenario')}</dt><dd>{derived}</dd>
        {exp.campaign.parent && <><dt>{tr('Lineage')}</dt><dd>{exp.campaign.parent.relation === 'perturbs' ? tr('Controlled variant of {parent}', { parent: parentTitle ?? tr('its parent experiment') }) : exp.campaign.parent.relation === 'reproduces' ? tr('Re-execution of {parent}', { parent: parentTitle ?? tr('its parent experiment') }) : tr('Extends {parent}', { parent: parentTitle ?? tr('its parent experiment') })}{exp.campaign.variant ? ` — ${exp.campaign.variant}` : ''} <span className="mono">{exp.campaign.parent.campaign_id}</span></dd></>}
        {pv.attribution && <><dt>{tr('Source')}</dt><dd>{pv.attribution}</dd></>}
        {pv.method && <><dt>{tr('Derivation')}</dt><dd>{pv.method}{pv.pool_size ? ` · ${tr('sampling pool of {n} trips', { n: pv.pool_size })}` : ''}{pv.window ? ` · ${tr('departures {from}–{to}', { from: hhmm(pv.window[0]), to: hhmm(pv.window[1]) })}` : ''}</dd></>}
        {prov.seed != null && <><dt>{tr('Seed')}</dt><dd>{prov.seed}{prov.edited_agents ? ` · ${tr('edited: {list}', { list: prov.edited_agents.join(', ') })}` : ''}</dd></>}
        {net && <><dt>{tr('Road network')}</dt><dd>{net.attribution} ({net.licence}) · {tr('OSM data {date}', { date: net.osm_timestamp ?? tr('n/a') })} · {net.travel_model}</dd></>}
        {inst?.params && <><dt>{tr('Limits')}</dt><dd>{tr('detour ≤ {min} min and ≤ {pct} % of the direct trip', { min: Math.round(inst.params.max_detour_s / 60), pct: Math.round(100 * inst.params.max_detour_ratio) })}</dd></>}
        {vehicles && <><dt>{tr('Vehicles')}</dt><dd>{vehicles.fleet.map((f) => <div key={f.id}><VehicleIcon powertrain={f.powertrain} size={13} /> {f.name} ×{f.drivers} · {tr(POWERTRAIN_LABEL[f.powertrain] ?? f.powertrain)} · {tr('{n} seats', { n: f.passenger_capacity ?? '' })} · {f.provenance}
          {Object.entries(f.parameters as Record<string, Json>).filter(([, r]) => r.value != null).map(([key, r]) => <div key={key} className="muted">{key.replace(/_/g, ' ')}: {r.value} {r.unit}{r.basis ? ` ${r.basis}` : ''}{r.source ? ` — ${r.source}${r.source_version ? ` (${r.source_version})` : ''}` : ''}</div>)}</div>)}
          {vehicles.default && <div>{tr("riders' baseline vehicle: {name}", { name: vehicles.default.name })}</div>}</dd></>}
        {emis && <><dt>{tr('CO₂ calculation')}</dt><dd>{tr(SCOPE_LABEL[emis.scope] ?? emis.scope)} · {tr('baseline: {baseline}', { baseline: tr(BASELINE_LABEL[emis.baseline] ?? emis.baseline) })}</dd></>}
        <dt>{tr('Researcher')}</dt><dd>{exp.campaign.owner_display}</dd>
        <dt>{tr('Identifiers')}</dt><dd className="mono wrap-anywhere">{exp.campaign.campaign_id}<br />{hash}</dd>
      </dl>
      <div className="row gap"><button className="btn sm" onClick={onDetails}><ExternalLink size={12} /> {tr('Full record')}</button>
        <button className="btn sm" onClick={onHide} aria-pressed={hidden}>{hidden ? <><Eye size={12} /> {tr('Show in lists')}</> : <><EyeOff size={12} /> {tr('Hide from lists')}</>}</button></div>
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
    <section className="sec"><span className="eyebrow">{t('ws.experiment')}</span><h2 className="title">{tr('New experiment')}</h2>
      <label className="field">{tr('Name')} <input aria-label={tr('experiment name')} value={title} onChange={(e) => setTitle(e.target.value)} className="full" /></label></section>
    <section className="sec"><h3>{tr('Saved scenarios')}</h3>
      {lib.length === 0 ? <p className="small muted">{tr('No saved scenario yet.')} <button className="btn sm" onClick={onGenerate}>{tr('Generate one')}</button></p> :
        <ul className="people" aria-label={tr('scenarios')}>{lib.map((s) => <li key={s.instance_hash}><label className="row">
          <input type="checkbox" aria-label={s.name} checked={picked.includes(s.instance_hash)} onChange={() => toggle(s.instance_hash)} />
          <span className="grow"><b>{s.name}</b><br /><span className="muted small">{tr('{n} drivers', { n: s.drivers })} · {tr('{n} riders', { n: s.riders })} · {tr(String(s.category ?? s.source ?? ''))}</span></span></label></li>)}</ul>}
      <p className="small muted"><User size={11} /> {tr('Tick the scenarios, choose the methods on the right, then run.')}</p>
      <div className="row gap"><button className="btn primary" onClick={onRun} disabled={!canRun} title={runTitle}><Play size={13} /> {tr('Save & Run')}</button></div></section>
  </div>;
}
