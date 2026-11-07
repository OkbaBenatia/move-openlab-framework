import { call, post, type Json } from '../api/client';

export interface Agent { id: string; origin: [number, number]; destination: [number, number]; earliest: number; latest: number }
export interface Scenario { name: string; network_id: string; params: { max_detour_s: number; max_detour_ratio: number }; drivers: Agent[]; riders: Agent[]; provenance?: Json }
export interface GeoConfig { tile_url: string; tile_attribution: string; can_manage: boolean; networks: Json[]; datasets: Json[]; osm_licence: string }

export const geo = {
  config: () => call<GeoConfig>('/geo/config'),
  network: (id: string) => call(`/geo/networks/${id}`),
  fetchNetwork: (name: string, bbox: number[]) => post('/geo/networks', { name, bbox }),
  route: (id: string, a: [number, number], b: [number, number]) => call(`/geo/networks/${id}/route?a=${a.join(',')}&b=${b.join(',')}`),
  releases: () => call('/geo/opendata/rpc/releases'),
  ingest: (release: string, area_name: string, bbox: number[]) => post('/geo/opendata/rpc/ingest', { release, area_name, bbox }),
  datasets: () => call('/geo/opendata/rpc/datasets'),
  scenarios: () => call<{ scenarios: Json[] }>('/geo/scenarios'),
  scenario: (id: string) => call(`/geo/scenarios/${id}`),
  save: (scenario: Scenario, parent?: string) => post('/geo/scenarios', { scenario, parent }),
  generate: (body: Json) => post('/geo/scenarios/generate', body),
  fromOpenData: (body: Json) => post('/geo/scenarios/from-open-data', body),
  instance: (h: string) => call(`/geo/instances/${h}`),
  playback: (cid: string, run: string) => call(`/geo/playback/${cid}/${run}`),
};

export const hhmm = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
export const hhmmss = (s: number) => `${hhmm(s)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const toSec = (v: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim()); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : NaN; };
export const mins = (s: number) => `${Math.round(s / 60)} min`;
