/** Scenario matching between compared experiments (no imports: unit-tested on its own).
 *  Sample k of a comparison is the reference's k-th scenario, found in another experiment by its frozen instance hash —
 *  never by position: two experiments may list other scenarios, or the same ones in another order. */
export interface Scenarios { scenarios: { instance_hash: string; riders?: number | null }[] }

/** Whether two experiments cover exactly the same frozen scenarios (instance hashes, order ignored). */
export const sameScenarios = (e: Scenarios | null, ref: Scenarios | null): boolean => {
  const key = (x: Scenarios) => x.scenarios.map((s) => s.instance_hash).sort().join(',');
  return !!e && !!ref && key(e) === key(ref);
};
/** Instance hash of sample k (the reference's k-th scenario). */
export const sampleHash = (k: number, ref: Scenarios | null): string | undefined => ref?.scenarios[k]?.instance_hash;
/** Whether experiment e's totals over all its scenarios may stand beside the reference's (same scenario set). */
export const totalsComparable = (e: Scenarios | null, ref: Scenarios | null): boolean => !!e && (e === ref || sameScenarios(e, ref));
/** Riders in one scope; the sum over all scenarios only where the scenario set is the reference's. */
export const ridersOf = (e: Scenarios | null, k: number | 'all', ref: Scenarios | null = e): number | null => {
  if (k !== 'all') { const h = sampleHash(k, ref ?? e); return e?.scenarios.find((s) => s.instance_hash === h)?.riders ?? null; }
  return totalsComparable(e, ref) ? e!.scenarios.reduce((s, x) => s + (x.riders ?? 0), 0) : null;
};
