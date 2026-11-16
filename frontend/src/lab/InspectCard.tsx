import { Pencil, X } from 'lucide-react';
import type { Json } from '../api/client';
import { CarIcon } from '../components/DomainIcons';
import { hhmm, hhmmss } from '../geo/api';
import { tr } from '../i18n';

/** What the scenario records about the vehicle (with its driver) or the rider whose marker was clicked, and what the
 *  selected validated solution does with it. Read-only: an edit opens a NEW scenario version where the problem supports
 *  authoring; where it does not, the card says why instead of offering it. */
export function InspectCard({ id, inst, plan, extra, note, onEdit, onClose }: {
  id: string; inst: Json | null; plan: Json | null; extra: [string, string][]; note: string | null;
  onEdit?: (what: 'vehicle' | 'participants') => void; onClose: () => void;
}) {
  const driver = (inst?.drivers as Json[] | undefined)?.find((d) => d.id === id);
  const rider = (inst?.riders as Json[] | undefined)?.find((r) => r.id === id);
  const a = driver ?? rider;
  if (!a) return null;
  const v = driver?.vehicle as Json | null | undefined;
  const pv = (plan?.vehicles as Json[] | undefined)?.find((x) => x.driver === id);
  const servedBy = (plan?.vehicles as Json[] | undefined)?.find((x) => (x.stops as Json[]).some((s) => s.rider === id));
  const unserved = (plan?.unserved as Json[] | undefined)?.some((u) => u.rider === id);
  const params = (inst?.params ?? {}) as Json;
  const given = new Set(extra.map(([k]) => tr(k)));
  const rows: [string, string][] = ([
    [tr('Identifier'), id],
    ...(a.role ? [[tr('Role'), tr(String(a.role))] as [string, string]] : []),
    ...(driver ? [[tr('Vehicle type'), v ? `${v.name ?? v.id}${v.powertrain && v.powertrain !== 'custom' ? ` · ${v.powertrain}` : ''}` : tr('no vehicle profile in this scenario')] as [string, string]] : []),
    ...(driver && v?.passenger_capacity != null ? [[tr('Passenger capacity'), String(v.passenger_capacity)] as [string, string]] : []),
    [tr('Time window'), `${hhmm(a.earliest)} – ${hhmm(a.latest)}`],
    [tr('Start'), `${Number(a.origin[0]).toFixed(5)}, ${Number(a.origin[1]).toFixed(5)}`],
    [tr('Destination'), `${Number(a.destination[0]).toFixed(5)}, ${Number(a.destination[1]).toFixed(5)}`],
    ...extra.map(([k, val]) => [`\u0000${tr(k)}`, val] as [string, string]),
    ...(driver && params.max_detour_s != null ? [[tr('Constraint: maximum detour'), `${Math.round(params.max_detour_s / 60)} min${params.max_detour_ratio != null ? ` · ${tr('ratio')} ${params.max_detour_ratio}` : ''}`] as [string, string]] : []),
  ] as [string, string][]).filter(([k]) => k.startsWith('\u0000') || !given.has(k)).map(([k, val]) => [k.replace('\u0000', ''), val]);
  return <div className="mapcard inspect-card" role="dialog" aria-label={`${driver ? tr('vehicle') : tr('rider')} ${id}`}>
    <div className="row gap"><span className="inspect-ico">{driver ? <CarIcon size={16} /> : null}</span><b className="grow">{driver ? tr('Vehicle and driver') : tr('Rider')} · {id}</b>
      <button className="btn icon ghost sm" aria-label={tr('close')} onClick={onClose}><X size={14} /></button></div>
    <dl className="facts-list">{rows.map(([k, val]) => <div key={k}><dt>{k}</dt><dd>{val}</dd></div>)}</dl>
    <div className="small"><b>{tr('In the selected solution')}</b>
      {!plan && <div className="muted">{tr('Select a method with a validated solution to see the assignment and the route.')}</div>}
      {plan && driver && (pv ? <>
        <div>{pv.rider ? `${tr('carries')} ${pv.rider}` : tr('drives alone')}</div>
        <ol className="stops">{(pv.stops as Json[]).map((s, i) => <li key={i}><span className="mono">{hhmmss(s.t)}</span> {s.type === 'depart' ? tr('departs') : s.type === 'arrive' ? tr('arrives') : s.type === 'pickup' ? `${tr('picks up')} ${s.rider}` : `${tr('drops off')} ${s.rider}`}</li>)}</ol></>
        : <div className="muted">{tr('This vehicle is not used by the selected solution.')}</div>)}
      {plan && rider && (servedBy ? <div>{tr('served by')} {servedBy.driver}{(() => { const st = (servedBy.stops as Json[]).filter((s) => s.rider === id); const pu = st.find((s) => s.type === 'pickup'), dr = st.find((s) => s.type === 'dropoff');
        return pu && dr ? ` · ${tr('pick-up')} ${hhmmss(pu.t)} · ${tr('drop-off')} ${hhmmss(dr.t)}` : ''; })()}</div>
        : <div className="muted">{unserved ? tr('not matched in the selected solution') : tr('travels in its own vehicle or is not part of a shared ride')}</div>)}</div>
    {onEdit ? <div className="row gap wrap"><button className="btn sm" onClick={() => onEdit(driver ? 'vehicle' : 'participants')}><Pencil size={12} /> {driver ? tr('Edit this vehicle…') : tr('Edit participants…')}</button>
      <span className="tiny muted">{tr('Opens a new scenario version; this frozen scenario and its results stay unchanged.')}</span></div>
      : <p className="tiny muted" role="note">{note != null ? tr(note) : tr('This problem provides no scenario editor: its scenarios are frozen records.')}</p>}
  </div>;
}
