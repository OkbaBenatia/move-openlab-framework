import type { Json } from '../api/client';
import { POWERTRAIN_GLYPH, type MapLine, type MapPoint } from '../geo/LeafletMap';
import { hhmmss } from '../geo/api';
import { tr } from '../i18n';
import { positionAt } from './ReplayBar';

export const ROUTE_COLORS = ['#1f5fd1', '#15803d', '#7c3aed', '#c2410c', '#0f766e', '#a21caf', '#b45309', '#0369a1'];
/** Approved map encoding: a vehicle carrying a rider is drawn as a shared ride (teal), a driver alone dashed grey;
 *  pickups and drop-offs teal, riders not matched grey; the followed vehicle orange. */
export const MAP = { shared: '#00887f', alone: '#8a97a8', start: '#1f5fd1', stop: '#00887f', unmatched: '#6b7a8c', focus: '#eb6834' };

/** Map layers of a playback plan: the routes of every vehicle, departures, pickups, drop-offs and unserved riders. */
export function planLayers(plan: Json): { points: MapPoint[]; lines: MapLine[] } {
  const lines: MapLine[] = (plan.vehicles as Json[]).map((v) => ({ coords: v.path.map((p: number[]) => [p[0], p[1]]), color: v.rider ? MAP.shared : MAP.alone, weight: v.rider ? 4 : 2, dash: v.rider ? undefined : '5 6', label: v.rider ? tr('{driver} carries {rider}', { driver: v.driver, rider: v.rider }) : tr('{driver} alone', { driver: v.driver }) }));
  const points: MapPoint[] = [
    ...(plan.vehicles as Json[]).map((v) => ({ lat: v.path[0][0], lon: v.path[0][1], color: MAP.start, radius: 5, kind: 'driver', ref: v.driver, glyph: glyphOf(v.vehicle),
      label: `${tr('{driver} departs {time}', { driver: v.driver, time: hhmmss(v.path[0][2]) })}${vehicleText(v.vehicle)} · ${v.rider ? tr('carries {rider}', { rider: v.rider }) : tr('drives alone')}` })),
    ...(plan.vehicles as Json[]).flatMap((v) => v.stops.filter((s: Json) => s.type === 'pickup' || s.type === 'dropoff').map((s: Json) => ({ lat: s.at[0], lon: s.at[1], color: MAP.stop, fill: s.type === 'pickup', radius: 5,
      kind: s.type, ref: s.rider, label: s.type === 'pickup' ? tr('{rider} pickup {time} · served by {driver}', { rider: s.rider, time: hhmmss(s.t), driver: v.driver }) : tr('{rider} drop-off {time} · served by {driver}', { rider: s.rider, time: hhmmss(s.t), driver: v.driver }) }))),
    ...(plan.unserved as Json[]).map((u) => ({ lat: u.at[0], lon: u.at[1], color: MAP.unmatched, fill: false, radius: 6, kind: 'unserved', ref: u.rider, label: tr('{rider} not matched · start point', { rider: u.rider }) }))];
  return { points, lines };
}

/** Driver marker letter for a frozen vehicle ('' when the scenario has no vehicle or a custom one). */
export const glyphOf = (v: Json | null | undefined) => POWERTRAIN_GLYPH[v?.powertrain ?? ''] ?? '';
export const vehicleText = (v: Json | null | undefined) => (v ? ` · ${v.name ?? v.id}${v.powertrain && v.powertrain !== 'custom' ? ` · ${v.powertrain}` : ''}` : '');
/** Powertrains present in a plan or an instance, for the legend. */
export const powertrainsOf = (vs: (Json | null | undefined)[]) => Array.from(new Set(vs.map((v) => v?.powertrain).filter((p): p is string => !!p && !!POWERTRAIN_GLYPH[p])));

/** Candidate-reduction views (Before / After / Solution) of one run, from `GET /geo/candidates`: retained teal (the
 *  shared-ride colour), removed red dashed, kept by a structural rule orange, selected by the solver blue. */
export const ARC = { candidate: MAP.alone, retained: MAP.shared, removed: '#b42318', protected: MAP.focus, selected: MAP.start };
export type ArcMode = 'routes' | 'before' | 'after' | 'solution';
export interface ArcCounts { candidates: number; retained: number; removed: number; protected: number; selected: number }

/** Map layers of a candidate-reduction view. Each edge is a logical stop edge of the formulation, drawn as a straight
 *  segment between its two snapped stops (not a road). Vehicle-edges are counted per vehicle (one vehicle, or all) and
 *  drawn once per stop pair, so a dense graph stays readable; each line's tooltip gives its vehicle-edge counts. */
export function arcLayers(v: Json, mode: ArcMode, vehicle: number | 'all'): { points: MapPoint[]; lines: MapLine[]; counts: ArcCounts } {
  const pos = new Map<number, [number, number]>((v.stops as Json[]).map((s) => [s.node, [s.lat, s.lon]]));
  const vs: number[] = vehicle === 'all' ? (v.vehicles as Json[]).map((x) => x.vehicle_id) : [vehicle];
  const set = (xs: number[][]) => new Set(xs.map(([a, b]) => `${a}:${b}`));
  const removed = set(v.removed), prot = set(v.protected), sel = set(v.selected);
  const pairs = new Map<string, { i: number; j: number; total: number; kept: number; rem: number; prot: number; sel: number }>();
  const counts: ArcCounts = { candidates: 0, retained: 0, removed: 0, protected: 0, selected: 0 };
  for (const e of v.edges as Json[]) for (const veh of vs) {
    const k = `${veh}:${e.edge_id}`, key = e.i < e.j ? `${e.i}-${e.j}` : `${e.j}-${e.i}`;
    const p = pairs.get(key) ?? { i: Math.min(e.i, e.j), j: Math.max(e.i, e.j), total: 0, kept: 0, rem: 0, prot: 0, sel: 0 };
    p.total++; counts.candidates++;
    if (removed.has(k)) { p.rem++; counts.removed++; } else { p.kept++; counts.retained++; }
    if (prot.has(k)) { p.prot++; counts.protected++; }
    if (sel.has(k)) { p.sel++; counts.selected++; }
    pairs.set(key, p);
  }
  const lines: MapLine[] = [];
  for (const p of pairs.values()) {
    const a = pos.get(p.i), b = pos.get(p.j);
    if (!a || !b) continue;
    const label = `${tr('stops {i}–{j} · {total} vehicle-edges: {kept} retained, {removed} removed', { i: p.i, j: p.j, total: p.total, kept: p.kept, removed: p.rem })}${p.prot ? `, ${tr('{n} kept by the structural rule', { n: p.prot })}` : ''}${p.sel ? `, ${tr('{n} used by the solution', { n: p.sel })}` : ''}`;
    const coords: [number, number][] = [a, b];
    if (mode === 'before') lines.push({ coords, color: ARC.candidate, weight: 1, opacity: 0.6, label });
    else if (mode === 'after') lines.push(p.kept === 0 ? { coords, color: ARC.removed, weight: 1, dash: '4 5', opacity: 0.55, label }
      : { coords, color: p.prot ? ARC.protected : ARC.retained, weight: p.prot ? 2.5 : 1.5, opacity: 0.85, label });
    else if (p.sel) lines.push({ coords, color: ARC.selected, weight: 4, label });
    else if (p.kept) lines.push({ coords, color: ARC.retained, weight: 1, opacity: 0.25, label });
  }
  const points: MapPoint[] = (v.stops as Json[]).map((s) => ({ lat: s.lat, lon: s.lon, color: MAP.unmatched, radius: 3, label: tr('stop {node}', { node: s.node }) }));
  return { points, lines, counts };
}

/** Vehicle positions at time t (replay). */
export const planPositions = (plan: Json, t: number): MapPoint[] =>
  (plan.vehicles as Json[]).flatMap((v) => { const p = positionAt(v.path, t); return p ? [{ lat: p[0], lon: p[1], color: v.rider ? MAP.shared : MAP.alone, label: v.driver }] : []; });
