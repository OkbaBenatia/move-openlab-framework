/** Scenario matching between compared experiments (no imports: unit-tested on its own).
 *  Sample k of a comparison is the reference's k-th scenario, found in another experiment by its frozen instance: the
 *  same instance hash, or — for a controlled variant — the derived instance whose parent is that instance (the
 *  comparison engine matches scenarios the same way). Never by position: two experiments may list other scenarios, or
 *  the same ones in another order. */
export interface Scenario { instance_hash: string; riders?: number | null; served_of?: number | null; derived_from?: string | null }
export interface Scenarios { scenarios: Scenario[] }

/** What the experiment's problem lets the interface show (the server's `Problem.presentation()`). */
export interface Presentation { capabilities: string[]; participants: string | null; served_label: string | null; authoring_note?: string | null }
interface WithProblem { problem?: { presentation?: Presentation } }
/** Whether the problem declares a capability: "map" (coordinates on the map), "playback" (route playback). */
export const hasCap = (e: WithProblem | null | undefined, cap: string): boolean => !!e?.problem?.presentation?.capabilities.includes(cap);
/** Label of the problem's `served` metric (ride matching: "Served riders"). */
export const servedLabel = (e: WithProblem | null | undefined): string => e?.problem?.presentation?.served_label ?? 'Served riders';
/** Plural noun of what `served` counts (ride matching: "riders"). */
export const participantsOf = (e: WithProblem | null | undefined): string => e?.problem?.presentation?.participants ?? 'riders';
/** Denominator of `served` in one scenario: the problem's own (`served_of`), else the scenario's riders. */
const outOf = (s: Scenario): number | null => s.served_of ?? s.riders ?? null;

interface RefRow { method_id: string; kind: string; proven_optimal: number; scenarios: number }
/** Label of the relative objective difference against the reference method. It is a gap to an exact reference only
 *  when the reference is proven optimal in every scenario; otherwise it is a difference against a baseline that may be a
 *  time-limited incumbent (it can be negative), named with the reference's proof count. */
export const gapLabel = (rows: RefRow[], refId?: string | null): string => {
  const ref = rows.find((r) => (refId ? r.method_id === refId : r.kind === 'exact'));
  return !ref || ref.proven_optimal >= ref.scenarios ? 'Gap to the exact reference' : `Objective difference vs reference (reference proven optimal ${ref.proven_optimal}/${ref.scenarios})`;
};

/** The frozen instance a scenario stands for: its parent for a derived (variant) instance, else itself. */
const root = (s: Scenario) => s.derived_from || s.instance_hash;
/** Whether two experiments cover the same frozen scenarios (directly or through their derivation; order ignored). */
export const sameScenarios = (e: Scenarios | null, ref: Scenarios | null): boolean => {
  const key = (x: Scenarios) => x.scenarios.map(root).sort().join(',');
  return !!e && !!ref && key(e) === key(ref);
};
/** Instance hash of sample k in experiment e: the reference's k-th scenario itself, or e's scenario derived from it. */
export const sampleHash = (k: number, ref: Scenarios | null, e: Scenarios | null = ref): string | undefined => {
  const r = ref?.scenarios[k];
  if (!r || !e) return undefined;
  return (e.scenarios.find((s) => s.instance_hash === r.instance_hash) ?? e.scenarios.find((s) => root(s) === root(r)))?.instance_hash;
};
/** Whether experiment e's totals over all its scenarios may stand beside the reference's (same scenario set). */
export const totalsComparable = (e: Scenarios | null, ref: Scenarios | null): boolean => !!e && (e === ref || sameScenarios(e, ref));
/** Denominator of `served` (riders for ride matching) in one scope; the sum over all scenarios only where the
 *  scenario set is the reference's. */
export const ridersOf = (e: Scenarios | null, k: number | 'all', ref: Scenarios | null = e): number | null => {
  if (k !== 'all') { const h = sampleHash(k, ref ?? e, e); const s = e?.scenarios.find((x) => x.instance_hash === h); return s ? outOf(s) : null; }
  return totalsComparable(e, ref) ? e!.scenarios.reduce((s, x) => s + (outOf(x) ?? 0), 0) : null;
};
/** The same denominator for one experiment on its own (all its scenarios, or one by index). */
export const servedOf = (e: Scenarios | null | undefined, k: number | 'all'): number | null => {
  if (!e) return null;
  if (k !== 'all') { const s = e.scenarios[k]; return s ? outOf(s) : null; }
  return e.scenarios.reduce((s, x) => s + (outOf(x) ?? 0), 0);
};
