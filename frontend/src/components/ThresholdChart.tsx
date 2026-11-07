import type { Json } from '../api/client';

/** Threshold sensitivity: candidate share kept, runs reaching the full-instance objective, reference recall (0–1). */
export function ThresholdChart({ summary, mode }: { summary: Json[]; mode: string }) {
  const W = 560, H = 230, L = 44, R = 14, T = 14, B = 40;
  const xs = summary.map((s) => s.threshold);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const X = (v: number) => L + (x1 > x0 ? ((v - x0) / (x1 - x0)) * (W - L - R) : (W - L - R) / 2);
  const Y = (v: number) => T + (1 - v) * (H - T - B);
  const series = [
    { key: 'kept', label: 'candidates kept', color: '#1f5fd1', v: (s: Json) => s.mean_kept_share },
    { key: 'equal', label: 'equal objective', color: '#15803d', v: (s: Json) => (s.cells ? s.equal_objective / s.cells : null) },
    { key: 'recall', label: 'reference recall', color: '#c2410c', v: (s: Json) => s.mean_reference_recall },
  ];
  return <figure className="chart">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="threshold sensitivity chart">
      {[0, 0.25, 0.5, 0.75, 1].map((g) => <g key={g}><line x1={L} x2={W - R} y1={Y(g)} y2={Y(g)} className="grid" /><text x={L - 6} y={Y(g) + 4} textAnchor="end" className="tick">{g}</text></g>)}
      {xs.map((x) => <text key={x} x={X(x)} y={H - B + 16} textAnchor="middle" className="tick">{x}</text>)}
      <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" className="tick">{mode === 'share' ? 'share of candidates to keep (dynamic threshold)' : 'score threshold'}</text>
      {series.map((s) => { const pts = summary.map((r) => [X(r.threshold), s.v(r)] as const).filter(([, v]) => v != null) as [number, number][];
        return <g key={s.key}><polyline fill="none" stroke={s.color} strokeWidth={2} points={pts.map(([x, v]) => `${x},${Y(v)}`).join(' ')} />
          {pts.map(([x, v], i) => <circle key={i} cx={x} cy={Y(v)} r={3.5} fill={s.color}><title>{`${s.label}: ${v.toFixed(3)}`}</title></circle>)}</g>; })}
    </svg>
    <figcaption className="row gap small">{series.map((s) => <span key={s.key} className="row"><span className="swatch" style={{ background: s.color }} />{s.label}</span>)}</figcaption>
  </figure>;
}
