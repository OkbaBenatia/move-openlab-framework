import { call, post, type Json, type Metric } from '../api/client';
import type { Domain, EmissionsConfig } from '../mobility/api';
import type { Presentation } from './scenarioMatch';

export interface SampleState { available: boolean; title?: string; filename?: string; bytes?: number; sha256?: string; format?: string; runs?: number; scenarios?: number;
  check?: { checked_at: string; reproduction: { cells: number; agreement: Record<string, number>; reproduced: boolean; rule: string } }; imported?: boolean; campaign_id?: string }
/** The public sample scenario package (move-openlab-scenario/1) and its entry in this account's library, if imported. */
export interface SampleScenarioState { available: boolean; title?: string; filename?: string; bytes?: number; sha256?: string; format?: string;
  drivers?: number; riders?: number; pairs?: number; instance_hash?: string; licences?: Json[]; experiment_filename?: string; scenario_id?: string | null }
export interface LabState {
  preferences: { tour_dismissed: boolean | null; start_dismissed: boolean | null; details_open?: boolean | null; theme: 'light' | 'dark' | null; language?: 'en' | 'fr' | null; metrics?: Record<string, string[]> | null; last_experiment: string | null; area_id: string | null; hidden_ids: string[];
    workspace?: WorkspaceView | null };
  demo: { available: boolean; installed: boolean; campaigns: string[]; area: string | null }; sample: SampleState;
  /** The public sample trip dataset (scenario import example), when shipped. */
  sample_trips?: import('./SampleTripsGuide').SampleTrips | null;
  /** The public sample scenario package, when shipped. */
  sample_scenario?: SampleScenarioState | null;
}
export interface Validation { runs: number; accepted: number; validator_version: string | null }
export type Group = 'demo' | 'mine' | 'imported' | 'reproduction' | 'benchmark';
export type Category = 'Demo' | 'Imported' | 'Generated' | 'Edited' | 'Reproduced';
export const CATEGORIES: Category[] = ['Demo', 'Imported', 'Generated', 'Edited', 'Reproduced'];
export interface ExpItem { campaign_id: string; title: string; kind: string; status: string; problem_id: string; imported: boolean; locked: boolean; created_at: string; owner_display: string; parent: string | null; demo: boolean; category: Category; hidden: boolean; network_ids: string[]; dataset_keys: string[];
  group: Group; area: string | null; data: string | null; sampled: boolean; scenarios: number; problem: string; synthetic: boolean; methods: string[]; validation: Validation }
export interface ScenarioCell { metrics: Record<string, number>; repetitions: number; consistent: boolean; feasible: boolean; accepted: number; optimality: string;
  median_solver_time_s: number | null; median_total_time_s: number | null; domain: Domain | null; gap_pct: number | null;
  runs?: { repetition: number; total_time_s: number | null; solver_time_s: number | null; accepted: boolean }[]; custom?: Record<string, number | null>; facts?: Facts;
  /** Why the independent validator rejected this cell (its own messages; empty when every run was accepted). */
  errors?: string[] }
/** Per-run figures a problem's methods record (display only), and their definitions. */
export type Facts = Record<string, number | string | null>;
export interface FactDef { id: string; label: string; unit: string; kind: 'number' | 'text'; aggregate: 'sum' | 'median' | 'ratio' | 'none'; of?: [string, string]; group: string;
  /** Optional: the metric group it is offered in (default: optimization), whether it is shown by default, a definition, and whether reference ÷ this is offered as a speed-up. */
  category?: 'optimization' | 'ml' | 'performance' | 'mobility'; default?: boolean; help?: string; speedup?: boolean }
export interface Descriptive { id: string; label: string; unit: string; value: number | null; better: string }
export interface ResultRow {
  method_id: string; version: string; name: string; kind: string; source: string; campaign_id: string; origin: string; campaign_kind: string; researcher: string;
  scenarios: number; valid: boolean; proven_optimal: number; reduced_optimal?: number; time_limited?: number; facts?: Facts; recorded_name?: string; optimal: number | null; totals: Record<string, number>; descriptive: Descriptive[]; domain: Domain | null;
  gap_pct: number | null; solver_time_s: number | null; total_time_s: number | null; mean_rank: number | null; reproduction: string | null;
  repetitions: number; repetitions_consistent: boolean; per_scenario: Record<string, ScenarioCell>; custom?: Record<string, number | null>;
  /** Where the row comes from (its experiment), a study's note about it, and the method's own display name. */
  experiment?: string | null; note?: string | null; method_name?: string;
}
/** A saved study view: methods of one or several experiments shown together on the same scenarios. */
export interface StudyMember { campaign_id: string; method_id: string; label?: string; note?: string; name?: string; runs?: number; experiment?: string; locked?: boolean; kind?: string; imported_results?: boolean; imported?: boolean; checksum?: string | null }
export interface Study { study_id: string; title: string; description?: string; members: StudyMember[]; featured_instance?: string | null; problem_id?: string; scenarios?: number }
export interface Provenance { source: string | null; sampled: boolean; release: string | null; attribution: string | null; licence: string | null; method: string | null;
  generator: string | null; window: [number, number] | null; pool_size: number | null; seeds: (number | null)[]; observed_trips: number | null; edited: string[] }
export interface FleetEntry { id: string; name: string; powertrain: string; energy: string | null; passenger_capacity: number | null; drivers: number; provenance: string | null; parameters: Json }
export interface Experiment {
  campaign: { campaign_id: string; title: string; kind: string; status: string; locked: boolean; owner_display: string; created_at: string; imported: boolean; imported_from: string | null; result_import?: { source: string | null; counts: Record<string, number> } | null;
    parent: { campaign_id: string; relation: string; kind: string } | null; variant: string | null; problem_id: string; repetitions: number; emissions: EmissionsConfig | null; category: Category; method_configs?: Record<string, Record<string, unknown>> };
  context: { area: { label: string | null; network_id: string | null; area_id?: string; bbox?: [number, number, number, number] }; dataset: string | null; scenario: string };
  problem: { title: string; synthetic: boolean; metrics: Metric[]; objective: { metric: string; sense: string }[]; domain_metrics: { id: string; label: string; unit: string; better: string | null }[]; presentation?: Presentation; facts?: FactDef[] };
  validation: Validation; provenance: Provenance;
  scenarios: { instance_hash: string; instance_id: string; derived_from?: string | null; name: string | null; seed: number | null; edited: string[]; drivers?: number; riders?: number; served_of?: number; pairs?: number; notes?: string[]; vehicles: { fleet: FleetEntry[]; default: { id: string; name: string } | null } | null; emissions: EmissionsConfig | null }[];
  methods: { method_id: string; version: string; name: string; kind: string; source: string }[];
  runs: { run_id: string; campaign_id: string; instance_hash: string; method_id: string; accepted: boolean; status: string }[];
  job_id: string | null;
  results: { rows: ResultRow[]; warnings: string[]; reference: Json | null } | null;
  comparability: { reference: string; quality: Verdict; runtime: Verdict; emissions: Verdict | null; reasons: string[] } | null;
  reproduction: { reproduced: boolean; cells: number; agreement: Json } | null;
  /** How the results are shown: the experiment's own records, or a saved study it is a member of. */
  view?: { mode: 'study' | 'records'; study: Study | null; studies: { study_id: string; title: string }[] };
}
export type Verdict = 'direct' | 'conditional' | 'incompatible';

/** Methods of the experiment and of the ancestors it is compared with (e.g. the parent of an extension). */
export const scopeMethods = (e: Experiment) => Array.from(new Set([...e.methods.map((m) => `${m.method_id}@${m.version}`),
  ...(e.results?.rows ?? []).map((r) => `${r.method_id}@${r.version}`)]));
export const rowKey = (r: { campaign_id: string; method_id: string }) => `${r.campaign_id}:${r.method_id}`;

/** What the Workspace showed for the last experiment, kept per account and restored on return. */
export interface WorkspaceView { campaign_id: string; instance_hash: string; methods: string[]; result: string; scope: 'scenario' | 'all'; map?: { center: [number, number]; zoom: number } | null }

export const lab = {
  state: () => call<LabState>('/lab/state'),
  prefs: (p: Partial<LabState['preferences']>) => call<LabState>('/lab/preferences', { method: 'PUT', body: JSON.stringify(p) }),
  installDemo: () => post<{ campaigns: string[]; root_campaign_id: string }>('/lab/demo'),
  experiments: () => call<{ experiments: ExpItem[] }>('/lab/experiments'),
  experiment: (cid: string, view: '' | 'records' = '') => call<Experiment>(`/lab/experiments/${cid}${view ? `?view=${view}` : ''}`),
  studies: () => call<{ studies: Study[] }>('/lab/studies'),
  evaluation: (cid: string, methodId: string) => call<Json>(`/lab/experiments/${cid}/evaluation?method_id=${encodeURIComponent(methodId)}`),
  /** The same evaluations with the threshold-adjustable ones recomputed at an exploratory threshold (nothing is stored). */
  evaluationAt: (cid: string, methodId: string, threshold: number) => call<Json>(`/lab/experiments/${cid}/evaluation?method_id=${encodeURIComponent(methodId)}&threshold=${encodeURIComponent(String(threshold))}`),
  /** Import evaluation evidence for one method: a JSON evidence file, or a CSV of records with its metadata (a JSON object). */
  importEvidence: (cid: string, methodId: string, file: File, metadata?: Record<string, unknown>) => {
    const fd = new FormData(); fd.append('file', file); fd.append('method_id', methodId);
    if (metadata) fd.append('metadata', JSON.stringify(metadata));
    return call<{ evidence_sha256: string; created: boolean; records: number }>(`/lab/experiments/${cid}/evaluation`, { method: 'POST', body: fd });
  },
  evidencePath: (cid: string, sha: string) => `/lab/experiments/${cid}/evaluation/evidence/${sha}`,
  /** Hide one imported evidence from the evaluation; the stored file is kept. */
  withdrawEvidence: (cid: string, sha: string) => post<Json>(`/lab/experiments/${cid}/evaluation/evidence/${sha}/withdraw`),
};

export const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  direct: { label: 'Directly comparable', cls: 'ok' }, conditional: { label: 'Comparable with conditions', cls: 'warn' }, incompatible: { label: 'Not comparable', cls: 'bad' },
};
