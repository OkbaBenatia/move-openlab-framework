import { call, post, type Json } from '../api/client';
import type { Scenario } from '../geo/api';

/** Mobility domain: vehicle profiles, emission configuration, the wizard's composition and the A/B diff. */
export interface ParamRecord { value: number | null; unit: string; basis?: 'CO2' | 'CO2e'; source?: string; source_version?: string; applicability?: string; notes?: string; recorded_at?: string }
export interface VehicleProfile {
  id: string; name: string; category: string; passenger_capacity: number; powertrain: 'ICE' | 'HEV' | 'PHEV' | 'BEV' | 'custom'; energy: string;
  parameters: Record<string, ParamRecord>; provenance: Json; version?: number; updated_at?: string;
}
export interface ParamDef { id: string; label: string; unit: string; factor: boolean }
export interface VehiclesInfo {
  presets: VehicleProfile[]; mine: VehicleProfile[]; default: VehicleProfile | null; parameters: ParamDef[]; powertrains: string[];
  scopes: { id: string; definition: string }[]; baselines: { id: string; definition: string }[]; default_emissions: EmissionsConfig;
}
export interface EmissionsConfig { scope: string; baseline: string }
export interface Domain {
  complete: boolean; scope: string; baseline: string; missing?: string[]; scope_definition?: string; baseline_definition?: string; basis?: string;
  solution_g?: number; baseline_g?: number; avoided_g?: number; avoided_pct?: number | null; per_vehicle_g?: number | null; per_served_request_g?: number | null;
  per_passenger_km_g?: number | null; vehicle_km?: number; baseline_vehicle_km?: number; passenger_km?: number; served?: number; vehicles_used?: number; fleet?: Record<string, number>;
  parameters?: Record<string, Record<string, ParamRecord>>;
}
export interface ScenarioVehicles { profiles: VehicleProfile[]; default: string; assignments: Record<string, string> }
export interface Compose {
  source: 'synthetic' | 'dataset' | 'manual'; network_id: string; name: string; n_drivers: number; n_riders: number; seed: number; start_s: number; end_s: number;
  params: { max_detour_s: number; max_detour_ratio: number }; min_trip_m: number; dataset_key?: string | null; date?: string | null;
  drivers?: Scenario['drivers']; riders?: Scenario['riders']; vehicles?: ScenarioVehicles | null; emissions?: EmissionsConfig | null;
  relocate_seed?: number | null;   // manual: new places for the given participants (ids and time windows kept)
}
export interface Preview { scenario: Scenario & { vehicles?: ScenarioVehicles; emissions?: EmissionsConfig }; summary: Json; agents: { id: string; role: string; direct_s: number; direct_m: number; snap_m: [number, number]; vehicle: string | null }[] }
export interface DiffRow {
  instance_id: string; instance_id_b: string; instance_hash: string; instance_hash_b: string; same_instance: boolean; run_a: string | null; run_b: string | null;
  assignments?: { same: number; changed: number; only_a: number; only_b: number; detail: { driver: string; a: string | null; b: string | null }[] };
  served?: { a: number; b: number; both: number; only_a: string[]; only_b: string[] };
  metrics?: { a: Record<string, number>; b: Record<string, number> }; runtime?: { a: number | null; b: number | null }; emissions?: { a: Domain | null; b: Domain | null };
}
export interface Diff {
  a: DiffSide; b: DiffSide; rows: DiffRow[]; matched: number; unmatched: { a: number; b: number };
  totals: { metrics: { a: Record<string, number>; b: Record<string, number> }; runtime: { a: number | null; b: number | null }; emissions: { a: Domain | null; b: Domain | null };
    assignments: { same: number; changed: number; only_a: number; only_b: number }; served: { a: number; b: number } };
  comparability: { quality: string; runtime: string; emissions: string | null; reasons: string[] } | null;
  metrics: { id: string; label: string; unit: string; better: string | null }[]; domain_metrics: { id: string; label: string; unit: string; better: string | null }[];
}
export interface DiffSide { campaign_id: string; title: string; kind: string; method_id: string | null; methods: string[]; owner_display: string; emissions: EmissionsConfig | null }

export const mob = {
  vehicles: () => call<VehiclesInfo>('/lab/vehicles'),
  saveVehicle: (p: VehicleProfile) => call<VehicleProfile>('/lab/vehicles', { method: 'PUT', body: JSON.stringify(p) }),
  duplicateVehicle: (id: string) => post<VehicleProfile>(`/lab/vehicles/${encodeURIComponent(id)}/duplicate`),
  preview: (body: Compose) => post<Preview>('/geo/scenarios/preview', body),
  saveScenario: (scenario: Json, basis: Compose | null, parent?: string, fromInstance?: string) => post('/geo/scenarios', { scenario, basis: basis ?? undefined, parent, from_instance: fromInstance }),
  run: (body: Json) => post<{ campaign_id: string; job: Json }>('/lab/run', body),
  diff: (a: string, b: string, ma?: string, mb?: string) => call<Diff>(`/lab/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}${ma ? `&method_a=${encodeURIComponent(ma)}` : ''}${mb ? `&method_b=${encodeURIComponent(mb)}` : ''}`),
};

export const SCOPE_LABEL: Record<string, string> = { tailpipe: 'Tailpipe only', 'operational-energy': 'Fuel and electricity use', 'direct-intensity': 'Direct CO₂/km' };
export const BASELINE_LABEL: Record<string, string> = { 'everyone-drives-alone': 'Everyone drives alone', 'drivers-only': 'Drivers only' };
export const POWERTRAIN_LABEL: Record<string, string> = { ICE: 'Combustion (ICE)', HEV: 'Hybrid (HEV)', PHEV: 'Plug-in hybrid (PHEV)', BEV: 'Battery-electric (BEV)', custom: 'Custom' };

/** Grams of CO2 as text: 850 g · 12.4 kg · 3.21 t. */
export const grams = (g: number | null | undefined) => (g == null ? '—' : Math.abs(g) < 1000 ? `${Math.round(g)} g` : Math.abs(g) < 1e6 ? `${(g / 1000).toFixed(g < 1e4 ? 2 : 1)} kg` : `${(g / 1e6).toFixed(2)} t`);
export const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)} %`);

/** A domain figure for tables and charts (aggregated rows). */
export const domainValue = (d: Domain | null | undefined, id: string): number | null => (d && d.complete ? ((d as unknown as Record<string, unknown>)[id] as number | null | undefined) ?? null : null);

/** Emission figures of several rows are shown side by side only when every row has complete figures under one
 *  scope, baseline and CO2/CO2e basis. */
export function sameEmissionSemantics(ds: (Domain | null | undefined)[]): boolean {
  if (!ds.length || !ds.every((d) => !!d && d.complete)) return false;
  return new Set(ds.map((d) => `${d!.scope}|${d!.baseline}|${d!.basis}`)).size === 1;
}

/** Fleet of a scenario in one line: "Petrol car ×19 · Battery-electric car ×1". */
export const fleetText = (v: { fleet: { name: string; drivers: number }[] } | null | undefined) => (v ? v.fleet.map((f) => `${f.name} ×${f.drivers}`).join(' · ') : '');
