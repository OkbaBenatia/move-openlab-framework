import { call, post, type Json } from '../api/client';

export interface Agent { id: string; origin: [number, number]; destination: [number, number]; earliest: number; latest: number }
export interface Scenario { name: string; network_id: string; params: { max_detour_s: number; max_detour_ratio: number }; drivers: Agent[]; riders: Agent[]; provenance?: Json }
export interface Profile { id: string; label: string; max_bbox_deg2: number }
export interface GeoConfig { tile_url: string; tile_attribution: string; can_manage: boolean; can_fetch: boolean; geocoder: boolean; profiles: Profile[]; networks: Json[]; datasets: Json[]; osm_licence: string }
export interface Area { area_id: string; name: string; bbox: [number, number, number, number]; profile: string; km2: number; network_id: string | null; cached_network: string | null; origin: Json; updated_at: string }

const form = (path: string, fields: Record<string, string | Blob | boolean | null | undefined>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') fd.append(k, typeof v === 'boolean' ? String(v) : v);
  return call(path, { method: 'POST', body: fd });
};

export const geo = {
  config: () => call<GeoConfig>('/geo/config'),
  network: (id: string) => call(`/geo/networks/${id}`),
  coverage: (id: string) => call(`/geo/networks/${id}/coverage`),
  route: (id: string, a: [number, number], b: [number, number]) => call(`/geo/networks/${id}/route?a=${a.join(',')}&b=${b.join(',')}`),
  geocode: (q: string) => call(`/geo/geocode?q=${encodeURIComponent(q)}`),
  areas: () => call<{ areas: Area[] }>('/geo/areas'),
  createArea: (body: Json) => post<Area>('/geo/areas', body),
  updateArea: (id: string, body: Json) => call<Area>(`/geo/areas/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteArea: (id: string) => call(`/geo/areas/${id}`, { method: 'DELETE' }),
  areaNetwork: (id: string) => post(`/geo/areas/${id}/network`, {}),
  releases: () => call('/datasets/rpc/releases'),
  ingest: (release: string, area_id: string) => post('/datasets/rpc/ingest', { release, area_id }),
  datasets: () => call('/datasets'),
  dataset: (key: string) => call(`/datasets/${key}`),
  deleteDataset: (key: string) => call(`/datasets/${key}`, { method: 'DELETE' }),
  inspect: (pid: string, file: File, delimiter?: string) => form(`/datasets/${pid}/inspect`, { file, delimiter }),
  importDataset: (pid: string, file: File, f: Record<string, string | boolean | undefined>) => form(`/datasets/${pid}/import`, { file, ...f }),
  scenarios: () => call<{ scenarios: Json[] }>('/geo/scenarios'),
  scenario: (id: string) => call(`/geo/scenarios/${id}`),
  save: (scenario: Scenario, parent?: string) => post('/geo/scenarios', { scenario, parent }),
  generate: (body: Json) => post('/geo/scenarios/generate', body),
  fromDataset: (body: Json) => post('/geo/scenarios/from-dataset', body),
  instance: (h: string) => call(`/geo/instances/${h}`),
  playback: (cid: string, run: string) => call(`/geo/playback/${cid}/${run}`),
};

export const hhmm = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
export const hhmmss = (s: number) => `${hhmm(s)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const toSec = (v: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim()); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : NaN; };
export const mins = (s: number) => `${Math.round(s / 60)} min`;
export const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
export const dur = (s: number) => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`);
