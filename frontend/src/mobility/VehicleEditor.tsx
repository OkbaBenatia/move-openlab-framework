import { useEffect, useState } from 'react';
import { Copy, Plus, Save, X } from 'lucide-react';
import { errText } from '../components/common';
import { tr } from '../i18n';
import { POWERTRAIN_LABEL, mob, vehicleName, type ParamDef, type ParamRecord, type VehicleProfile, type VehiclesInfo } from './api';

const FUEL = ['fuel_consumption_l_100km', 'fuel_emission_factor_g_per_l'];
const ELEC = ['electricity_consumption_kwh_100km', 'electricity_emission_factor_g_per_kwh'];
const DIRECT = 'direct_co2_g_per_km';
/** Parameters that matter for a powertrain (others stay hidden; nothing is ever defaulted). */
export const relevant = (pt: string): string[] => pt === 'BEV' ? [...ELEC, DIRECT] : pt === 'PHEV' || pt === 'custom' ? [...FUEL, ...ELEC, DIRECT] : [...FUEL, DIRECT];

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vehicle';
const blank = (): VehicleProfile => ({ id: '', name: '', category: 'car', passenger_capacity: 4, powertrain: 'ICE', energy: 'petrol', parameters: {}, provenance: { kind: 'researcher' } });

/** Vehicle profiles: presets (read-only, duplicate to edit) and the researcher's own (create, edit, duplicate). */
export function VehicleEditor({ info, onChange, onClose, setErr }: { info: VehiclesInfo; onChange: () => void; onClose: () => void; setErr: (s: string | null) => void }) {
  const [sel, setSel] = useState<VehicleProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const isPreset = (p: VehicleProfile | null) => !!p && info.presets.some((x) => x.id === p.id) && !info.mine.some((x) => x.id === p.id);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); onChange(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };
  return <div className="overlay" role="dialog" aria-label={tr('vehicle profiles')} onClick={onClose}>
    <div className="drawer wide" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><h2>{tr('Vehicles')}</h2><span className="grow" /><button className="btn icon" aria-label={tr('close')} onClick={onClose}><X size={15} /></button></div>
      <div className="veh-grid">
        <div>
          <div className="row gap"><button className="btn sm" onClick={() => setSel(blank())}><Plus size={12} /> {tr('New')}</button></div>
          {[['Presets', info.presets], ['My profiles', info.mine]].map(([label, list]) => <div key={label as string}>
            <h3>{tr(label as string)}</h3>
            {(list as VehicleProfile[]).length === 0 ? <p className="small muted">{tr('None yet.')}</p> : <ul className="people" aria-label={tr(label as string)}>
              {(list as VehicleProfile[]).map((p) => <li key={p.id}><button onClick={() => setSel(p)} className={sel?.id === p.id ? 'hl' : ''}>
                <b>{vehicleName(p)}</b><span className="muted small">{tr(POWERTRAIN_LABEL[p.powertrain])} · {tr('{n} seats', { n: p.passenger_capacity })}</span></button></li>)}</ul>}
          </div>)}
        </div>
        {sel && <ProfileForm key={sel.id || 'new'} profile={sel} defs={info.parameters} powertrains={info.powertrains} readOnly={isPreset(sel)} busy={busy}
          onSave={(p) => act(async () => { const saved = await mob.saveVehicle(p); setSel(saved); })}
          onDuplicate={() => act(async () => { const d = await mob.duplicateVehicle(sel.id); setSel(d); })} />}
      </div>
    </div>
  </div>;
}

function ProfileForm({ profile, defs, powertrains, readOnly, busy, onSave, onDuplicate }: {
  profile: VehicleProfile; defs: ParamDef[]; powertrains: string[]; readOnly: boolean; busy: boolean; onSave: (p: VehicleProfile) => void; onDuplicate: () => void;
}) {
  const [p, setP] = useState<VehicleProfile>(profile);
  const [auto, setAuto] = useState(!profile.id);
  useEffect(() => setP(profile), [profile]);
  const set = (patch: Partial<VehicleProfile>) => setP({ ...p, ...patch });
  const rec = (id: string): ParamRecord => p.parameters[id] ?? { value: null, unit: defs.find((d) => d.id === id)?.unit ?? '' };
  const setRec = (id: string, patch: Partial<ParamRecord>) => {
    const r = { ...rec(id), ...patch };
    const next = { ...p.parameters };
    if (r.value == null && !r.source && !r.notes) delete next[id]; else next[id] = r;
    set({ parameters: next });
  };
  const shown = defs.filter((d) => relevant(p.powertrain).includes(d.id));
  const dis = readOnly || busy;
  return <form className="form" onSubmit={(e) => { e.preventDefault(); onSave(p); }} aria-label={tr('vehicle profile')}>
    <label>{tr('Name')} <input value={p.name} disabled={dis} aria-label={tr('vehicle name')} onChange={(e) => setP({ ...p, name: e.target.value, id: auto ? slug(e.target.value) : p.id })} /></label>
    <div className="row gap">
      <label>{tr('Powertrain')} <select value={p.powertrain} disabled={dis} aria-label={tr('powertrain')} onChange={(e) => set({ powertrain: e.target.value as VehicleProfile['powertrain'] })}>
        {powertrains.map((x) => <option key={x} value={x}>{tr(POWERTRAIN_LABEL[x] ?? x)}</option>)}</select></label>
      <label>{tr('Energy')} <input value={p.energy} disabled={dis} aria-label={tr('energy')} onChange={(e) => set({ energy: e.target.value })} style={{ width: '9em' }} /></label>
      <label>{tr('Passenger seats')} <input type="number" min={1} max={60} value={p.passenger_capacity} disabled={dis} aria-label={tr('passenger capacity')} onChange={(e) => set({ passenger_capacity: Number(e.target.value) })} style={{ width: '5em' }} /></label>
    </div>
    <table className="compact" aria-label={tr('vehicle parameters')}><thead><tr><th>{tr('Parameter')}</th><th>{tr('Value')}</th><th>{tr('Unit')}</th><th>{tr('Source')}</th></tr></thead>
      <tbody>{shown.map((d) => { const r = rec(d.id); return <tr key={d.id}>
        <td>{tr(d.label)}</td>
        <td><input type="number" min={0} step="any" value={r.value ?? ''} disabled={dis} aria-label={tr(d.label)} style={{ width: '7em' }} onChange={(e) => setRec(d.id, { value: e.target.value === '' ? null : Number(e.target.value) })} /></td>
        <td className="small">{r.unit}{d.factor && <> <select value={r.basis ?? 'CO2'} disabled={dis} aria-label={tr('{label} basis', { label: tr(d.label) })} onChange={(e) => setRec(d.id, { basis: e.target.value as 'CO2' | 'CO2e' })}><option>CO2</option><option>CO2e</option></select></>}</td>
        <td className="small">{readOnly ? <span className="desc">{r.source ?? '—'}{r.source_version ? ` · ${r.source_version}` : ''}{r.applicability ? ` · ${r.applicability}` : ''}</span>
          : <input value={r.source ?? ''} disabled={dis} aria-label={tr('{label} source', { label: tr(d.label) })} placeholder={tr('source')} onChange={(e) => setRec(d.id, { source: e.target.value || undefined })} />}</td></tr>; })}</tbody></table>
    {!readOnly && <details className="small"><summary>{tr('Advanced')}</summary>
      <div className="form">
        <div className="row gap"><label>{tr('Id')} <input value={p.id} disabled={!!profile.id} aria-label={tr('vehicle id')} onChange={(e) => { setAuto(false); set({ id: e.target.value }); }} /></label>
          <label>{tr('Category')} <input value={p.category} aria-label={tr('category')} onChange={(e) => set({ category: e.target.value })} style={{ width: '8em' }} /></label></div>
        {shown.map((d) => { const r = rec(d.id); return <fieldset key={d.id}><legend className="small">{tr(d.label)}</legend>
          <div className="row gap">
            <label className="small">{tr('Source version')} <input value={r.source_version ?? ''} aria-label={tr('{label} source version', { label: tr(d.label) })} onChange={(e) => setRec(d.id, { source_version: e.target.value || undefined })} /></label>
            <label className="small">{tr('Applicability')} <input value={r.applicability ?? ''} aria-label={tr('{label} applicability', { label: tr(d.label) })} onChange={(e) => setRec(d.id, { applicability: e.target.value || undefined })} /></label>
            <label className="small grow">{tr('Notes')} <input value={r.notes ?? ''} aria-label={tr('{label} notes', { label: tr(d.label) })} onChange={(e) => setRec(d.id, { notes: e.target.value || undefined })} /></label>
          </div>{r.recorded_at && <span className="small muted">{tr('recorded {date}', { date: r.recorded_at.slice(0, 10) })}</span>}</fieldset>; })}
      </div></details>}
    {readOnly && p.provenance?.notes && <p className="small muted">{tr(p.provenance.notes)}</p>}
    <div className="row gap">
      {!readOnly && <button className="btn primary sm" type="submit" disabled={busy || p.name.trim().length < 1}><Save size={12} /> {tr('Save')}</button>}
      {profile.id && <button className="btn sm" type="button" disabled={busy} onClick={onDuplicate}><Copy size={12} /> {tr('Duplicate')}</button>}
      {p.version && <span className="small muted">{tr('version {n}', { n: p.version })}{p.updated_at ? ` · ${p.updated_at.slice(0, 10)}` : ''}</span>}
    </div>
  </form>;
}
