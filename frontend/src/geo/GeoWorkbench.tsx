import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, Database, Eye, EyeOff, Info, Layers, MapPinned, Pencil, Plus, Shuffle } from 'lucide-react';
import { HiddenFilter } from '../components/HiddenFilter';
import type { Json } from '../api/client';
import { errText, num } from '../components/common';
import type { DatasetItem } from '../lab/useLabData';
import { lab } from '../lab/api';
import { handOff, OPEN_NEW, OPEN_WIZARD } from '../lab/handoff';
import { RIDE, useMethods } from '../lab/useLabData';
import { tr } from '../i18n';
import { vehicleName } from '../mobility/api';
import { Wizard } from '../mobility/Wizard';
import { COLORS, LeafletMap, POWERTRAIN_GLYPH, type MapLine, type MapPoint } from './LeafletMap';
import { geo, hhmm, type Area, type GeoConfig, type Scenario } from './api';
import { Areas } from './Areas';
import { Datasets } from './Datasets';

type View = 'areas' | 'datasets' | 'library' | 'generate';
const CURRENT_KEY = 'move-openlab.area';

const VIEWS: View[] = ['areas', 'datasets', 'library', 'generate'];

/** Short explanation of each Library view, for first-time users. */
const VIEW_HELP: Record<View, string> = {
  areas: 'Step 1 — an area is a geographic zone (a box on the map). Its road network is a separate object, downloaded once from OpenStreetMap for that box: an area marked "not downloaded" has no network yet, so routes cannot be computed in it. Use makes an area your working area.',
  datasets: 'Step 2 — mobility data is where trips come from: observed trips (RPC open data, your CSV or GeoJSON files) or synthetic demand. Scenarios sample their participants from it. Use starts Generate with this data.',
  library: 'Step 3 — scenarios are frozen sets of drivers, riders and travel times, built from an area’s road network and mobility data, ready to run. Use starts a new experiment with the selected scenario in the Workspace.',
  generate: 'Generate creates a scenario in five steps; nothing is saved before the last step.',
};

/** Library (data section): areas and road networks, mobility data, the scenario library; Generate opens the same
 *  five-step wizard as the workspace (the only scenario-creation workflow). "Use" applies a record to the work in the
 *  Workspace: an area becomes the working area, mobility data starts Generate, a scenario starts a new experiment. */
export function GeoWorkbench({ setErr, onOpenWorkspace, onRun, initialView, onView }: { setErr: (s: string | null) => void; onOpenWorkspace: () => void; onRun: (cid: string) => void; initialView?: string; onView?: (v: string) => void }) {
  const [cfg, setCfg] = useState<GeoConfig | null>(null);
  const [view, setView] = useState<View>(VIEWS.includes(initialView as View) ? (initialView as View) : 'library');
  const [lib, setLib] = useState<Json[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [currentId, setCurrentId] = useState<string>(() => { try { return localStorage.getItem(CURRENT_KEY) ?? ''; } catch { return ''; } });
  const [editing, setEditing] = useState<{ scenario: Scenario; parent?: string } | null>(null);
  const methods = useMethods(RIDE, setErr);
  // hidden records (areas, datasets, scenarios) stay out of the lists unless "Show hidden" is on; nothing is deleted
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [used, setUsed] = useState<string | null>(null);         // confirmation of the last Use
  const [workingId, setWorkingId] = useState('');                  // the working area chosen explicitly (Use or the area list)
  useEffect(() => { lab.state().then((s) => { setHiddenIds(s.preferences.hidden_ids ?? []); if (s.preferences.area_id && !(s.preferences.hidden_ids ?? []).includes(s.preferences.area_id)) { setCurrentId(s.preferences.area_id); setWorkingId(s.preferences.area_id); } }).catch(() => { /* preference only */ }); }, []);
  const toggleHidden = (id: string) => {
    const next = hiddenIds.includes(id) ? hiddenIds.filter((x) => x !== id) : [...hiddenIds, id];
    setHiddenIds(next); lab.prefs({ hidden_ids: next }).then((s) => setHiddenIds(s.preferences.hidden_ids ?? next)).catch((e) => setErr(errText(e)));
  };
  const hide = { hiddenIds, showHidden, onToggleHidden: toggleHidden };
  useEffect(() => { if (VIEWS.includes(initialView as View)) setView(initialView as View); }, [initialView]);
  const load = useCallback(() => {
    geo.config().then(setCfg).catch((e) => setErr(errText(e)));
    geo.scenarios().then((r) => setLib(r.scenarios)).catch((e) => setErr(errText(e)));
    geo.areas().then((r) => setAreas(r.areas)).catch((e) => setErr(errText(e)));
    geo.datasets().then((r) => setDatasets([
      ...r.shared.map((d: Json) => ({ dataset_key: d.dataset_key, name: d.name, bbox: d.area?.bbox ?? null, provider: d.provider ?? 'rpc', release: d.release ?? null })),
      ...r.mine.map((d: Json) => ({ dataset_key: d.dataset_key, name: d.name, bbox: d.coverage?.extent ?? null, provider: d.provider ?? 'upload', release: null }))])).catch((e) => setErr(errText(e)));
  }, [setErr]);
  useEffect(load, [load]);
  const shownAreas = showHidden ? areas : areas.filter((a) => !hiddenIds.includes(a.area_id) || a.area_id === currentId);
  const current = areas.find((a) => a.area_id === currentId) ?? shownAreas.find((a) => a.network_id) ?? shownAreas[0] ?? null;
  // the current area here is the working area of the account: kept on the server and shared with the Workspace
  const setCurrent = (id: string) => {
    setCurrentId(id); setWorkingId(id); try { localStorage.setItem(CURRENT_KEY, id); } catch { /* storage unavailable */ }
    lab.prefs({ area_id: id }).catch((e) => setErr(errText(e)));
  };
  const useArea = (id: string) => { setCurrent(id); setUsed(tr('{area} is now your working area: the Workspace lists its experiments and Generate starts there.', { area: areas.find((a) => a.area_id === id)?.name ?? tr('This area') })); };
  const applyDataset = (d: DatasetItem) => {
    const covering = (a: Area) => !d.bbox || (a.bbox[0] < d.bbox[2] && a.bbox[2] > d.bbox[0] && a.bbox[1] < d.bbox[3] && a.bbox[3] > d.bbox[1]);
    const a = (current && covering(current) ? current : null) ?? areas.find(covering);
    if (!a) { setErr(tr('No area covers {name} yet: create one under Areas first.', { name: d.name })); return; }
    setCurrent(a.area_id); handOff(OPEN_WIZARD, { area_id: a.area_id, dataset_key: d.dataset_key }); onOpenWorkspace();
  };
  const useScenarios = (hashes: string[], label: string) => { handOff(OPEN_NEW, { hashes, label }); onOpenWorkspace(); };
  const hiddenHere = view === 'areas' ? areas.filter((a) => hiddenIds.includes(a.area_id)).length
    : view === 'datasets' ? datasets.filter((d) => hiddenIds.includes(d.dataset_key)).length : lib.filter((s) => hiddenIds.includes(s.scenario_id)).length;
  if (!cfg) return null;
  // one Data setup workflow over separate objects: an area with its road network, then mobility data, then scenarios
  const tabs: [View, string, typeof MapPinned][] = [['areas', tr('1 · Area and road network'), MapPinned], ['datasets', tr('2 · Mobility data'), Database], ['library', tr('3 · Scenarios'), Layers], ['generate', tr('Generate'), Shuffle]];
  const closeWizard = () => { setEditing(null); setView('library'); onView?.('library'); };
  return <div>
    <div className="areabar">
      <label className="row gap" title={tr('Your working area: the Workspace and Generate start here')}><span className="small muted">{tr('Working area')}</span>
        <select value={current?.area_id ?? ''} onChange={(e) => setCurrent(e.target.value)} aria-label={tr('current area')} disabled={!areas.length}>
          {!areas.length && <option value="">{tr('no area yet')}</option>}
          {shownAreas.map((a) => <option key={a.area_id} value={a.area_id}>{a.name}{a.network_id ? '' : ` ${tr('(road network not downloaded yet)')}`}</option>)}</select></label>
      {current && <span className="small muted">{current.profile} · {num(current.km2, 0)} km²</span>}
      <span className="grow" />
      <HiddenFilter n={hiddenHere} on={showHidden} setOn={setShowHidden} />
    </div>
    {used && <p className="note ok row gap" role="status"><CheckCircle2 size={15} /><span className="grow">{used}</span>
      <button className="btn sm primary" onClick={onOpenWorkspace}>{tr('Open the Workspace')} <ArrowRight size={13} /></button><button className="btn sm ghost" onClick={() => setUsed(null)}>{tr('OK')}</button></p>}
    <nav className="subtabs" aria-label={tr('geographic sections')}>{tabs.map(([v, label, Icon]) =>
      <button key={v} className={`btn ${view === v ? 'primary' : ''}`} onClick={() => { setErr(null); setUsed(null); setView(v); onView?.(v); }}><Icon size={13} /> {label}</button>)}</nav>
    <p className="small muted view-help"><Info size={13} /> {tr(VIEW_HELP[view])}</p>
    {view === 'areas' && <Areas cfg={cfg} areas={shownAreas} current={current} workingId={workingId} setCurrent={setCurrent} onUse={useArea} setErr={setErr} onChanged={load} {...hide} />}
    {view === 'datasets' && <Datasets cfg={cfg} areas={areas} current={current} setErr={setErr} onChanged={load} onUse={(key) => { const d = datasets.find((x) => x.dataset_key === key); if (d) applyDataset(d); }} {...hide} />}
    {(view === 'library' || view === 'generate') && <Library cfg={cfg} lib={showHidden ? lib : lib.filter((s) => !hiddenIds.includes(s.scenario_id))} hiddenCount={showHidden ? 0 : lib.filter((s) => hiddenIds.includes(s.scenario_id)).length} setErr={setErr} {...hide} onEdit={(sc, parent) => { setEditing({ scenario: sc, parent }); setView('generate'); onView?.('generate'); }} onUse={useScenarios} />}
    {view === 'generate' && <Wizard cfg={cfg} areas={shownAreas} datasets={datasets.filter((d) => showHidden || !hiddenIds.includes(d.dataset_key))} methods={methods} areaId={current?.area_id} initial={editing} setErr={setErr} reloadAreas={load}
      onClose={closeWizard} onSaved={() => { load(); closeWizard(); }} onRun={(r) => { closeWizard(); onRun(r.campaign_id); }} />}
    <p className="small muted attribution">{tr('Road data {licence}. Map tiles: {tiles}.', { licence: cfg.osm_licence, tiles: cfg.tile_attribution.replace(/<[^>]+>/g, '').replace(/&copy;/g, '©').replace(/&amp;/g, '&') })}</p>
  </div>;
}

export function instanceLayers(inst: Json | null, showPairs: boolean): { points: MapPoint[]; lines: MapLine[] } {
  if (!inst) return { points: [], lines: [] };
  const points: MapPoint[] = [], lines: MapLine[] = [];
  for (const d of inst.drivers as Json[]) {
    const v = d.vehicle as Json | undefined;
    points.push({ lat: d.origin[0], lon: d.origin[1], color: COLORS.driver, kind: 'driver', ref: d.id, glyph: POWERTRAIN_GLYPH[v?.powertrain] ?? '',
      label: `${tr('{id} driver start', { id: d.id })} · ${hhmm(d.earliest)}–${hhmm(d.latest)}${v ? ` · ${v.name ? vehicleName({ name: v.name, provenance: v.provenance }) : v.id}${v.powertrain && v.powertrain !== 'custom' ? ` · ${v.powertrain}` : ''}` : ''}` });
    points.push({ lat: d.destination[0], lon: d.destination[1], color: COLORS.driver, fill: false, kind: 'driver-end', ref: d.id, label: tr('{id} driver destination', { id: d.id }) });
  }
  for (const r of inst.riders as Json[]) {
    points.push({ lat: r.origin[0], lon: r.origin[1], color: COLORS.rider, kind: 'rider', ref: r.id, label: `${tr('{id} rider start (pickup place)', { id: r.id })} · ${hhmm(r.earliest)}–${hhmm(r.latest)}` });
    points.push({ lat: r.destination[0], lon: r.destination[1], color: COLORS.rider, fill: false, kind: 'rider-end', ref: r.id, label: tr('{id} rider destination (drop-off place)', { id: r.id }) });
  }
  if (showPairs && inst.pairs) {
    const pos: Record<string, [number, number]> = {};
    for (const a of [...inst.drivers, ...inst.riders] as Json[]) pos[a.id] = a.origin;
    for (const p of inst.pairs as Json[]) lines.push({ coords: [pos[p.driver], pos[p.rider]], color: COLORS.match, weight: 1, dash: '3 5', opacity: 0.6, label: `${p.driver} → ${p.rider} · ${tr('detour {n} min', { n: Math.round(p.detour_s / 60) })}` });
  }
  return { points, lines };
}

function provText(p?: Json): string {
  if (!p) return '—';
  const own = [p.source && tr(p.source), p.seed != null ? tr('seed {n}', { n: p.seed }) : null, p.release ? tr('release {release}', { release: p.release }) : null, p.attribution && tr(p.attribution), p.edited_agents ? tr('edited: {list}', { list: p.edited_agents.join(', ') }) : null].filter(Boolean).join(' · ');
  return p.derived_from ? `${own} · ${tr('edited from {parent}', { parent: p.parent })} · ${tr('original: {provenance}', { provenance: provText(p.derived_from) })}` : own;
}

export interface HideProps { hiddenIds: string[]; showHidden: boolean; onToggleHidden: (id: string) => void }

function Library({ cfg, lib, hiddenCount, setErr, onEdit, onUse, hiddenIds, onToggleHidden }: { cfg: GeoConfig; lib: Json[]; hiddenCount: number; setErr: (s: string | null) => void; onEdit: (s: Scenario, parent: string) => void; onUse: (h: string[], label: string) => void } & HideProps) {
  const [sel, setSel] = useState<Json | null>(null);
  const [pairs, setPairs] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const open = (id: string) => geo.scenario(id).then(setSel).catch((e) => setErr(errText(e)));
  const layers = useMemo(() => instanceLayers(sel?.instance ?? null, pairs), [sel, pairs]);
  const veh = sel?.instance?.vehicles?.default;
  return <div className="split">
    <div>
      {lib.length === 0 ? <p className="muted">{hiddenCount ? tr('No visible scenario: {n} hidden (Filters, above, lists them again).', { n: hiddenCount }) : tr('The library is empty. Generate a scenario.')}</p> :
        <div className="table-scroll"><table aria-label={tr('scenario library')}><thead><tr><th /><th>{tr('Scenario')}</th><th>{tr('Category')}</th><th>{tr('Drivers')}</th><th>{tr('Riders')}</th><th>{tr('Created')}</th><th /></tr></thead>
          <tbody>{lib.map((s) => <tr key={s.scenario_id} className={sel?.scenario_id === s.scenario_id ? 'hl' : hiddenIds.includes(s.scenario_id) ? 'dim' : ''}>
            <td><input type="checkbox" aria-label={tr('select {name}', { name: s.name })} checked={chosen.includes(s.instance_hash)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.instance_hash] : chosen.filter((x) => x !== s.instance_hash))} /></td>
            <td><b>{s.name}</b>{s.parent && <div className="small muted">{tr('edited from {parent}', { parent: s.parent })}</div>}</td><td><span className="badge">{tr(s.category ?? s.source)}</span></td><td>{s.drivers}</td><td>{s.riders}</td>
            <td className="small">{s.created_at.slice(0, 16).replace('T', ' ')}</td><td><div className="row gap"><button className="btn sm" onClick={() => open(s.scenario_id)}>{tr('Open')}</button>
              <button className="btn sm" title={tr('Start a new experiment with this scenario in the Workspace')} onClick={() => onUse([s.instance_hash], tr('Scenario “{name}”', { name: s.name }))}>{tr('Use')}</button>
              <button className="btn icon" aria-label={hiddenIds.includes(s.scenario_id) ? tr('show {name}', { name: s.name }) : tr('hide {name}', { name: s.name })} title={hiddenIds.includes(s.scenario_id) ? tr('Show in lists') : tr('Hide from lists (nothing is deleted)')} onClick={() => onToggleHidden(s.scenario_id)}>{hiddenIds.includes(s.scenario_id) ? <Eye size={12} /> : <EyeOff size={12} />}</button></div></td></tr>)}</tbody></table></div>}
      <button className="btn primary" disabled={chosen.length === 0} onClick={() => onUse(chosen, chosen.length === 1 ? tr('{n} scenario', { n: chosen.length }) : tr('{n} scenarios', { n: chosen.length }))}><Plus size={13} /> {chosen.length === 1 ? tr('New experiment with {n} scenario', { n: chosen.length }) : tr('New experiment with {n} scenarios', { n: chosen.length })}</button>
      {sel && <><h3>{sel.name}</h3>
        <table className="kv"><tbody>
          <tr><th>{tr('Drivers · riders')}</th><td>{sel.summary.drivers} · {sel.summary.riders}</td></tr>
          <tr><th>{tr('Compatible pairs')}</th><td>{sel.summary.pairs} ({tr('{n} riders with at least one option', { n: sel.summary.riders_with_option })})</td></tr>
          <tr><th>{tr('Mean detour')}</th><td>{sel.summary.mean_detour_s == null ? '—' : `${num(sel.summary.mean_detour_s / 60, 1)} min`}</td></tr>
          <tr><th>{tr('Largest snapping distance')}</th><td>{num(sel.summary.max_snap_m, 0)} m</td></tr>
          <tr><th>{tr('Detour limits')}</th><td>{tr('{min} min and {ratio} × direct time', { min: Math.round(sel.scenario.params.max_detour_s / 60), ratio: sel.scenario.params.max_detour_ratio })}</td></tr>
          <tr><th>{tr('Vehicles')}</th><td>{veh ? `${tr('default {vehicle}', { vehicle: vehicleName(veh) })}${sel.scenario.vehicles?.assignments && Object.keys(sel.scenario.vehicles.assignments).length ? ` · ${tr('{n} driver(s) with another vehicle', { n: Object.keys(sel.scenario.vehicles.assignments).length })}` : ''}` : tr('none')}</td></tr>
          <tr><th>{tr('Provenance')}</th><td className="small">{provText(sel.scenario.provenance)}</td></tr>
          <tr><th>{tr('Instance')}</th><td className="mono small">{sel.instance_hash}</td></tr>
        </tbody></table>
        <div className="row gap actions"><label className="row"><input type="checkbox" checked={pairs} onChange={(e) => setPairs(e.target.checked)} /> {tr('Show compatible pairs')}</label>
          <button className="btn" onClick={() => onEdit(sel.scenario, sel.scenario_id)}><Pencil size={13} /> {tr('Edit as new version')}</button></div></>}
    </div>
    <LeafletMap tileUrl={cfg.tile_url} attribution={cfg.tile_attribution} points={layers.points} lines={layers.lines} fitKey={sel?.scenario_id ?? 'none'} />
  </div>;
}
