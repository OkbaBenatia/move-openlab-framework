import type { Json } from '../api/client';
import { type MapLine, type MapPoint } from '../geo/LeafletMap';
import { hhmmss } from '../geo/api';
import { positionAt } from './ReplayBar';

export const ROUTE_COLORS = ['#1f5fd1', '#15803d', '#7c3aed', '#c2410c', '#0f766e', '#a21caf', '#b45309', '#0369a1'];
/** Approved map encoding: a vehicle carrying a rider is drawn as a shared ride (teal), a driver alone dashed grey;
 *  pickups and drop-offs teal, riders not matched grey; the followed vehicle orange. */
export const MAP = { shared: '#00887f', alone: '#8a97a8', start: '#1f5fd1', stop: '#00887f', unmatched: '#6b7a8c', focus: '#eb6834' };

/** Map layers of a playback plan: the routes of every vehicle, departures, pickups, drop-offs and unserved riders. */
export function planLayers(plan: Json): { points: MapPoint[]; lines: MapLine[] } {
  const lines: MapLine[] = (plan.vehicles as Json[]).map((v) => ({ coords: v.path.map((p: number[]) => [p[0], p[1]]), color: v.rider ? MAP.shared : MAP.alone, weight: v.rider ? 4 : 2, dash: v.rider ? undefined : '5 6', label: v.rider ? `${v.driver} carries ${v.rider}` : `${v.driver} alone` }));
  const points: MapPoint[] = [
    ...(plan.vehicles as Json[]).map((v) => ({ lat: v.path[0][0], lon: v.path[0][1], color: MAP.start, radius: 5, label: `${v.driver} departs ${hhmmss(v.path[0][2])}` })),
    ...(plan.vehicles as Json[]).flatMap((v) => v.stops.filter((s: Json) => s.type === 'pickup' || s.type === 'dropoff').map((s: Json) => ({ lat: s.at[0], lon: s.at[1], color: MAP.stop, fill: s.type === 'pickup', radius: 5, label: `${s.rider} ${s.type === 'pickup' ? 'pickup' : 'drop-off'} ${hhmmss(s.t)}` }))),
    ...(plan.unserved as Json[]).map((u) => ({ lat: u.at[0], lon: u.at[1], color: MAP.unmatched, fill: false, radius: 6, label: `${u.rider} not matched` }))];
  return { points, lines };
}

/** Vehicle positions at time t (replay). */
export const planPositions = (plan: Json, t: number): MapPoint[] =>
  (plan.vehicles as Json[]).flatMap((v) => { const p = positionAt(v.path, t); return p ? [{ lat: p[0], lon: p[1], color: v.rider ? MAP.shared : MAP.alone, label: v.driver }] : []; });
