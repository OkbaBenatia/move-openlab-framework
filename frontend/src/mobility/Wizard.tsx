import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Play, Plus, Save, Search, Shuffle, Square, Trash2, Undo2, X } from 'lucide-react';
import { CarIcon, RiderIcon, VehicleIcon } from '../components/DomainIcons';
import type { Json, MethodRef } from '../api/client';
import { JobProgress } from '../components/JobProgress';
import { CountInput } from '../components/CountInput';
import { errText, num } from '../components/common';
import { COLORS, LeafletMap, POWERTRAIN_GLYPH, type BBox, type MapApi, type MapLine, type MapPoint } from '../geo/LeafletMap';
import { geo, hhmm, km, mins, toSec, type Agent, type Area, type GeoConfig, type Scenario } from '../geo/api';
import type { DatasetItem } from '../lab/useLabData';
import { methodKey } from '../lab/ResultPanel';
import { tr } from '../i18n';
import { BASELINE_LABEL, SCOPE_LABEL, mob, vehicleName, type Compose, type EmissionsConfig, type Preview, type VehicleProfile, type VehiclesInfo } from './api';
import { VehicleEditor } from './VehicleEditor';
import { GROUPS, GROUP_LABEL, groupOf, nextId, popUndo, pushUndo, withCapacity, type AuthoringParams, type Group } from './authoring';
import { Palette, type PaletteItem } from './Palette';
import { ParticipantPanel, type ParticipantDraft } from './ParticipantPanel';
import { RandomizeModal } from './RandomizeModal';

type Source = 'synthetic' | 'dataset' | 'manual';
type Role = 'drivers' | 'riders';
interface People { drivers: Agent[]; riders: Agent[] }
/** What Undo restores: the participants, their vehicles and where they came from. */
interface Snap { source: Source; manual: People; assign: Record<string, string>; vehicleId: string; extra: VehicleProfile[]; reloc: number | null; origin: Compose | null; detour: number; ratio: number }
const GROUP_PT: Record<Group, string> = { combustion: 'ICE', hybrid: 'HEV', electric: 'BEV' };
const STEPS = ['Area & Data', 'Participants & Vehicles', 'Constraints', 'Methods & Experiment', 'Review & Save'];
const around = (lat: number, lon: number, halfKm = 2.5): BBox => {
  const dl = halfKm / 111.2, dn = halfKm / (111.2 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [lat - dl, lon - dn, lat + dl, lon + dn].map((x) => Number(x.toFixed(5))) as BBox;
};
const overlaps = (a: BBox | null | undefined, b: BBox | null | undefined) => !!a && !!b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

export interface WizardProps {
  cfg: GeoConfig; areas: Area[]; datasets: DatasetItem[]; methods: MethodRef[]; areaId?: string; datasetKey?: string;   // datasetKey: start from this mobility data (Library › Use)
  initial?: { scenario: Scenario & { vehicles?: Json; emissions?: EmissionsConfig }; parent?: string; fromInstance?: string;
    /** opened from the Workspace's Participants panel: straight to the participants step, adding a driver or a rider (placed by
     *  clicks on the map), opening the Randomize dialog, or opening the details of the participant `select` */
    action?: 'driver' | 'rider' | 'randomize' | 'edit'; select?: string } | null;
  onClose: () => void; onSaved: (rec: Json) => void; onRun: (r: { campaign_id: string; job: Json }) => void;
  reloadAreas: () => void; setErr: (s: string | null) => void; onAddMethod?: () => void;
}

/** Scenario creation in five steps over the map. Nothing is stored before the Review step's Save buttons. */
/** A mobility dataset as people read it: source, release and how many observed trips fall in the area (no coordinates). */
const dsLabel = (d?: DatasetItem) => !d ? '' : d.provider === 'rpc'
  ? `RPC ${d.release ?? ''} · ${d.rows_kept != null ? tr('{n} observed trips in this area', { n: d.rows_kept }) : d.name}` : d.name;

export function Wizard({ cfg, areas, datasets, methods, areaId: areaId0, datasetKey: datasetKey0, initial, onClose, onSaved, onRun, reloadAreas, setErr, onAddMethod }: WizardProps) {
  const [step, setStep] = useState(initial?.action ? 2 : 1);
  const [areaId, setAreaId] = useState(() => initial ? (areas.find((a) => a.network_id === initial.scenario.network_id)?.area_id ?? '') : (areaId0 && areas.some((a) => a.area_id === areaId0) ? areaId0 : areas.find((a) => a.network_id)?.area_id ?? ''));
  const [source, setSource] = useState<Source>(initial ? 'manual' : datasetKey0 ? 'dataset' : 'synthetic');
  const [datasetKey, setDatasetKey] = useState(datasetKey0 ?? '');
  const [f, setF] = useState({ name: initial?.scenario.name ?? '', n_drivers: 10, n_riders: 15, seed: 1, start: '07:00', end: '09:00', date: '', detour: Math.round((initial?.scenario.params.max_detour_s ?? 900) / 60), ratio: initial?.scenario.params.max_detour_ratio ?? 0.5, min_trip_km: 1.5 });
  const [manual, setManual] = useState<{ drivers: Agent[]; riders: Agent[] }>({ drivers: initial?.scenario.drivers ?? [], riders: initial?.scenario.riders ?? [] });
  const [pick, setPick] = useState<{ role: Role; id: string; field: 'origin' | 'destination'; fresh?: boolean; item?: string } | null>(null);
  const [routes, setRoutes] = useState<Record<string, { line?: MapLine; text: string; error?: boolean }>>({});
  const [veh, setVeh] = useState<VehiclesInfo | null>(null);
  const [vehicleId, setVehicleId] = useState<string>(initial?.scenario.vehicles?.default ?? '');
  const [assign, setAssign] = useState<Record<string, string>>(initial?.scenario.vehicles?.assignments ?? {});
  const [editor, setEditor] = useState(false);
  const [emis, setEmis] = useState<EmissionsConfig>(initial?.scenario.emissions ?? { scope: 'operational-energy', baseline: 'everyone-drives-alone' });
  const [title, setTitle] = useState(() => tr('Experiment {date}', { date: stamp() }));
  const [checked, setChecked] = useState<string[]>([]);
  const [reps, setReps] = useState(3);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Json[] | null>(null);
  const [mapMode, setMapMode] = useState<'none' | 'point' | 'draw'>('none');
  const [draft, setDraft] = useState<{ name: string; bbox: BBox; profile: string; origin?: Json } | null>(null);
  const [corner, setCorner] = useState<[number, number] | null>(null);
  const [job, setJob] = useState<Json | null>(null);
  const [focus, setFocus] = useState<{ key: string; bbox: BBox } | null>(null);
  const [boxKm, setBoxKm] = useState(5);
  const [reloc, setReloc] = useState<number | null>(null);      // seed of the last "Randomize locations" (manual)
  const [extra, setExtra] = useState<VehicleProfile[]>([]);     // profiles made while editing (another capacity, a generated fleet)
  const [origin, setOrigin] = useState<Compose | null>(null);   // the composition the hand-edited participants started from (provenance)
  const [past, setPast] = useState<Snap[]>([]);                 // Undo
  const [detail, setDetail] = useState<{ role: Role; id: string; isNew?: boolean } | null>(null);
  const [panelErr, setPanelErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);    // why a placement or a move was refused
  const [randomOpen, setRandomOpen] = useState(false);
  const [redraw, setRedraw] = useState(0);                      // a refused marker move: markers back in place
  const mapApi = useRef<MapApi | null>(null);
  const area = areas.find((a) => a.area_id === areaId) ?? null;
  const netReady = !!area?.network_id;
  const shownDatasets = useMemo(() => datasets.filter((d) => overlaps(d.bbox, area?.bbox)), [datasets, area]);
  // the profiles frozen in an edited scenario stay available (e.g. a demonstration vehicle that is not a preset)
  const frozen: VehicleProfile[] = useMemo(() => ((initial?.scenario.vehicles?.profiles ?? []) as VehicleProfile[]), [initial]);
  const allProfiles: VehicleProfile[] = useMemo(() => { const base = veh ? [...veh.mine, ...veh.presets.filter((p) => !veh.mine.some((m) => m.id === p.id))] : [];
    const known = [...base, ...frozen.filter((f) => !base.some((b) => b.id === f.id))];
    return [...known, ...extra.filter((x) => !known.some((b) => b.id === x.id))]; }, [veh, frozen, extra]);
  const profile = allProfiles.find((p) => p.id === vehicleId) ?? null;
  const loadVehicles = useCallback(() => mob.vehicles().then((v) => { setVeh(v); setVehicleId((id) => id || (initial ? '' : v.default?.id ?? '')); }).catch((e) => setErr(errText(e))), [setErr, initial]);
  useEffect(() => { loadVehicles(); }, [loadVehicles]);
  useEffect(() => { setChecked((c) => c.length ? c : methods.filter((m) => m.source === 'builtin').map(methodKey)); }, [methods]);
  useEffect(() => { if (area) setFocus({ key: area.area_id, bbox: area.bbox }); }, [area]);
  useEffect(() => { if (!shownDatasets.some((d) => d.dataset_key === datasetKey)) setDatasetKey(shownDatasets[0]?.dataset_key ?? ''); }, [shownDatasets, datasetKey]);
  // the suggested name follows the chosen area and source until the researcher types one
  const autoName = useRef(!initial?.scenario.name);
  useEffect(() => { if (area && autoName.current) setF((x) => ({ ...x, name: `${area.name} · ${source === 'manual' ? tr('scenario') : tr('demand')}` })); }, [area, source]);

  // vehicles and emissions as the scenario carries them
  const vehicles = () => {
    if (!profile) return null;
    const used = new Set([profile.id, ...Object.values(assign)]);
    return { profiles: allProfiles.filter((p) => used.has(p.id)), default: profile.id, assignments: Object.fromEntries(Object.entries(assign).filter(([, v]) => v !== profile.id)) };
  };
  const compose = (): Compose | null => {
    if (!area?.network_id) return null;
    return { source, network_id: area.network_id, name: f.name.trim() || tr('New scenario'), n_drivers: f.n_drivers, n_riders: f.n_riders, seed: f.seed, start_s: toSec(f.start), end_s: toSec(f.end),
      params: { max_detour_s: Math.round(f.detour * 60), max_detour_ratio: f.ratio }, min_trip_m: Math.round(f.min_trip_km * 1000), dataset_key: source === 'dataset' ? datasetKey : null,
      date: source === 'dataset' && f.date ? f.date : null, drivers: source === 'manual' ? manual.drivers : undefined, riders: source === 'manual' ? manual.riders : undefined,
      vehicles: vehicles(), emissions: profile ? emis : null };
  };
  const composeKey = JSON.stringify([step >= 2, areaId, source, datasetKey, f, manual, vehicleId, assign, emis]);
  const timer = useRef<number | null>(null);
  useEffect(() => {                                         // the preview follows the parameters (nothing is stored)
    if (step < 2 || !netReady) return;
    const body = compose();
    if (!body || (source === 'manual' && (!manual.drivers.length || !manual.riders.length)) || (source === 'dataset' && !datasetKey)) { setPreview(null); return; }
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      mob.preview(body).then((p) => { setPreview(p); setPreviewErr(null); }).catch((e) => { setPreview(null); setPreviewErr(errText(e)); });
    }, 400);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [composeKey]);                                                          // eslint-disable-line react-hooks/exhaustive-deps

  // "Randomize locations": a new seed gives new places on the road network, inside the area; counts, ids and time
  // windows stay. Placed by hand, the participants get new places drawn by the server (recorded with the seed).
  const newSeed = (cur: number | null) => { let s: number; do s = 1 + Math.floor(Math.random() * 999_999); while (s === cur); return s; };
  const [relocSeed, setRelocSeed] = useState<number | null>(null);   // a seed typed by the researcher (reproducible)
  const randomize = (given?: number | null) => act(async () => {
    if (source !== 'manual') { setF((x) => ({ ...x, seed: newSeed(x.seed) })); return; }
    const body = compose(); if (!body) return;
    const seed = given ?? newSeed(reloc);
    const p = await mob.preview({ ...body, relocate_seed: seed });
    checkpoint();
    setManual({ drivers: p.scenario.drivers, riders: p.scenario.riders }); setRoutes({}); setPick(null); setDetail(null); setReloc(seed); setOrigin(null);
  });
  const basis = (): Compose | null => { const b = compose(); return !b ? null : source !== 'manual' ? b : reloc != null ? { ...b, relocate_seed: reloc } : origin; };
  // ------------------------------------------------------------ participants edited by hand (palette, map, details)
  const at = (p?: [number, number]) => (p ? `${p[0].toFixed(5)}, ${p[1].toFixed(5)}` : '');
  const started = useRef(false);
  const placing = useRef(false);
  const placed = (a: Agent) => a.origin[0] !== a.destination[0] || a.origin[1] !== a.destination[1];
  const current = (): People => (source === 'manual' ? manual : { drivers: preview?.scenario.drivers ?? [], riders: preview?.scenario.riders ?? [] });
  const checkpoint = () => { const now: Snap = { source, manual, assign, vehicleId, extra, reloc, origin, detour: f.detour, ratio: f.ratio }; setPast((p) => pushUndo(p, now)); };
  const undo = () => {
    const { stack, state } = popUndo(past);
    if (!state) return;
    setPast(stack); setSource(state.source); setManual(state.manual); setAssign(state.assign); setVehicleId(state.vehicleId); setExtra(state.extra); setReloc(state.reloc); setOrigin(state.origin);
    setF((x) => ({ ...x, detour: state.detour, ratio: state.ratio })); setPick(null); setDetail(null); setRoutes({}); setPanelErr(null); setNotice(null);
  };
  /** Every hand edit works on the scenario's own participants: those of a generator or a dataset are taken over as
   *  previewed (their provenance is kept; the edits are recorded when the scenario is saved). */
  const edit = (fn: (m: People) => People) => {
    if (source === 'manual') { setManual(fn); return; }
    setOrigin(compose()); setSource('manual'); setManual(fn(current()));
  };
  const forget = (id: string) => setRoutes((r) => { const n = { ...r }; delete n[id]; return n; });
  const add = (role: Role, opt: { vehicle?: string; at?: [number, number]; item?: string } = {}) => {
    if (!area) return;
    const cur = current(), id = nextId(role === 'drivers' ? 'D' : 'R', [...cur.drivers, ...cur.riders].map((a) => a.id));
    const [s, w, n, e] = area.bbox; const c: [number, number] = opt.at ?? [Number(((s + n) / 2).toFixed(5)), Number(((w + e) / 2).toFixed(5))];
    checkpoint();
    edit((m) => ({ ...m, [role]: [...m[role], { id, origin: c, destination: c, earliest: 7 * 3600 + 30 * 60, latest: role === 'drivers' ? 7 * 3600 + 45 * 60 : 7 * 3600 + 50 * 60 }] }));
    if (role === 'drivers' && opt.vehicle) { if (!vehicleId) setVehicleId(opt.vehicle); else if (opt.vehicle !== vehicleId) setAssign((a) => ({ ...a, [id]: opt.vehicle! })); }
    setPick({ role, id, field: opt.at ? 'destination' : 'origin', fresh: true, item: opt.item ?? (role === 'drivers' ? 'driver' : 'rider') });
    setDetail(null); setPanelErr(null); setNotice(null);
  };
  // the palette: an item is a driver, a rider, or a driver with a vehicle of one type
  const paletteAdd = (item: string, where?: [number, number]) => {
    if (item === 'rider') return add('riders', { at: where, item });
    if (item === 'driver') return add('drivers', { at: where, item });
    const g = item.replace('vehicle:', '') as Group;
    const p = profile && groupOf(profile.powertrain) === g ? profile : allProfiles.find((x) => groupOf(x.powertrain) === g);
    if (p) add('drivers', { at: where, item, vehicle: p.id });
  };
  const paletteDrop = async (item: string, x: number, y: number) => {
    const ll = mapApi.current?.toLatLng(x, y);
    if (!ll || !area?.network_id) { setNotice(tr('Drop the item on the map, inside the working area.')); return; }
    try { const sn = await mob.snap(area.network_id, ll[0], ll[1]); paletteAdd(item, sn.point); } catch (e) { setNotice(errText(e)); }
  };
  const openDetail = (id: string) => {
    const cur = current(), role: Role | null = cur.drivers.some((a) => a.id === id) ? 'drivers' : cur.riders.some((a) => a.id === id) ? 'riders' : null;
    if (!role) return;
    setPick(null); setPanelErr(null); setDetail({ role, id });
  };
  useEffect(() => {                                     // the Workspace's + Driver / + Rider / Randomize / Edit
    if (started.current || !initial?.action || !area?.network_id) return;
    started.current = true;
    if (initial.action === 'randomize') setRandomOpen(true);
    else if (initial.action === 'edit') { if (initial.select) openDetail(initial.select); }
    else add(initial.action === 'driver' ? 'drivers' : 'riders');
  }, [area]);                                                               // eslint-disable-line react-hooks/exhaustive-deps
  const update = (role: Role, id: string, patch: Partial<Agent>) => { checkpoint(); edit((m) => ({ ...m, [role]: m[role].map((a) => (a.id === id ? { ...a, ...patch } : a)) })); };
  const remove = (role: Role, id: string, undoable = true) => {
    if (undoable) checkpoint();
    edit((m) => ({ ...m, [role]: m[role].filter((a) => a.id !== id) })); forget(id);
    setAssign((a) => { const n = { ...a }; delete n[id]; return n; });
    if (detail?.id === id) setDetail(null);
    if (pick?.id === id) setPick(null);
  };
  /** A point chosen on the map for the participant being placed: snapped to the road network by the server, refused
   *  (with the reason, the participant stays as it was) outside the area or too far from a road. */
  const place = async (lat: number, lon: number) => {
    const p = pick;
    if (!p || !area?.network_id || placing.current) return;
    const was = current()[p.role].find((a) => a.id === p.id);
    if (!was) { setPick(null); return; }
    placing.current = true;
    try {
      const sn = await mob.snap(area.network_id, lat, lon);
      const other = p.field === 'origin' ? was.destination : was.origin, first = p.field === 'origin' && !placed(was);
      if (!first && sn.point[0] === other[0] && sn.point[1] === other[1]) throw new Error(tr('the start and the destination are at the same road node: place them further apart'));
      if (!p.fresh) checkpoint();
      // until its destination is chosen a participant has one place only (start and destination together: not placed yet)
      edit((m) => ({ ...m, [p.role]: m[p.role].map((a) => (a.id === p.id ? (first ? { ...a, origin: sn.point, destination: sn.point } : { ...a, [p.field]: sn.point }) : a)) }));
      forget(p.id); setNotice(null);
      if (first) setPick({ ...p, field: 'destination' });
      else { setPick(null); if (p.fresh) { setPanelErr(null); setDetail({ role: p.role, id: p.id, isNew: true }); } }
    } catch (e) {
      const msg = errText(e); setNotice(`${p.id}: ${msg}`); setRoutes((r) => ({ ...r, [p.id]: { text: msg, error: true } }));
    } finally { placing.current = false; }
  };
  const cancelPick = () => { const p = pick; setPick(null); if (p?.fresh) remove(p.role, p.id, false); };
  /** A marker dragged to another place: accepted on the road network inside the area, otherwise put back. */
  const moved = async (p: MapPoint, lat: number, lon: number) => {
    if (!p.ref || !area?.network_id) return;
    const role: Role = p.kind?.startsWith('driver') ? 'drivers' : 'riders', field = p.kind?.endsWith('-end') ? 'destination' : 'origin';
    try {
      const sn = await mob.snap(area.network_id, lat, lon);
      checkpoint();
      edit((m) => ({ ...m, [role]: m[role].map((a) => (a.id === p.ref ? { ...a, [field]: sn.point } : a)) }));
      forget(p.ref); setNotice(null);
    } catch (e) { setNotice(`${p.ref}: ${errText(e)}`); setRedraw((n) => n + 1); }
  };
  /** The details form: the server checks the participant (places, direct trip, time window, latest arrival) first. */
  const saveParticipant = async (d: ParticipantDraft) => {
    const det = detail, a = det && current()[det.role].find((x) => x.id === det.id);
    if (!det || !a || !area?.network_id || inFlight.current) return;
    inFlight.current = true; setBusy(true); setPanelErr(null);
    try {
      const r = await mob.participant(area.network_id, det.role === 'drivers' ? 'driver' : 'rider',
        { id: d.id, origin: a.origin, destination: a.destination, earliest: d.earliest, latest: d.latest, ...(d.arriveBy != null ? { arrive_by: d.arriveBy } : {}) });
      checkpoint();
      edit((m) => ({ ...m, [det.role]: m[det.role].map((x) => (x.id === det.id ? { id: r.id, origin: r.origin, destination: r.destination, earliest: r.earliest, latest: r.latest } : x)) }));
      if (det.role === 'drivers') {
        let target = d.vehicle;
        const base = allProfiles.find((p) => p.id === d.vehicle);
        if (base && d.capacity != null && d.capacity !== base.passenger_capacity) {          // another capacity: another profile
          const v = withCapacity(base, d.capacity, vehicleName(base), tr('{n} seats'));
          target = v.id;
          if (!allProfiles.some((p) => p.id === v.id && p.passenger_capacity === d.capacity)) setExtra((x) => [...x.filter((p) => p.id !== v.id), v]);
        }
        setAssign((as) => { const n = { ...as }; delete n[det.id]; if (target && target !== vehicleId) n[r.id] = target; return n; });
      }
      forget(det.id); setDetail(null); setNotice(null);
    } catch (e) { setPanelErr(errText(e)); } finally { inFlight.current = false; setBusy(false); }
  };
  const closeDetail = () => { const det = detail; setDetail(null); setPanelErr(null); if (det?.isNew) remove(det.role, det.id, false); };
  /** Randomize: the server generates and validates; the result replaces the participants and stays editable. */
  const generate = async (params: AuthoringParams) => {
    const base = compose();
    if (!base || !area) return;
    const body: Compose = { ...base, source: 'manual', drivers: [], riders: [], vehicles: null, emissions: null, authoring: params,
      params: { max_detour_s: params.max_detour_s, max_detour_ratio: params.max_detour_ratio } };
    const p = await mob.preview(body);                    // a refusal is shown in the dialog, nothing changes
    checkpoint();
    setSource('manual'); setManual({ drivers: p.scenario.drivers, riders: p.scenario.riders });
    const v = p.scenario.vehicles;
    if (v) {                                              // the generated fleet: profiles the editor did not know yet are kept with the scenario
      const known = new Set(allProfiles.filter((q) => !extra.some((y) => y.id === q.id)).map((q) => q.id));
      setExtra((x) => [...x.filter((q) => !v.profiles.some((n) => n.id === q.id)), ...v.profiles.filter((n) => !known.has(n.id))]);
      setVehicleId(v.default); setAssign(v.assignments);
    } else setAssign({});
    setF((x) => ({ ...x, detour: Math.round(params.max_detour_s / 60), ratio: params.max_detour_ratio }));
    setOrigin(body); setReloc(null); setRoutes({}); setPick(null); setDetail(null); setNotice(null); setRandomOpen(false);
    setFocus({ key: `g${Date.now()}`, bbox: params.bbox ?? area.bbox });
  };
  const undoRef = useRef(undo);
  undoRef.current = undo;
  useEffect(() => {                                     // Ctrl+Z (a text field keeps its own undo)
    if (step !== 2 || randomOpen) return;
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return;
      e.preventDefault(); undoRef.current();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [step, randomOpen]);
  const route = async (a: Agent) => {
    if (!area?.network_id) return;
    setRoutes((r) => ({ ...r, [a.id]: { text: '…' } }));
    try {
      const r = await geo.route(area.network_id, a.origin, a.destination);
      setRoutes((x) => ({ ...x, [a.id]: { line: { coords: r.coords, color: COLORS.route, weight: 4, label: `${a.id}: ${mins(r.time_s)} · ${km(r.length_m)}` }, text: `${mins(r.time_s)} · ${km(r.length_m)}` } }));
      const la = r.coords.map((c: number[]) => c[0]), lo = r.coords.map((c: number[]) => c[1]);
      setFocus({ key: `r${a.id}${Date.now()}`, bbox: [Math.min(...la), Math.min(...lo), Math.max(...la), Math.max(...lo)] });
    } catch (e) { setRoutes((x) => ({ ...x, [a.id]: { text: errText(e), error: true } })); }
  };
  const onMap = async (lat: number, lon: number) => {
    if (step === 1 && mapMode === 'point') {                 // a draft box: nothing is saved until "Create area"
      setMapMode('none');
      setDraft({ name: tr('Area {lat}, {lon}', { lat: lat.toFixed(3), lon: lon.toFixed(3) }), bbox: around(lat, lon, boxKm / 2), profile: draft?.profile ?? 'car' });
      return;
    }
    if (step === 1 && mapMode === 'draw') {
      if (!corner) { setCorner([lat, lon]); return; }
      const b: BBox = [Math.min(corner[0], lat), Math.min(corner[1], lon), Math.max(corner[0], lat), Math.max(corner[1], lon)].map((x) => Number(x.toFixed(5))) as BBox;
      setCorner(null); setMapMode('none');
      setDraft({ name: draft?.name ?? tr('Area {lat}, {lon}', { lat: lat.toFixed(3), lon: lon.toFixed(3) }), bbox: b, profile: draft?.profile ?? 'car' });
      return;
    }
    if (pick) await place(lat, lon);
  };

  // areas: search, pick on map, road network download
  const inFlight = useRef(false);                           // synchronous guard: a double click submits once
  const act = async (fn: () => Promise<unknown>) => { if (inFlight.current) return; inFlight.current = true; setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(errText(e)); } finally { inFlight.current = false; setBusy(false); } };
  const auto = !!cfg.geocoding?.autocomplete, minChars = cfg.geocoding?.min_chars ?? 2;
  const sTimer = useRef<number | null>(null);
  const search = (text = q) => act(async () => { try { const r = await geo.geocode(text); setResults(r.results); if (!r.results.length && !auto) setErr(tr('no place found for “{text}”', { text })); } catch (e) { if (!auto) throw e; setResults(null); } });
  const download = async (id: string) => { const r = await geo.areaNetwork(id); if (r.cached) reloadAreas(); else setJob(r.job); };
  const choose = (r: Json) => {                                 // a search result becomes a draft box to adjust
    let b = r.bbox as BBox;
    const prof = cfg.profiles.find((p) => p.id === (draft?.profile ?? 'car')) ?? cfg.profiles[0];
    if ((b[2] - b[0]) * (b[3] - b[1]) > prof.max_bbox_deg2) b = around(r.lat, r.lon, 4);
    setResults(null); setDraft({ name: String(r.name).split(',')[0].slice(0, 80), bbox: b, profile: prof.id, origin: { search: q, name: r.name, kind: r.kind } });
    setFocus({ key: `d${Date.now()}`, bbox: b });
  };
  const draftProfile = cfg.profiles.find((p) => p.id === draft?.profile) ?? cfg.profiles[0];
  const draftKm = draft ? [(draft.bbox[2] - draft.bbox[0]) * 111.2, (draft.bbox[3] - draft.bbox[1]) * 111.2 * Math.cos(((draft.bbox[0] + draft.bbox[2]) / 2) * Math.PI / 180)] : null;
  const draftTooBig = !!draft && !!draftProfile && (draft.bbox[2] - draft.bbox[0]) * (draft.bbox[3] - draft.bbox[1]) > draftProfile.max_bbox_deg2;
  const createDraft = () => draft && act(async () => {
    const a = await geo.createArea({ name: draft.name.trim() || tr('New area'), bbox: draft.bbox, profile: draft.profile, origin: draft.origin });
    setDraft(null); setQ(''); reloadAreas(); setAreaId(a.area_id);
    await download(a.area_id);
  });

  // map layers
  const layers = useMemo(() => {
    const points: MapPoint[] = [], lines: MapLine[] = [];
    const sc = source === 'manual' ? manual : preview?.scenario;
    const vOf = (id: string) => (vehicleId ? allProfiles.find((p) => p.id === (assign[id] ?? vehicleId)) : undefined);
    // in the participants step a marker opens its participant's details and can be dragged (once both points are placed)
    const own = (a: Agent) => (step === 2 ? { ref: a.id, drag: placed(a) } : {});
    for (const d of sc?.drivers ?? []) { const v = vOf(d.id);
      points.push({ lat: d.origin[0], lon: d.origin[1], color: COLORS.driver, kind: 'driver', glyph: POWERTRAIN_GLYPH[v?.powertrain ?? ''] ?? '', ...own(d), label: `${tr('{id} driver start', { id: d.id })} · ${hhmm(d.earliest)}–${hhmm(d.latest)}${v ? ` · ${vehicleName(v)}` : ''}` });
      if (placed(d)) points.push({ lat: d.destination[0], lon: d.destination[1], color: COLORS.driver, fill: false, kind: 'driver-end', ...own(d), label: tr('{id} driver end', { id: d.id }) }); }
    for (const r of sc?.riders ?? []) { points.push({ lat: r.origin[0], lon: r.origin[1], color: COLORS.rider, kind: 'rider', ...own(r), label: `${tr('{id} rider start', { id: r.id })} · ${hhmm(r.earliest)}–${hhmm(r.latest)}` }); if (placed(r)) points.push({ lat: r.destination[0], lon: r.destination[1], color: COLORS.rider, fill: false, kind: 'rider-end', ...own(r), label: tr('{id} rider end', { id: r.id }) }); }
    for (const r of Object.values(routes)) if (r.line) lines.push(r.line);
    return { points, lines };
  }, [source, manual, preview, routes, vehicleId, assign, allProfiles, step, redraw]);   // eslint-disable-line react-hooks/exhaustive-deps

  // saving
  const scenarioToSave = (): Json | null => {
    const body = compose();
    if (!body) return null;
    const base = source === 'manual' ? { drivers: manual.drivers, riders: manual.riders } : preview?.scenario;
    if (!base) return null;
    return { name: body.name, network_id: body.network_id, params: body.params, drivers: base.drivers, riders: base.riders, ...(body.vehicles ? { vehicles: body.vehicles } : {}), ...(body.emissions ? { emissions: body.emissions } : {}) };
  };
  const save = () => act(async () => { const sc = scenarioToSave(); if (!sc) return; onSaved(await mob.saveScenario(sc, basis(), initial?.parent, initial?.fromInstance)); });
  const run = () => act(async () => {
    const sc = scenarioToSave(); if (!sc) return;
    onRun(await mob.run({ title: title.trim(), methods: checked.map((k) => k.split('@')), repetitions: reps, emissions: profile ? emis : undefined, scenario: sc, basis: basis() ?? undefined, parent: initial?.parent, from_instance: initial?.fromInstance }));
  });

  const ready = [netReady && (source !== 'dataset' || !!datasetKey),
    source === 'manual' ? manual.drivers.length > 0 && manual.riders.length > 0 && [...manual.drivers, ...manual.riders].every(placed) : !!preview,
    !Number.isNaN(toSec(f.start)) && !Number.isNaN(toSec(f.end)) && toSec(f.start) < toSec(f.end) && !!preview,
    checked.length > 0 && title.trim().length >= 3, true][step - 1];
  const summary = preview?.summary;
  const people = current();
  // the Randomize dialog offers the vehicles themselves: a capacity variant made in the editor is the same vehicle
  const baseProfiles = allProfiles.filter((p) => p.provenance?.change !== 'passenger_capacity');
  const detailAgent = detail ? people[detail.role].find((a) => a.id === detail.id) ?? null : null;
  const directOf = (id: string) => { const a = preview?.agents.find((x) => x.id === id); return a ? { s: a.direct_s, m: a.direct_m } : null; };
  const paletteItems: PaletteItem[] = [
    { id: 'driver', label: tr('Driver'), icon: <CarIcon size={15} /> },
    { id: 'rider', label: tr('Rider'), icon: <RiderIcon size={15} /> },
    ...GROUPS.map((g) => { const has = allProfiles.some((p) => groupOf(p.powertrain) === g); return { id: `vehicle:${g}`, label: tr(GROUP_LABEL[g]), icon: <VehicleIcon powertrain={GROUP_PT[g]} size={15} />, disabled: !has,
      title: has ? tr('A driver with a vehicle of this type: drag onto the map, or select and click the map') : tr('No vehicle profile of this type: add one with Manage') }; }),
  ];
  const drivers = source === 'manual' ? manual.drivers : preview?.scenario.drivers ?? [];
  const row = (role: Role, a: Agent) => { const r = routes[a.id]; return <tr key={a.id} className={pick?.id === a.id || detail?.id === a.id ? 'hl' : ''}>
    <td className="mono"><button type="button" className="btn link pp-open" aria-label={tr('details of {id}', { id: a.id })} title={tr('Details')} onClick={() => openDetail(a.id)}>{a.id}</button></td>
    <td><button type="button" className={`btn sm ${pick?.id === a.id && pick.field === 'origin' ? 'primary' : ''}`} onClick={() => setPick({ role, id: a.id, field: 'origin' })} title={tr('start {at}', { at: at(a.origin) })} data-at={at(a.origin)}>{tr('Start point')}</button>{' '}
      <button type="button" className={`btn sm ${pick?.id === a.id && pick.field === 'destination' ? 'primary' : ''}`} onClick={() => setPick({ role, id: a.id, field: 'destination' })} title={tr('end {at}', { at: at(a.destination) })} data-at={at(a.destination)}>{tr('End point')}</button></td>
    <td><input key={a.earliest} aria-label={tr('{id} earliest', { id: a.id })} className="time" defaultValue={hhmm(a.earliest)} onBlur={(e) => { const v = toSec(e.target.value); if (!Number.isNaN(v) && v !== a.earliest) update(role, a.id, { earliest: v }); }} /></td>
    <td><input key={a.latest} aria-label={tr('{id} latest', { id: a.id })} className="time" defaultValue={hhmm(a.latest)} onBlur={(e) => { const v = toSec(e.target.value); if (!Number.isNaN(v) && v !== a.latest) update(role, a.id, { latest: v }); }} /></td>
    <td><button type="button" className="btn sm" disabled={!placed(a)} title={placed(a) ? '' : tr('place the start and end points first')} onClick={() => route(a)}>{tr('Route')}</button>
      {r && <span className={`small ${r.error ? 'bad' : 'muted'}`}> {r.text}</span>}</td>
    <td><button type="button" className="btn icon" aria-label={tr('remove {id}', { id: a.id })} onClick={() => remove(role, a.id)}><Trash2 size={12} /></button></td></tr>; };

  return <div className="wizard" role="dialog" aria-label={tr('generate scenario')} data-tour="wizard">
    <div className="row gap wizard-top"><div className="wiz-title"><h2>{tr('Generate')}</h2><span className="muted small">{tr('New scenario and experiment')}</span></div>
      <ol className="steps" aria-label={tr('steps')}>{STEPS.map((s, i) => <li key={s} className={i + 1 === step ? 'current' : i + 1 < step ? 'done' : ''}><span className="dotnum">{i + 1 < step ? <Check size={13} /> : i + 1}</span>{tr(s)}</li>)}</ol>
      <button className="btn icon ghost" aria-label={tr('close')} onClick={onClose}><X size={16} /></button></div>
    <div className="wizard-side">
      <div className="wizard-body form">
        {step === 1 && <>
          <label>{tr('Area')} <select aria-label={tr('area')} value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            {!areas.length && <option value="">—</option>}{areas.map((a) => <option key={a.area_id} value={a.area_id}>{a.name}{a.network_id ? '' : ` ${tr('(no road network)')}`}</option>)}</select></label>
          {area && !area.network_id && <div className="row gap"><button className="btn sm" disabled={busy || (!cfg.can_fetch && !area.cached_network) || (!!job && job.state === 'running')} onClick={() => act(() => download(area.area_id))}><Download size={12} /> {area.cached_network ? tr('Use stored road network') : tr('Download road network')}</button></div>}
          {job && <JobProgress job={job} setErr={setErr} onFinished={(j) => { setJob(j); reloadAreas(); }} />}
          <fieldset><legend>{tr('New area')}</legend>
            <form className="row gap" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= minChars) search(); }}>
              <input value={q} onChange={(e) => { setQ(e.target.value); if (auto) { if (sTimer.current) window.clearTimeout(sTimer.current); if (e.target.value.trim().length >= minChars) sTimer.current = window.setTimeout(() => search(e.target.value), 450); } }}
                placeholder={cfg.geocoder ? tr('Find a city or region') : tr('Place search is off')} aria-label={tr('place search')} disabled={!cfg.geocoder} className="grow" />
              <button className="btn sm" disabled={!cfg.geocoder || busy || q.trim().length < minChars}><Search size={12} /> {tr('Search')}</button></form>
            <div className="row gap"><button type="button" className={`btn sm ${mapMode === 'point' ? 'primary' : ''}`} onClick={() => { setCorner(null); setMapMode(mapMode === 'point' ? 'none' : 'point'); }}>{tr('Pick on map')}</button>
              {mapMode === 'point' && <select aria-label={tr('box size')} value={boxKm} onChange={(e) => setBoxKm(Number(e.target.value))} className="small">{[3, 5, 8, 12].map((k) => <option key={k} value={k}>{k} km</option>)}</select>}
              <button type="button" className={`btn sm ${mapMode === 'draw' ? 'primary' : ''}`} onClick={() => { setCorner(null); setMapMode(mapMode === 'draw' ? 'none' : 'draw'); }}><Square size={12} /> {tr('Draw a box')}</button></div>
            {results && results.length > 0 && <ul className="results" aria-label={tr('search results')}>{results.map((r, i) => <li key={i} tabIndex={0} onClick={() => choose(r)} onKeyDown={(e) => e.key === 'Enter' && choose(r)}>{r.name}<span className="muted small"> · {r.kind}</span></li>)}</ul>}
            {mapMode === 'point' && <p className="small muted">{tr('Click the map: a {n} × {n} km box is centred on the point.', { n: boxKm })}</p>}
            {mapMode === 'draw' && <p className="small muted">{corner ? tr('Click the opposite corner.') : tr('Click a first corner on the map.')}</p>}
            {draft && <div className="draft">
              <label>{tr('Name')} <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label={tr('area name')} /></label>
              <label>{tr('Road-network profile')} <select aria-label={tr('road network profile')} value={draft.profile} onChange={(e) => setDraft({ ...draft, profile: e.target.value })}>{cfg.profiles.map((p) => <option key={p.id} value={p.id}>{tr(p.label ?? p.id)}</option>)}</select></label>
              <p className={`small ${draftTooBig ? 'bad-text' : 'muted'}`}>{draftKm ? `${num(draftKm[1], 1)} × ${num(draftKm[0], 1)} km` : ''}{draftTooBig ? ` · ${tr('too large for this profile — drag a corner to shrink it')}` : ` · ${tr('drag the corners to resize, the centre to move')}`}</p>
              <div className="row gap"><button type="button" className="btn primary sm" disabled={busy || draftTooBig || !cfg.can_fetch} onClick={createDraft}><Download size={12} /> {tr('Create area and prepare road network')}</button>
                <button type="button" className="btn sm" onClick={() => setDraft(null)}>{tr('Discard')}</button></div>
              {!cfg.can_fetch && <p className="small muted">{tr('Downloading road networks is not allowed on this installation.')}</p>}</div>}
          </fieldset>
          <fieldset><legend>{tr('Mobility data')}</legend>
            <label className="row top"><input type="radio" name="src" checked={source === 'dataset'} disabled={!shownDatasets.length} onChange={() => setSource('dataset')} />
              <span><b>{tr('Sampled from observed trips')}</b>{!shownDatasets.length ? <span className="muted"> {tr('(none for this area)')}</span> : null}<span className="small muted block">{tr('Participants are drawn from the start points, end points and departure times of observed trips (RPC open data or your file) — the observed trips are not replayed one-to-one.')}</span></span></label>
            {source === 'dataset' && <select aria-label={tr('dataset')} value={datasetKey} onChange={(e) => setDatasetKey(e.target.value)}>{shownDatasets.map((d) => <option key={d.dataset_key} value={d.dataset_key}>{dsLabel(d)}</option>)}</select>}
            <label className="row top"><input type="radio" name="src" checked={source === 'synthetic'} onChange={() => setSource('synthetic')} /><span><b>{tr('Synthetic demand')}</b><span className="small muted block">{tr('Random trips on the road network, seeded')}</span></span></label>
            <label className="row top"><input type="radio" name="src" checked={source === 'manual'} onChange={() => setSource('manual')} /><span><b>{tr('Place participants on the map')}</b><span className="small muted block">{tr('Set each start point and end point yourself')}</span></span></label>
            <a className="small" href="#/data/datasets" target="_blank" rel="noopener">{tr('Upload a CSV or GeoJSON file…')}</a>
          </fieldset>
        </>}
        {step === 2 && <>
          <label>{tr('Scenario name')} <input value={f.name} onChange={(e) => { autoName.current = false; setF({ ...f, name: e.target.value }); }} aria-label={tr('scenario name')} /></label>
          <div className="row gap authoring-bar" role="group" aria-label={tr('add participants')}>
            <Palette items={paletteItems} armed={pick?.fresh ? pick.item ?? null : null} disabled={!netReady || (source !== 'manual' && !preview)} onArm={(id) => paletteAdd(id)} onDrop={paletteDrop} />
            <span className="grow" />
            <button type="button" className="btn sm" disabled={!netReady} onClick={() => { setPick(null); setRandomOpen(true); }} title={tr('Generate drivers, riders and vehicles with a seed: numbers, vehicle types, area, times')}><Shuffle size={12} /> {tr('Randomize…')}</button>
            <button type="button" className="btn sm" disabled={!past.length} onClick={undo} aria-label={tr('undo')} title={tr('Undo the last change (Ctrl+Z)')}><Undo2 size={12} /> {tr('Undo')}</button>
          </div>
          <p className="small muted authoring-hint">{pick ? <>{pick.field === 'origin' ? tr('Click the map to place the start point of {id}.', { id: pick.id }) : tr('Click the map to place the end point of {id}.', { id: pick.id })}{' '}
            <button type="button" className="btn link" onClick={cancelPick}>{tr('Cancel placement')}</button></>
            : tr('Drag an item onto the map, or select it and click the map. Click a marker to edit it; drag a marker to move it.')}</p>
          {notice && <p className="note warn small" role="alert">{notice}</p>}
          {source === 'manual' && origin?.authoring && <p className="small muted" aria-label={tr('generation summary')}>{tr('Generated with seed {seed}: {drivers} drivers, {riders} riders. Everything stays editable before saving.', { seed: origin.authoring.seed, drivers: origin.authoring.n_drivers, riders: origin.authoring.n_riders })}</p>}
          {source !== 'manual' && <div className="row gap">
            <label>{tr('Drivers')} <CountInput min={1} max={100} value={f.n_drivers} onChange={(n) => setF((x) => ({ ...x, n_drivers: n }))} aria-label={tr('drivers')} /></label>
            <label>{tr('Riders')} <CountInput min={1} max={100} value={f.n_riders} onChange={(n) => setF((x) => ({ ...x, n_riders: n }))} aria-label={tr('riders')} /></label>
            <label>{tr('Seed')} <CountInput min={0} max={1000000} value={f.seed} onChange={(n) => setF((x) => ({ ...x, seed: n }))} aria-label={tr('seed')} /></label>
            <button type="button" className="btn sm self-end" onClick={() => randomize()} title={tr('A new seed: new places, same counts and time window')}><Shuffle size={12} /> {tr('Randomize locations')}</button>
            {source === 'dataset' && <label>{tr('Date')} <input value={f.date} placeholder="YYYY-MM-DD" onChange={(e) => setF({ ...f, date: e.target.value })} aria-label={tr('date')} /></label>}
          </div>}
          {source === 'manual' && <>
            {(['drivers', 'riders'] as const).map((role) => <fieldset key={role}><legend>{role === 'drivers' ? tr('Drivers') : tr('Riders')} ({manual[role].length})</legend>
              {manual[role].length > 0 && <div className="table-scroll"><table className="compact" aria-label={tr(role)}><thead><tr><th>{tr('Id')}</th><th>{tr('Place')}</th><th>{tr('Earliest')}</th><th>{tr('Latest')}</th><th>{tr('Route')}</th><th /></tr></thead><tbody>{manual[role].map((a) => row(role, a))}</tbody></table></div>}
              <button type="button" className="btn sm" onClick={() => add(role)}><Plus size={12} /> {role === 'drivers' ? tr('Add driver') : tr('Add rider')}</button></fieldset>)}
            <div className="row gap"><label className="row small gap">{tr('Seed')} <CountInput min={1} max={999999} value={relocSeed ?? reloc ?? 1} aria-label={tr('locations seed')} onChange={(n) => setRelocSeed(n)} style={{ width: '6.5em' }} /></label>
              <button type="button" className="btn sm" disabled={busy || !manual.drivers.length || !manual.riders.length} onClick={() => randomize(relocSeed)}
              title={tr('New start and end points on the road network, inside the area, drawn with this seed (a typed seed gives the same places again); ids and time windows stay')}><Shuffle size={12} /> {tr('Randomize locations')}</button>
              {reloc != null && <span className="small muted">{tr('seed {n} · times kept', { n: reloc })}</span>}</div>
          </>}
          <fieldset><legend>{tr('Vehicle')}</legend>
            <div className="row gap"><select aria-label={tr('vehicle')} value={vehicleId} onChange={(e) => { checkpoint(); setVehicleId(e.target.value); }} className="grow"><option value="">{tr('None (no emission data)')}</option>
              {allProfiles.map((p) => <option key={p.id} value={p.id}>{vehicleName(p)}</option>)}</select>
              <button type="button" className="btn sm" disabled={!veh} onClick={() => setEditor(true)}>{tr('Manage')}</button></div>
            {profile && drivers.length > 0 && <details className="small"><summary>{tr('Advanced')}</summary>
              <div className="table-scroll"><table className="compact" aria-label={tr('vehicle per driver')}><tbody>{drivers.map((d) => <tr key={d.id}><td className="mono">{d.id}</td>
                <td><select aria-label={tr('vehicle of {id}', { id: d.id })} value={assign[d.id] ?? profile.id} onChange={(e) => { checkpoint(); setAssign({ ...assign, [d.id]: e.target.value }); }}>{allProfiles.map((p) => <option key={p.id} value={p.id}>{vehicleName(p)}</option>)}</select></td></tr>)}</tbody></table></div></details>}
          </fieldset>
          <PreviewLine preview={preview} err={previewErr} manual={source === 'manual'} />
        </>}
        {step === 3 && <>
          <div className="row gap"><label>{tr('From')} <input className="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} aria-label={tr('from')} /></label>
            <label>{tr('To')} <input className="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} aria-label={tr('to')} /></label></div>
          <div className="row gap"><label>{tr('Max detour (min)')} <input type="number" min={0} max={120} value={f.detour} onChange={(e) => setF({ ...f, detour: Number(e.target.value) })} aria-label={tr('max detour minutes')} /></label>
            <label>{tr('Max detour ratio')} <input type="number" min={0} max={5} step={0.1} value={f.ratio} onChange={(e) => setF({ ...f, ratio: Number(e.target.value) })} aria-label={tr('max detour ratio')} /></label></div>
          <p className="small muted">{tr('Capacity: one rider per driver (problem definition).')}</p>
          {source === 'synthetic' && <details className="small"><summary>{tr('Advanced')}</summary>
            <label>{tr('Minimum trip length (km)')} <input type="number" min={0.2} max={50} step={0.1} value={f.min_trip_km} onChange={(e) => setF({ ...f, min_trip_km: Number(e.target.value) })} aria-label={tr('minimum trip length')} /></label></details>}
          <PreviewLine preview={preview} err={previewErr} manual={source === 'manual'} />
        </>}
        {step === 4 && <>
          <label>{tr('Experiment name')} <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label={tr('experiment name')} /></label>
          <fieldset><legend className="row gap">{tr('Method')}{onAddMethod && <button type="button" className="btn sm" onClick={onAddMethod}><Plus size={12} /> {tr('Add method')}</button>}</legend><ul className="methods">{methods.map((m) => { const k = methodKey(m); return <li key={k}><label className="row"><input type="checkbox" checked={checked.includes(k)} onChange={() => setChecked(checked.includes(k) ? checked.filter((x) => x !== k) : [...checked, k])} /> <span className="grow">{m.name}<span className="muted small"> · {tr(m.kind)}{m.source === 'plugin' ? ` · ${tr('your method')}` : ''}</span></span></label></li>; })}</ul></fieldset>
          <div className="row gap"><label>{tr('Repetitions')} <CountInput min={1} max={20} value={reps} onChange={setReps} aria-label={tr('repetitions')} style={{ width: '5em' }} /></label>
            <span className="small muted" style={{ alignSelf: 'flex-end', paddingBottom: 9 }}>{source !== 'manual' ? tr('Seed {seed} (set in step 2)', { seed: f.seed }) : origin?.authoring ? tr('Seed {seed} (Randomize)', { seed: origin.authoring.seed }) : tr('Seed — (participants placed by hand)')} · {tr('each repetition runs every method on the same scenarios')}</span></div>
          {profile && veh && <fieldset><legend>{tr('CO₂ calculation')}</legend>
            <label>{tr('Method')} <select aria-label={tr('emission scope')} value={emis.scope} onChange={(e) => setEmis({ ...emis, scope: e.target.value })}>{veh.scopes.map((s) => <option key={s.id} value={s.id}>{tr(SCOPE_LABEL[s.id] ?? s.id)}</option>)}</select></label>
            <label>{tr('Baseline')} <select aria-label={tr('emission baseline')} value={emis.baseline} onChange={(e) => setEmis({ ...emis, baseline: e.target.value })}>{veh.baselines.map((b) => <option key={b.id} value={b.id}>{tr(BASELINE_LABEL[b.id] ?? b.id)}</option>)}</select></label>
            <p className="small muted">{tr(veh.scopes.find((s) => s.id === emis.scope)?.definition ?? '')}. {tr('Baseline: {definition}', { definition: tr(veh.baselines.find((b) => b.id === emis.baseline)?.definition ?? '') })}.</p></fieldset>}
        </>}
        {step === 5 && <dl className="facts review" aria-label={tr('review')}>
          <dt>{tr('Area')}</dt><dd>{area?.name}</dd>
          <dt>{tr('Road network')}</dt><dd>{tr('OpenStreetMap · {profile} profile', { profile: tr(cfg.profiles.find((p) => p.id === area?.profile)?.label ?? area?.profile ?? 'car') })}</dd>
          <dt>{tr('Mobility data')}</dt><dd>{source === 'synthetic' ? tr('synthetic demand (seeded)') : source === 'manual' ? (origin?.authoring ? tr('generated on the road network (seeded), editable') : tr('placed on the map')) : tr('{dataset} — participants sampled from the observed trips, not replayed one-to-one', { dataset: dsLabel(shownDatasets.find((d) => d.dataset_key === datasetKey)) })}</dd>
          <dt>{tr('Scenario')}</dt><dd>{f.name}</dd>
          <dt>{tr('Drivers')}</dt><dd className="iconed"><CarIcon size={14} />{drivers.length}</dd>
          <dt>{tr('Riders')}</dt><dd className="iconed"><RiderIcon size={14} />{(source === 'manual' ? manual.riders : preview?.scenario.riders ?? []).length}{summary ? ` · ${tr('{n} compatible pairs', { n: summary.pairs })}` : ''}</dd>
          <dt>{tr('Vehicles')}</dt><dd className="iconed">{profile && <VehicleIcon powertrain={profile.powertrain} size={14} />}{profile ? fleet(drivers, profile, assign, allProfiles) : tr('none')}</dd>
          <dt>{tr('Time horizon')}</dt><dd>{f.start}–{f.end}</dd>
          <dt>{tr('Constraints')}</dt><dd>{tr('detour ≤ {min} min and ≤ {pct} % of the direct trip · one rider per driver', { min: f.detour, pct: Math.round(f.ratio * 100) })}</dd>
          <dt>{tr('Repetitions and seed')}</dt><dd>{reps === 1 ? tr('{n} repetition', { n: reps }) : tr('{n} repetitions', { n: reps })} · {source !== 'manual' ? tr('seed {n}', { n: f.seed }) : reloc != null ? tr('seed {n} (locations)', { n: reloc }) : origin?.authoring ? tr('seed {n}', { n: origin.authoring.seed }) : origin ? tr('seed {n}', { n: origin.seed }) : tr('seed —')}</dd>
          <dt>{tr('Methods')}</dt><dd>{checked.map((k) => methods.find((m) => methodKey(m) === k)?.name ?? k).join(', ')} · {reps === 1 ? tr('{n} repetition', { n: reps }) : tr('{n} repetitions', { n: reps })}</dd>
          <dt>{tr('CO₂ calculation')}</dt><dd>{profile ? `${tr(SCOPE_LABEL[emis.scope])} · ${tr('baseline: {baseline}', { baseline: tr(BASELINE_LABEL[emis.baseline]) })}` : tr('not computed (no vehicle)')}</dd>
          <dt>{tr('Provenance')}</dt><dd>{source === 'synthetic' ? tr('seeded generator on {area} road network', { area: String(area?.name) }) : source === 'dataset' ? tr('seeded sampling (seed {seed}) of {dataset}', { seed: f.seed, dataset: dsLabel(shownDatasets.find((d) => d.dataset_key === datasetKey)) }) : [initial?.fromInstance ? tr('new version of an experiment\'s frozen scenario (the original stays unchanged)') : initial?.parent ? tr('edited from a library scenario') : tr('map editor'),
            ...(reloc != null ? [tr('locations randomized on the {area} road network (seed {seed})', { seed: reloc, area: String(area?.name) })] : []),
            ...(reloc == null && origin?.authoring ? [tr('participants and vehicles generated on the {area} road network (seed {seed}); later hand edits are recorded', { seed: origin.authoring.seed, area: String(area?.name) })] : []),
            ...(reloc == null && origin && !origin.authoring ? [tr('started from generated or sampled participants (seed {seed}); hand edits are recorded', { seed: origin.seed })] : [])].join(' · ')}</dd>
        </dl>}
      </div>
      <div className="row gap wizard-foot">
        {step > 1 ? <button className="btn" onClick={() => setStep(step - 1)}><ChevronLeft size={14} /> {tr('Back')}</button> : <button className="btn" onClick={onClose}>{tr('Cancel')}</button>}
        <span className="grow" /><span className="small muted">{tr('Step {step} of 5', { step })}</span>
        {step < 5 && <button className="btn primary" disabled={!ready} onClick={() => setStep(step + 1)}>{tr('Next')} <ChevronRight size={14} /></button>}
        {step === 5 && <><button className="btn" disabled={busy} onClick={save}><Save size={14} /> {tr('Save Scenario')}</button>
          <button className="btn primary" disabled={busy} onClick={run} aria-busy={busy}><Play size={14} /> {busy ? tr('Saving…') : tr('Save & Run')}</button></>}
      </div>
    </div>
    <div className="wizard-map">
      <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={layers.points} lines={layers.lines} rects={area && !draft ? [{ bbox: area.bbox, color: COLORS.area }] : []}
        box={draft ? { bbox: draft.bbox, color: COLORS.area, onChange: (b) => setDraft({ ...draft, bbox: b }) } : null}
        fitKey={`${areaId}|${source}|${source === 'manual' ? 'm' : preview?.summary.instance_hash ?? ''}`} focus={focus} onClick={pick || mapMode !== 'none' ? onMap : undefined} cursor={pick || mapMode !== 'none' ? 'crosshair' : undefined} height="100%" api={mapApi}
        onPoint={step === 2 ? (p) => { if (pick) place(p.lat, p.lon); else if (p.ref) openDetail(p.ref); } : undefined} onPointMove={step === 2 ? moved : undefined} />
      {step === 2 && detail && detailAgent && <div className="pp-wrap" hidden={!!pick}>
        <ParticipantPanel key={detail.id} role={detail.role} agent={detailAgent} isNew={!!detail.isNew} others={[...people.drivers, ...people.riders].map((a) => a.id).filter((id) => id !== detail.id)}
          profiles={allProfiles} vehicleId={vehicleId ? assign[detail.id] ?? vehicleId : ''} detour={{ min: f.detour, ratio: f.ratio }} direct={directOf(detail.id)} busy={busy} error={panelErr}
          onPick={(field) => setPick({ role: detail.role, id: detail.id, field })} onSave={saveParticipant} onCancel={closeDetail} onRemove={() => remove(detail.role, detail.id)} /></div>}
    </div>
    {randomOpen && area && <RandomizeModal cfg={cfg} area={area} profiles={baseProfiles} defaultVehicle={profile ? baseProfiles.find((p) => p.id === profile.provenance?.derived_from) ?? baseProfiles.find((p) => p.id === profile.id) ?? null : null}
      onGenerate={generate} onClose={() => setRandomOpen(false)}
      initial={{ drivers: people.drivers.length || f.n_drivers, riders: people.riders.length || f.n_riders, seed: origin?.authoring?.seed ?? f.seed, start: f.start, end: f.end, detourMin: f.detour, detourRatio: f.ratio, minTripKm: f.min_trip_km,
        capacity: profile?.passenger_capacity ?? null }} />}
    {editor && veh && <VehicleEditor info={veh} onChange={loadVehicles} onClose={() => setEditor(false)} setErr={setErr} />}
  </div>;
}

function PreviewLine({ preview, err, manual }: { preview: Preview | null; err: string | null; manual: boolean }) {
  if (err) return <p className="note warn small" role="alert">{err}</p>;
  if (!preview) return <p className="small muted">{manual ? tr('Add drivers and riders to preview the scenario.') : tr('Preview…')}</p>;
  const s = preview.summary;
  return <p className="small muted" aria-label={tr('preview summary')}>{tr('{drivers} drivers · {riders} riders · {pairs} compatible pairs · {options} riders with an option · snapped ≤ {snap} m', { drivers: s.drivers, riders: s.riders, pairs: s.pairs, options: s.riders_with_option, snap: num(s.max_snap_m, 0) })}</p>;
}

function fleet(drivers: Agent[], profile: VehicleProfile, assign: Record<string, string>, all: VehicleProfile[]) {
  const count: Record<string, number> = {};
  for (const d of drivers) { const id = assign[d.id] ?? profile.id; count[id] = (count[id] ?? 0) + 1; }
  return Object.entries(count).map(([id, n]) => { const p = all.find((x) => x.id === id); return `${p ? vehicleName(p) : id} ×${n}`; }).join(' · ');
}
