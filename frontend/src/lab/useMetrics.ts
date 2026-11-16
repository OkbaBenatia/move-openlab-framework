import { useCallback, useEffect, useMemo, useState } from 'react';
import { call } from '../api/client';
import { lab, type Experiment, type ResultRow } from './api';
import { cellOf, servedOf } from './compareData';
import { chosenIds, isDefault } from './metricChoice';
import { metricDefs, type Ctx, type CustomMetric, type MetricDef, type MlEvaluation } from './metrics';
import { scenarioLabel } from './scenarioNames';

/** A choice made without "Keep this choice for my account": kept while the tab lives, shared by every view. */
const session: Record<string, string[]> = {};

/** Labelled ML evaluations of the given rows, asked once per row (never derived in the interface). With `enabled`
 *  false nothing is requested: a view that shows no ML metric does not ask for them. */
export function useMlEvaluations(rows: ResultRow[], enabled = true) {
  const [evals, setEvals] = useState<Record<string, MlEvaluation>>({});
  const keys = rows.map((r) => `${r.campaign_id}:${r.method_id}`).join(',');
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    for (const r of rows) {
      const k = `${r.campaign_id}:${r.method_id}`;
      if (evals[k]) continue;
      lab.evaluation(r.campaign_id, r.method_id).then((e) => { if (live) setEvals((cur) => ({ ...cur, [k]: e as MlEvaluation })); }).catch(() => { /* reported as loading */ });
    }
    return () => { live = false; };
  }, [keys, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const mlOf = useCallback((r: ResultRow) => evals[`${r.campaign_id}:${r.method_id}`] ?? null, [evals]);
  const reload = useCallback((r: ResultRow) => lab.evaluation(r.campaign_id, r.method_id).then((e) => setEvals((cur) => ({ ...cur, [`${r.campaign_id}:${r.method_id}`]: e as MlEvaluation }))), []);
  return { mlOf, reload };
}

/** The metrics of an experiment's problem and the account's choice among them: ONE selection per problem for the
 *  Workspace results, Compare › Methods, Compare › Experiments, the charts and the exported tables. `compact` only
 *  changes the defaults (a narrow table starts with fewer columns); a choice made anywhere applies everywhere. */
export function useMetricChoice(exp: Experiment | null, { compact = false, population = 0 }: { compact?: boolean; population?: number } = {}) {
  const [customs, setCustoms] = useState<CustomMetric[]>([]);
  const [saved, setSaved] = useState<Record<string, string[]> | null>(null);
  const [local, setLocal] = useState<Record<string, string[]>>(session);
  const [choosing, setChoosing] = useState(false);
  const problemId = exp?.campaign.problem_id ?? '';
  useEffect(() => { lab.state().then((s) => setSaved(s.preferences.metrics ?? {})).catch(() => setSaved({})); }, []);
  useEffect(() => { if (problemId) call<{ metrics: CustomMetric[] }>(`/lab/metrics?problem_id=${encodeURIComponent(problemId)}`).then((d) => setCustoms(d.metrics)).catch(() => { /* optional */ }); }, [problemId]);
  const nScen = exp?.scenarios.length ?? 0;
  const defs = useMemo(() => metricDefs(exp, customs, { nScen, reps: exp?.campaign.repetitions ?? 1, riders: (k) => servedOf(exp, k), population, names: (k) => scenarioLabel(exp?.scenarios[k], k) }),
    [exp, customs, nScen, population]);
  const stored = local[problemId] ?? saved?.[problemId];
  const chosen = useMemo(() => chosenIds(defs, stored, compact), [defs, stored, compact]);
  const visible = useMemo(() => defs.filter((d) => chosen.has(d.id)), [defs, chosen]);
  const apply = (ids: string[], remember: boolean) => {
    setChoosing(false);
    // the defaults need no stored choice: an empty list clears what was kept for this problem
    const keep = isDefault(defs, new Set(ids), compact) ? [] : ids;
    if (remember) {
      delete session[problemId]; setLocal({ ...session });
      setSaved((s) => ({ ...(s ?? {}), [problemId]: keep }));
      lab.prefs({ metrics: { [problemId]: keep } }).catch(() => { /* preference only */ });
    } else { session[problemId] = ids; setLocal({ ...session }); }
  };
  /** Why nobody in `rows` can show a metric (for the dialog): the common reason, or null when some row has a value. */
  const unavailable = useCallback((d: MetricDef, rows: ResultRow[], ctx: Ctx) => {
    if (!exp || !rows.length) return null;
    const whys = rows.map((r) => { const c = cellOf(r, 'all', exp, exp); const v = c ? d.get(c, r, 'all', ctx) : null; return v == null && !d.text ? d.why?.(r, 'all', ctx) ?? null : null; });
    return whys.every((w) => !!w) ? whys.find((w) => !!w && !/reference/i.test(w)) ?? null : null;
  }, [exp]);
  return { defs, chosen, visible, customs, problemId, choosing, open: () => setChoosing(true), close: () => setChoosing(false), apply, unavailable,
    /** Whether a choice is kept for the account (the dialog's "Keep this choice" starts ticked unless a tab-only one is active). */
    remembered: !(problemId in local) };
}
