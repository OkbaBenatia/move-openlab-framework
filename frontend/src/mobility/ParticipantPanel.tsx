import { useState } from 'react';
import { MapPin, Save, Trash2, X } from 'lucide-react';
import { CarIcon, RiderIcon } from '../components/DomainIcons';
import { hhmm, km, mins, toSec, type Agent } from '../geo/api';
import { tr } from '../i18n';
import { vehicleName, type VehicleProfile } from './api';
import { idError } from './authoring';

export interface ParticipantDraft { id: string; earliest: number; latest: number; arriveBy: number | null; vehicle: string; capacity: number | null }

/** The details of one driver or rider of the scenario being edited, as a small form: identifier, vehicle and capacity
 *  (drivers), places (changed on the map), times, and the constraints that apply. "Save participant" asks the server to
 *  check it; Cancel leaves the scenario as it was (a participant that was just added is removed). */
export function ParticipantPanel({ role, agent, isNew, others, profiles, vehicleId, detour, direct, busy, error, onPick, onSave, onCancel, onRemove }: {
  role: 'drivers' | 'riders'; agent: Agent; isNew: boolean; others: string[];
  /** the scenario's vehicle profiles and the one this driver uses ('' when the scenario has no vehicle) */
  profiles: VehicleProfile[]; vehicleId: string;
  detour: { min: number; ratio: number }; direct: { s: number; m: number } | null; busy: boolean; error: string | null;
  onPick: (field: 'origin' | 'destination') => void; onSave: (d: ParticipantDraft) => void; onCancel: () => void; onRemove: () => void;
}) {
  const driver = role === 'drivers';
  const [id, setId] = useState(agent.id);
  const [from, setFrom] = useState(hhmm(agent.earliest));
  const [until, setUntil] = useState(hhmm(agent.latest));
  const [by, setBy] = useState('');
  const [vehicle, setVehicle] = useState(vehicleId);
  const cur = profiles.find((p) => p.id === vehicle) ?? null;
  const [capacity, setCapacity] = useState<number>(cur?.passenger_capacity ?? 4);
  const [local, setLocal] = useState<string | null>(null);
  const [tried, setTried] = useState<string | null>(null);         // the form as it was when it was last submitted
  const now = JSON.stringify([id, from, until, by, vehicle, capacity]);
  const at = (p: [number, number]) => `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`;
  const placed = agent.origin[0] !== agent.destination[0] || agent.origin[1] !== agent.destination[1];
  const save = () => {
    setTried(now);
    const e = toSec(from), l = toSec(until), a = by.trim() === '' ? null : toSec(by);
    const bad = idError(id.trim(), others);
    if (bad) return setLocal(tr(bad.text, bad.vars));
    if (Number.isNaN(e) || Number.isNaN(l) || (a !== null && Number.isNaN(a))) return setLocal(tr('Times are written HH:MM, for example 07:30.'));
    if (driver && cur && (!Number.isInteger(capacity) || capacity < 1)) return setLocal(tr('The vehicle capacity must be at least 1 seat.'));
    if (driver && cur && capacity > 60) return setLocal(tr('The vehicle capacity is at most 60 seats.'));
    setLocal(null);
    onSave({ id: id.trim(), earliest: e, latest: l, arriveBy: a, vehicle, capacity: driver && cur ? capacity : null });
  };
  const shown = tried === now ? local ?? error : null;      // a message is about the values it refused
  return <form className="mapcard pp-card form" noValidate role="dialog" aria-label={`${driver ? tr('driver') : tr('rider')} ${agent.id}`} onSubmit={(e) => { e.preventDefault(); save(); }}>
    <div className="row gap"><span className="inspect-ico">{driver ? <CarIcon size={16} /> : <RiderIcon size={16} />}</span>
      <b className="grow">{isNew ? (driver ? tr('New driver') : tr('New rider')) : (driver ? tr('Driver') : tr('Rider'))} · {agent.id}</b>
      <button type="button" className="btn icon ghost sm" aria-label={tr('close participant')} onClick={onCancel}><X size={14} /></button></div>
    <label>{tr('Identifier')} <input value={id} onChange={(e) => setId(e.target.value)} aria-label={tr('participant identifier')} maxLength={32} /></label>
    {driver && (profiles.length > 0 && vehicleId ? <div className="pp-two">
      <label>{tr('Vehicle type')} <select aria-label={tr('vehicle type')} value={vehicle} onChange={(e) => { setVehicle(e.target.value); setCapacity(profiles.find((p) => p.id === e.target.value)?.passenger_capacity ?? capacity); }}>
        {profiles.map((p) => <option key={p.id} value={p.id}>{vehicleName(p)}</option>)}</select></label>
      <label title={tr('Recorded with the vehicle. This problem matches one rider per driver, whatever the capacity.')}>{tr('Seats')}
        <input type="number" min={1} max={60} step={1} value={Number.isNaN(capacity) ? '' : capacity} onChange={(e) => setCapacity(e.target.value.trim() === '' ? NaN : Number(e.target.value))} aria-label={tr('vehicle capacity')} /></label></div>
      : <p className="tiny muted">{tr('No vehicle in this scenario: choose one under Vehicle to set this driver\'s vehicle type and seats.')}</p>)}
    <div className="pp-place"><span className="k">{driver ? tr('Start') : tr('Pick-up point')}</span><span className="mono small" data-place="origin">{at(agent.origin)}</span>
      <button type="button" className="btn sm" onClick={() => onPick('origin')} aria-label={driver ? tr('set start on map') : tr('set pick-up point on map')}><MapPin size={12} /> {tr('Set on map')}</button></div>
    <div className="pp-place"><span className="k">{tr('Destination')}</span><span className="mono small" data-place="destination">{placed ? at(agent.destination) : tr('not placed yet')}</span>
      <button type="button" className="btn sm" onClick={() => onPick('destination')} aria-label={tr('set destination on map')}><MapPin size={12} /> {tr('Set on map')}</button></div>
    <div className="pp-two">
      <label>{driver ? tr('Departure from') : tr('Pick-up from')} <input className="time" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={driver ? tr('earliest departure') : tr('earliest pick-up')} /></label>
      <label>{driver ? tr('Departure until') : tr('Pick-up until')} <input className="time" value={until} onChange={(e) => setUntil(e.target.value)} aria-label={driver ? tr('latest departure') : tr('latest pick-up')} /></label></div>
    <label title={tr('Optional. An arrival by the direct trip: it is refused when the direct travel time does not allow it, and otherwise brings the latest departure or pick-up forward. The scenario stores the time window.')}>{tr('Arrive by (optional)')}
      <input className="time" value={by} placeholder={direct ? hhmm(agent.latest + direct.s) : 'HH:MM'} onChange={(e) => setBy(e.target.value)} aria-label={tr('latest arrival')} /></label>
    <p className="tiny muted" data-direct>{direct ? tr('Direct trip {time} · {dist} · arrival {from}–{to}', { time: mins(direct.s), dist: km(direct.m), from: hhmm(agent.earliest + direct.s), to: hhmm(agent.latest + direct.s) })
      : tr('The direct trip is computed on the road network when the participant is saved.')}</p>
    <p className="tiny muted">{driver ? tr('Constraints: one rider per driver · detour ≤ {min} min and ≤ {pct} % of the direct trip (whole scenario, step 3).', { min: detour.min, pct: Math.round(detour.ratio * 100) })
      : tr('Constraints: the pick-up window above; this problem has no drop-off window.')}</p>
    {shown && <p className="note warn small" role="alert">{shown}</p>}
    <div className="row gap"><button type="submit" className="btn primary sm" disabled={busy || !placed} title={placed ? '' : tr('place the start and end points first')}><Save size={12} /> {tr('Save participant')}</button>
      <button type="button" className="btn sm" onClick={onCancel}>{tr('Cancel')}</button><span className="grow" />
      <button type="button" className="btn icon sm" aria-label={tr('remove {id}', { id: agent.id })} title={tr('Remove this participant')} onClick={onRemove}><Trash2 size={12} /></button></div>
  </form>;
}
