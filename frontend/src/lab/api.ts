import { call, post, type Json, type Metric } from '../api/client';

export interface LabState { preferences: { tour_dismissed: boolean | null; last_experiment: string | null; area_id: string | null }; demo: { available: boolean; installed: boolean; campaigns: string[] } }
export interface ExpItem { campaign_id: string; title: string; kind: string; status: string; problem_id: string; imported: boolean; locked: boolean; created_at: string; owner_display: string; parent: string | null; demo: boolean; network_ids: string[]; dataset_keys: string[] }
export interface Descriptive { id: string; label: string; unit: string; value: number | null; better: string }
export interface ResultRow {
  method_id: string; version: string; name: string; kind: string; source: string; campaign_id: string; origin: string; campaign_kind: string; researcher: string;
  scenarios: number; valid: boolean; proven_optimal: number; optimal: number | null; totals: Record<string, number>; descriptive: Descriptive[];
  gap_pct: number | null; solver_time_s: number | null; total_time_s: number | null; mean_rank: number | null; reproduction: string | null;
}
export interface Experiment {
  campaign: { campaign_id: string; title: string; kind: string; status: string; locked: boolean; owner_display: string; created_at: string; imported: boolean; imported_from: string | null;
    parent: { campaign_id: string; relation: string; kind: string } | null; variant: string | null; problem_id: string; repetitions: number };
  context: { area: { label: string | null; network_id: string | null; area_id?: string; bbox?: [number, number, number, number] }; dataset: string | null; scenario: string };
  problem: { title: string; synthetic: boolean; metrics: Metric[]; objective: { metric: string; sense: string }[] };
  scenarios: { instance_hash: string; instance_id: string; name: string | null; drivers?: number; riders?: number; pairs?: number }[];
  methods: { method_id: string; version: string; name: string; kind: string; source: string }[];
  runs: { run_id: string; campaign_id: string; instance_hash: string; method_id: string; accepted: boolean; status: string }[];
  results: { rows: ResultRow[]; warnings: string[]; reference: Json | null } | null;
  comparability: { reference: string; quality: Verdict; runtime: Verdict; reasons: string[] } | null;
  reproduction: { reproduced: boolean; cells: number; agreement: Json } | null;
}
export type Verdict = 'direct' | 'conditional' | 'incompatible';

/** Methods of the experiment and of the ancestors it is compared with (e.g. the parent of an extension). */
export const scopeMethods = (e: Experiment) => Array.from(new Set([...e.methods.map((m) => `${m.method_id}@${m.version}`),
  ...(e.results?.rows ?? []).map((r) => `${r.method_id}@${r.version}`)]));
export const rowKey = (r: { campaign_id: string; method_id: string }) => `${r.campaign_id}:${r.method_id}`;

export const lab = {
  state: () => call<LabState>('/lab/state'),
  prefs: (p: Partial<LabState['preferences']>) => call<LabState>('/lab/preferences', { method: 'PUT', body: JSON.stringify(p) }),
  installDemo: () => post<{ campaigns: string[]; root_campaign_id: string }>('/lab/demo'),
  experiments: () => call<{ experiments: ExpItem[] }>('/lab/experiments'),
  experiment: (cid: string) => call<Experiment>(`/lab/experiments/${cid}`),
};

export const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  direct: { label: 'Directly comparable', cls: 'ok' }, conditional: { label: 'Comparable with conditions', cls: 'warn' }, incompatible: { label: 'Not comparable', cls: 'bad' },
};
