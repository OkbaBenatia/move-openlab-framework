/** Scenario matching between compared experiments (no imports: unit-tested on its own).
 *  Sample k of a comparison is the reference's k-th scenario, found in another experiment by its frozen instance: the
 *  same instance hash, or — for a controlled variant — the derived instance whose parent is that instance (the
 *  comparison engine matches scenarios the same way). Never by position: two experiments may list other scenarios, or
 *  the same ones in another order. */
export interface Scenario { instance_hash: string; riders?: number | null; derived_from?: string | null }
export interface Scenarios { scenarios: Scenario[] }

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
/** Riders in one scope; the sum over all scenarios only where the scenario set is the reference's. */
export const ridersOf = (e: Scenarios | null, k: number | 'all', ref: Scenarios | null = e): number | null => {
  if (k !== 'all') { const h = sampleHash(k, ref ?? e, e); return e?.scenarios.find((s) => s.instance_hash === h)?.riders ?? null; }
  return totalsComparable(e, ref) ? e!.scenarios.reduce((s, x) => s + (x.riders ?? 0), 0) : null;
};
