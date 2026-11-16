import { useMemo } from 'react';
import type { Experiment, ResultRow } from './api';
import { CompareCharts } from './CompareCharts';
import type { Side } from './compareData';
import { MetricChooser } from './MetricChooser';
import type { Ctx } from './metrics';
import { useMetricChoice, useMlEvaluations } from './useMetrics';

const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', '#9085e9', '#e87ba4', '#4f8a5b', '#b7791f', '#5b6b8c'];
const ME = '*';

/** Charts of an experiment's methods in the Workspace (a problem without a map shows them in place of the map): the
 *  same charts, metric choice, chart types and exports as Compare › Methods. */
export function WorkspaceCharts({ exp }: { exp: Experiment }) {
  const mc = useMetricChoice(exp);
  // one row per method (the experiment's own row first, else the lineage row it shows)
  const rows = useMemo(() => {
    const cid = exp.campaign.campaign_id, m = new Map<string, ResultRow>();
    for (const r of exp.results?.rows ?? []) { const k = `${r.method_id}@${r.version}`; const cur = m.get(k); if (!cur || (r.campaign_id === cid && cur.campaign_id !== cid)) m.set(k, r); }
    return exp.view?.mode === 'study' ? exp.results?.rows ?? [] : Array.from(m.values());
  }, [exp]);
  const { mlOf } = useMlEvaluations(rows, mc.visible.some((d) => d.group === 'ml'));
  const sides: Side[] = rows.map((r, i) => ({ label: String.fromCharCode(65 + i), e: exp, rows: new Map([[ME, r]]), name: r.name }));
  const ctx: Ctx = { ref: null, refRow: rows[0] ?? null, ml: mlOf };
  return <>
    <CompareCharts sides={sides} colors={sides.map((_, i) => SERIES[i % SERIES.length])} methodIds={[ME]} cands={[]} customs={mc.customs} methodSides chosen={mc.chosen} mlOf={mlOf} onChoose={mc.open} />
    {mc.choosing && <MetricChooser defs={mc.defs} chosen={mc.chosen} onApply={mc.apply} onClose={mc.close} remembered={mc.remembered} unavailable={(d) => mc.unavailable(d, rows, ctx)} />}
  </>;
}
