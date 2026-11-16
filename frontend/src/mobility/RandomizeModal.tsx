import { useEffect, useMemo, useState } from 'react';
import { Dices, Shuffle, X } from 'lucide-react';
import { CountInput } from '../components/CountInput';
import { errText } from '../components/common';
import { VehicleIcon } from '../components/DomainIcons';
import { COLORS, LeafletMap, type BBox } from '../geo/LeafletMap';
import { toSec, type Area, type GeoConfig } from '../geo/api';
import { tr } from '../i18n';
import { vehicleName, type VehicleProfile } from './api';
import { GROUPS, GROUP_LABEL, allTo, clipBox, driversForRatio, groupOf, innerBox, insideBox, randomizeError, ratioOf, sharesTotal, splitCounts, type AuthoringParams, type Group, type Shares } from './authoring';

const GROUP_PT: Record<Group, string> = { combustion: 'ICE', hybrid: 'HEV', electric: 'BEV' };

/** Randomize: one dialog for the seeded generation of participants and vehicles. The server generates and validates
 *  (same parameters and seed: same scenario); the result replaces the participants of the scenario being edited and
 *  stays editable. Nothing is stored and nothing is solved here. */
export function RandomizeModal({ cfg, area, profiles, defaultVehicle, initial, onGenerate, onClose }: {
  cfg: GeoConfig; area: Area; profiles: VehicleProfile[]; defaultVehicle: VehicleProfile | null;
  initial: { drivers: number; riders: number; seed: number; start: string; end: string; detourMin: number; detourRatio: number; minTripKm: number; capacity: number | null };
  /** asks the server; rejects with the server's message when the parameters are refused */
  onGenerate: (p: AuthoringParams) => Promise<void>; onClose: () => void;
}) {
  const byGroup = useMemo(() => Object.fromEntries(GROUPS.map((g) => [g, profiles.filter((p) => groupOf(p.powertrain) === g)])) as Record<Group, VehicleProfile[]>, [profiles]);
  const fleet = profiles.length > 0;
  const g0 = defaultVehicle ? groupOf(defaultVehicle.powertrain) : (GROUPS.find((g) => byGroup[g].length) ?? 'combustion');
  const [drivers, setDrivers] = useState(initial.drivers);
  const [riders, setRiders] = useState(initial.riders);
  const [ratio, setRatio] = useState(String(ratioOf(initial.drivers, initial.riders)));
  const [seed, setSeed] = useState(initial.seed);
  const [shares, setShares] = useState<Shares>(allTo(g0));
  const [chosen, setChosen] = useState<Record<Group, string>>(() => Object.fromEntries(GROUPS.map((g) => [g, (g === g0 && defaultVehicle ? defaultVehicle.id : byGroup[g][0]?.id) ?? ''])) as Record<Group, string>);
  const [capacity, setCapacity] = useState<number>(initial.capacity ?? defaultVehicle?.passenger_capacity ?? byGroup[g0][0]?.passenger_capacity ?? 4);
  const [where, setWhere] = useState<'area' | 'rect'>('area');
  const [rect, setRect] = useState<BBox>(() => innerBox(area.bbox));
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [dw, setDw] = useState(15);
  const [rw, setRw] = useState(20);
  const [detour, setDetour] = useState(initial.detourMin);
  const [dratio, setDratio] = useState(initial.detourRatio);
  const [minTrip, setMinTrip] = useState(initial.minTripKm);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ text: string; at: string } | null>(null);   // the server's refusal of these very settings
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }; window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true); }, [onClose]);

  const counts = (d: number, r: number) => { setDrivers(d); setRiders(r); setRatio(String(ratioOf(d, r))); };
  const typedRatio = (t: string) => { setRatio(t); const d = driversForRatio(riders, Number(t)); if (t.trim() !== '' && d != null) setDrivers(d); };
  const available = Object.fromEntries(GROUPS.map((g) => [g, byGroup[g].length > 0])) as Record<Group, boolean>;
  const form = { drivers, riders, seed, shares, capacity, start: toSec(start), end: toSec(end), driverWindowMin: dw, riderWindowMin: rw, detourMin: detour, detourRatio: dratio, minTripKm: minTrip };
  const problem = randomizeError(form, available, fleet);
  const split = splitCounts(drivers, GROUPS.map((g) => shares[g] || 0));
  const total = sharesTotal(shares);
  const settings = JSON.stringify([form, where, where === 'rect' ? rect : null, chosen]);
  const generate = async () => {
    if (problem || busy) return;
    const used = GROUPS.filter((g) => shares[g] > 0);
    const params: AuthoringParams = { n_drivers: drivers, n_riders: riders, seed, bbox: where === 'rect' ? rect : null, departure: [form.start, form.end],
      driver_window_s: Math.round(dw * 60), rider_window_s: Math.round(rw * 60), max_detour_s: Math.round(detour * 60), max_detour_ratio: dratio, min_trip_m: Math.round(minTrip * 1000),
      ...(fleet ? { capacity, shares: Object.fromEntries(used.map((g) => [g, shares[g]])), profiles: used.map((g) => byGroup[g].find((p) => p.id === chosen[g]) ?? byGroup[g][0]),
        vehicles: Object.fromEntries(used.map((g) => [g, chosen[g] || byGroup[g][0].id])) } : {}) };
    setBusy(true); setRefused(null);
    try { await onGenerate(params); } catch (e) { setRefused({ text: errText(e), at: settings }); } finally { setBusy(false); }
  };
  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

  return <div className="overlay top rz-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <form className="drawer rz-modal form" noValidate role="dialog" aria-modal="true" aria-label={tr('randomize participants')} onSubmit={(e) => { e.preventDefault(); generate(); }}>
      <div className="row gap drawer-head"><h2 className="grow"><Shuffle size={16} /> {tr('Randomize')}</h2>
        <button type="button" className="btn icon ghost" aria-label={tr('close')} onClick={onClose}><X size={16} /></button></div>
      <p className="small muted">{tr('Random trips on the road network of {area}, drawn with a seed: the same settings and seed give the same scenario. The result replaces the current participants and stays editable; nothing is saved or solved here.', { area: area.name })}</p>

      <div className="rz-grid">
        <label>{tr('Drivers')} <CountInput min={1} max={100} value={drivers} onChange={(n) => counts(n, riders)} aria-label={tr('number of drivers')} /></label>
        <label>{tr('Riders')} <CountInput min={1} max={100} value={riders} onChange={(n) => counts(drivers, n)} aria-label={tr('number of riders')} /></label>
        <label title={tr('Drivers per rider. Changing it sets the number of drivers; the riders stay.')}>{tr('Drivers per rider')}
          <input type="number" min={0.01} max={100} step="any" value={ratio} onChange={(e) => typedRatio(e.target.value)} onBlur={() => setRatio(String(ratioOf(drivers, riders)))} aria-label={tr('driver-to-rider ratio')} /></label>
      </div>

      {fleet && <fieldset><legend className="row gap">{tr('Vehicles')} <span className={`badge ${Math.abs(total - 100) > 0.01 ? 'bad' : 'ok'}`} aria-label={tr('share total')}>{total} %</span></legend>
        <div className="rz-fleet">{GROUPS.map((g, i) => <div key={g} className={`rz-share${available[g] ? '' : ' off'}`}>
          <label><span className="row"><VehicleIcon powertrain={GROUP_PT[g]} size={15} /> {tr(GROUP_LABEL[g])} %</span>
            <input type="number" min={0} max={100} step={5} disabled={!available[g]} value={Number.isNaN(shares[g]) ? '' : shares[g]} onChange={(e) => setShares({ ...shares, [g]: num(e.target.value) })} aria-label={tr(`${g} share`)} /></label>
          {byGroup[g].length > 1 ? <select aria-label={tr(`${g} vehicle`)} value={chosen[g]} onChange={(e) => setChosen({ ...chosen, [g]: e.target.value })} className="small">{byGroup[g].map((p) => <option key={p.id} value={p.id}>{vehicleName(p)}</option>)}</select>
            : <span className="tiny muted">{byGroup[g][0] ? vehicleName(byGroup[g][0]) : tr('no profile of this type')}</span>}
          <span className="tiny muted">{tr('{n} of {m} drivers', { n: split[i], m: drivers })}</span>
        </div>)}</div>
        <label className="rz-cap" title={tr('Recorded with each vehicle. This problem matches one rider per driver, whatever the capacity.')}>{tr('Seats per vehicle')}
          <input type="number" min={1} max={60} step={1} value={Number.isNaN(capacity) ? '' : capacity} onChange={(e) => setCapacity(num(e.target.value))} aria-label={tr('vehicle capacity default')} /></label>
      </fieldset>}

      <fieldset><legend>{tr('Where')}</legend>
        <div className="seg" role="group" aria-label={tr('generation area')}>
          <button type="button" className={where === 'area' ? 'on' : ''} aria-pressed={where === 'area'} onClick={() => setWhere('area')}>{tr('Whole area')}</button>
          <button type="button" className={where === 'rect' ? 'on' : ''} aria-pressed={where === 'rect'} onClick={() => setWhere('rect')}>{tr('Rectangle')}</button></div>
        {where === 'rect' && <><div className="rz-map"><LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} rects={[{ bbox: area.bbox, color: COLORS.area }]} fitKey={area.area_id} height="100%"
          box={{ bbox: rect, color: COLORS.route, onChange: (b) => { const c = clipBox(b, area.bbox); if (c[0] < c[2] && c[1] < c[3]) setRect(c.map((x) => Number(x.toFixed(5))) as BBox); else setRect([...rect] as BBox); } }}
          onClick={(lat, lon) => { if (!insideBox(lat, lon, area.bbox)) return; const h = (rect[2] - rect[0]) / 2, w = (rect[3] - rect[1]) / 2; setRect(clipBox([lat - h, lon - w, lat + h, lon + w], area.bbox).map((x) => Number(x.toFixed(5))) as BBox); }} /></div>
          <p className="tiny muted">{tr('Drag the corners to resize the rectangle, its centre to move it, or click the map to centre it there. Start and end points are drawn on the roads inside it.')}</p></>}
      </fieldset>

      <fieldset><legend>{tr('When')}</legend>
        <div className="rz-grid">
          <label title={tr('The same time twice gives one departure time for everyone.')}>{tr('Departures from')} <input className="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label={tr('departures from')} /></label>
          <label>{tr('to')} <input className="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label={tr('departures to')} /></label>
          <span />
          <label title={tr('How long after the drawn time a driver may still leave.')}>{tr('Driver departure window (min)')} <input type="number" min={0} max={240} value={Number.isNaN(dw) ? '' : dw} onChange={(e) => setDw(num(e.target.value))} aria-label={tr('driver departure window')} /></label>
          <label title={tr('How long after the drawn time a rider may still be picked up. This problem has no drop-off window.')}>{tr('Rider pick-up window (min)')} <input type="number" min={0} max={240} value={Number.isNaN(rw) ? '' : rw} onChange={(e) => setRw(num(e.target.value))} aria-label={tr('rider pick-up window')} /></label>
        </div>
      </fieldset>

      <div className="rz-grid">
        <label>{tr('Max detour (min)')} <input type="number" min={0} max={120} value={Number.isNaN(detour) ? '' : detour} onChange={(e) => setDetour(num(e.target.value))} aria-label={tr('maximum detour minutes')} /></label>
        <label>{tr('Max detour ratio')} <input type="number" min={0} max={5} step={0.1} value={Number.isNaN(dratio) ? '' : dratio} onChange={(e) => setDratio(num(e.target.value))} aria-label={tr('maximum detour ratio')} /></label>
        <label>{tr('Min trip (km)')} <input type="number" min={0.2} max={50} step={0.1} value={Number.isNaN(minTrip) ? '' : minTrip} onChange={(e) => setMinTrip(num(e.target.value))} aria-label={tr('minimum trip km')} /></label>
      </div>

      <div className="row gap rz-seed"><label className="row gap">{tr('Seed')} <CountInput min={0} max={1000000} value={seed} onChange={setSeed} aria-label={tr('random seed')} style={{ width: '7.5em' }} /></label>
        <button type="button" className="btn sm" onClick={() => setSeed(1 + Math.floor(Math.random() * 999_999))} title={tr('Another seed: other places and times, same settings')}><Dices size={13} /> {tr('New seed')}</button>
        <span className="tiny muted grow">{tr('The seed and these settings are recorded with the scenario.')}</span></div>

      <div className="drawer-foot rz-foot">
        {(problem || refused?.at === settings) && <p className="note warn small" role="alert">{problem ? tr(problem.text, problem.vars) : refused?.text}</p>}
        <div className="row gap"><span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn primary" disabled={!!problem || busy} aria-busy={busy}><Shuffle size={14} /> {busy ? tr('Generating…') : tr('Generate')}</button></div></div>
    </form>
  </div>;
}
