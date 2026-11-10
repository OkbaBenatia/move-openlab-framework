import type { Domain } from '../mobility/api';
import type { Experiment, ResultRow } from './api';
import { sampleHash, totalsComparable } from './scenarioMatch';

/** One row per method of an experiment (its own row first, else the lineage row it shows). */
export function byMethod(e: Experiment | null): Map<string, ResultRow> {
  const out = new Map<string, ResultRow>();
  for (const r of e?.results?.rows ?? []) { const cur = out.get(r.method_id); if (!cur || (r.campaign_id === e!.campaign.campaign_id && cur.campaign_id !== e!.campaign.campaign_id)) out.set(r.method_id, r); }
  return out;
}
export { ridersOf, sameScenarios } from './scenarioMatch';
/** The values of one method in one scope: one scenario (the reference's k-th, matched by instance hash), or all
 *  scenarios — the experiment's totals, which are put beside the reference's only when both cover the same scenarios
 *  (a total over another scenario set is not comparable: no value rather than a misleading delta). */
export interface Cell { obj: Record<string, number>; time: number | null; gap: number | null; dom: Domain | null | undefined; custom: Record<string, number | null>;
  runs: { repetition: number; total_time_s: number | null }[] }
export const cellOf = (r: ResultRow | undefined, k: number | 'all', e: Experiment | null, ref: Experiment | null = e): Cell | null => {
  if (!r || !e) return null;
  if (k === 'all' && !totalsComparable(e, ref)) return null;
  if (k === 'all') return { obj: r.totals, time: r.total_time_s, gap: r.gap_pct, dom: r.domain, custom: r.custom ?? {},
    runs: Object.values(r.per_scenario).flatMap((c) => c.runs ?? []) };
  const h = sampleHash(k, ref ?? e);
  const c = h ? r.per_scenario[h] : undefined;
  return c ? { obj: c.metrics, time: c.median_total_time_s, gap: c.gap_pct, dom: c.domain, custom: c.custom ?? {}, runs: c.runs ?? [] } : null;
};
/** One compared experiment: its column letter, record and rows by method. */
/** One compared side: an experiment (its methods as rows), or — when methods of one experiment are compared — one method. */
export interface Side { label: string; e: Experiment | null; rows: Map<string, ResultRow>; name?: string }
