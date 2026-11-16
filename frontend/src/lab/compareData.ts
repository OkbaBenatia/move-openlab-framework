import type { Domain } from '../mobility/api';
import { num } from '../components/common';
import type { Experiment, Facts, FactDef, ResultRow } from './api';
import { sampleHash, totalsComparable } from './scenarioMatch';

/** One row per method of an experiment (its own row first, else the lineage row it shows). */
export function byMethod(e: Experiment | null): Map<string, ResultRow> {
  const out = new Map<string, ResultRow>();
  for (const r of e?.results?.rows ?? []) { const cur = out.get(r.method_id); if (!cur || (r.campaign_id === e!.campaign.campaign_id && cur.campaign_id !== e!.campaign.campaign_id)) out.set(r.method_id, r); }
  return out;
}
export { gapLabel, hasCap, participantsOf, ridersOf, sameScenarios, servedLabel, servedOf } from './scenarioMatch';
/** The values of one method in one scope: one scenario (the reference's k-th, matched by instance hash), or all
 *  scenarios — the experiment's totals, which are put beside the reference's only when both cover the same scenarios
 *  (a total over another scenario set is not comparable: no value rather than a misleading delta). */
export interface Cell { obj: Record<string, number>; time: number | null; gap: number | null; dom: Domain | null | undefined; custom: Record<string, number | null>;
  runs: { repetition: number; total_time_s: number | null }[]; facts: Facts;
  /** Validation of the runs behind the values: accepted by the independent validator / executed, and whether the
   *  repetitions gave identical results. `status` is what one scenario's result proves (null over all scenarios). */
  accepted: number; executed: number; consistent: boolean; status: string | null }
export const cellOf = (r: ResultRow | undefined, k: number | 'all', e: Experiment | null, ref: Experiment | null = e): Cell | null => {
  if (!r || !e) return null;
  if (k === 'all' && !totalsComparable(e, ref)) return null;
  if (k === 'all') { const cells = Object.values(r.per_scenario);
    return { obj: r.totals, time: r.total_time_s, gap: r.gap_pct, dom: r.domain, custom: r.custom ?? {}, runs: cells.flatMap((c) => c.runs ?? []), facts: r.facts ?? {},
      accepted: cells.reduce((n, c) => n + c.accepted, 0), executed: cells.reduce((n, c) => n + c.repetitions, 0), consistent: r.repetitions_consistent, status: null }; }
  const h = sampleHash(k, ref ?? e, e);
  const c = h ? r.per_scenario[h] : undefined;
  return c ? { obj: c.metrics, time: c.median_total_time_s, gap: c.gap_pct, dom: c.domain, custom: c.custom ?? {}, runs: c.runs ?? [], facts: c.facts ?? {},
    accepted: c.accepted, executed: c.repetitions, consistent: c.consistent, status: c.optimality } : null;
};
/** A recorded fact as text: seconds, percentages, fractions shown as %, small numbers with 3 significant digits. */
export const fmtFact = (v: number | string | null | undefined, f: FactDef): string => {
  if (v == null || v === '') return '—';
  if (typeof v === 'string') return v;
  if (f.unit === 's') return v < 1 ? `${num(v * 1000, 1)} ms` : `${num(v, 2)} s`;
  if (f.unit === '%') return `${num(v, 2)} %`;
  if (f.unit === 'fraction') return `${num(100 * v, 2)} %`;
  return v !== 0 && Math.abs(v) < 0.01 ? v.toPrecision(3) : num(v, Number.isInteger(v) ? 0 : 2);
};
/** A translator: `tr` of the interface, or `plain` for what an exported file carries. */
export type Translate = (text: string, vars?: Record<string, string | number>) => string;
/** The English text with its placeholders filled, whatever the interface language: exported files stay in English. */
export const plain: Translate = (text, vars) => Object.entries(vars ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
/** Basis of a fact over all scenarios (in English: translated where it is shown). */
export const FACT_BASIS: Record<string, string> = { sum: 'sum', median: 'median over scenarios', ratio: 'ratio of sums', none: 'this scenario' };
/** One compared experiment: its column letter, record and rows by method. */
/** One compared side: an experiment (its methods as rows), or — when methods of one experiment are compared — one method. */
export interface Side { label: string; e: Experiment | null; rows: Map<string, ResultRow>; name?: string }
