import type { Json } from '../api/client';
import { COLORS, type MapLine, type MapPoint } from '../geo/LeafletMap';
import { hhmmss } from '../geo/api';
import { positionAt } from './ReplayBar';

export const ROUTE_COLORS = ['#1f5fd1', '#15803d', '#7c3aed', '#c2410c', '#0f766e', '#a21caf', '#b45309', '#0369a1'];

/** Map layers of a playback plan: the routes of every vehicle, departures, pickups, drop-offs and unserved riders. */
export function planLayers(plan: Json): { points: MapPoint[]; lines: MapLine[] } {
  const lines: MapLine[] = (plan.vehicles as Json[]).map((v, i) => ({ coords: v.path.map((p: number[]) => [p[0], p[1]]), color: v.rider ? ROUTE_COLORS[i % ROUTE_COLORS.length] : '#94a3b8', weight: v.rider ? 4 : 2, dash: v.rider ? undefined : '4 6', label: v.rider ? `${v.driver} carries ${v.rider}` : `${v.driver} alone` }));
  const points: MapPoint[] = [
    ...(plan.vehicles as Json[]).map((v) => ({ lat: v.path[0][0], lon: v.path[0][1], color: COLORS.driver, radius: 5, label: `${v.driver} departs ${hhmmss(v.path[0][2])}` })),
    ...(plan.vehicles as Json[]).flatMap((v) => v.stops.filter((s: Json) => s.type === 'pickup' || s.type === 'dropoff').map((s: Json) => ({ lat: s.at[0], lon: s.at[1], color: COLORS.match, fill: s.type === 'pickup', radius: 5, label: `${s.rider} ${s.type === 'pickup' ? 'pickup' : 'drop-off'} ${hhmmss(s.t)}` }))),
    ...(plan.unserved as Json[]).map((u) => ({ lat: u.at[0], lon: u.at[1], color: COLORS.unserved, radius: 6, label: `${u.rider} unserved` }))];
  return { points, lines };
}

/** Vehicle positions at time t (replay). */
export const planPositions = (plan: Json, t: number): MapPoint[] =>
  (plan.vehicles as Json[]).flatMap((v, i) => { const p = positionAt(v.path, t); return p ? [{ lat: p[0], lon: p[1], color: v.rider ? ROUTE_COLORS[i % ROUTE_COLORS.length] : '#64748b', label: v.driver }] : []; });
