import { useRef, useState } from 'react';
import { num } from '../components/common';

/** One tooltip: lines shown on hover or keyboard focus of a mark (experiment, method, scenario, metric, value, basis). */
export type Tip = string[];
export interface BarSeries { name: string; color: string; values: (number | null)[]; tips: (Tip | null)[] }
export interface BoxSeries { name: string; color: string; values: number[]; tip: Tip }
export interface Point { x: number; y: number; color: string; series: string; tip: Tip }
export type ChartData =
  | { kind: 'bars'; cats: string[]; series: BarSeries[] }          // one series = bar chart; several = grouped bars
  | { kind: 'line'; cats: string[]; series: BarSeries[] }          // only for an ordered x (e.g. repetition 1, 2, 3)
  | { kind: 'box'; series: BoxSeries[] }                           // distribution of recorded values (n ≥ 5)
  | { kind: 'scatter'; points: Point[]; xLabel: string; xUnit: string };

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const color = (c: string) => (c.startsWith('var(') ? css(c.slice(4, -1)) : c);
function save(blob: Blob, name: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
/** Axis ticks covering [lo, hi] (lo may be negative: avoided emissions can be below zero). */
function ticks(lo: number, hi: number): number[] {
  const span = Math.max(1e-9, hi - lo), raw = span / 4, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw) ?? raw;
  const a = Math.floor(lo / step) * step, out: number[] = [];
  for (let v = a; v <= hi + step * 0.5 && out.length < 12; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out.length >= 2 ? out : [a, a + step];
}

/** A chart in the interface's style (resolved colours, Inter, recessive grid), so the exported SVG and PNG look like the
 *  screen. Every mark carries its value; hovering or focusing a mark shows where the number comes from. */
export function Chart({ title, subtitle, unit, data, fmt = (v) => num(v), file, note }: {
  title: string; subtitle: string; unit: string; data: ChartData; fmt?: (v: number) => string; file: string; note?: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; lines: Tip } | null>(null);
  const W = 520, H = 240, pl = 52, pb = 30, pt = 18, pr = 10;
  const ink = css('--muted') || '#66758a', text = css('--text-2') || '#3d4b5f', grid = css('--grid') || '#e6eaf0', axis = css('--axis') || '#9aa6b5';
  const all = data.kind === 'scatter' ? data.points.map((p) => p.y) : data.kind === 'box' ? data.series.flatMap((s) => s.values) : data.series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all) * 1.12 || 1;
  const tk = ticks(lo < 0 ? lo * 1.12 : 0, hi);
  const y0 = tk[0], y1 = tk[tk.length - 1];
  const y = (v: number) => pt + (H - pt - pb) * (1 - (v - y0) / (y1 - y0 || 1));
  const show = (e: React.MouseEvent | React.FocusEvent, lines: Tip) => {
    const host = (e.currentTarget as Element).closest('.chart-card')!.getBoundingClientRect();
    const r = (e.currentTarget as Element).getBoundingClientRect();
    setTip({ x: r.left - host.left + r.width / 2, y: r.top - host.top, lines });
  };
  const mark = (lines: Tip | null | undefined) => lines ? { tabIndex: 0, role: 'img', 'aria-label': lines.join(' · '), onMouseEnter: (e: React.MouseEvent) => show(e, lines),
    onMouseLeave: () => setTip(null), onFocus: (e: React.FocusEvent) => show(e, lines), onBlur: () => setTip(null), style: { cursor: 'default', outline: 'none' } } : {};

  let body: React.ReactNode = null, csvRows: (string | number)[][] = [];
  if (data.kind === 'bars' || data.kind === 'line') {
    const cw = (W - pl - pr) / Math.max(1, data.cats.length), n = data.series.length;
    const bw = Math.max(6, Math.min(28, (cw - 22) / Math.max(1, n) - 2));
    body = <>
      {data.cats.map((c, i) => <text key={c} x={pl + i * cw + cw / 2} y={H - 10} textAnchor="middle" fontSize="11" fill={ink}>{c}</text>)}
      {data.kind === 'bars' ? data.cats.map((c, i) => { const x0 = pl + i * cw + (cw - n * (bw + 2)) / 2;
        return <g key={c}>{data.series.map((s, j) => { const v = s.values[i]; if (v == null) return null; const x = x0 + j * (bw + 2), top = y(Math.max(0, v)), h = Math.abs(y(v) - y(0));
          return <g key={s.name} {...mark(s.tips[i])}><rect x={x} y={top} width={bw} height={Math.max(1, h)} rx={3} fill={color(s.color)} />
            <text x={x + bw / 2} y={v >= 0 ? top - 5 : top + h + 12} textAnchor="middle" fontSize="10.5" fontWeight="600" fill={text}>{fmt(v)}</text></g>; })}</g>; })
        : data.series.map((s) => { const pts = s.values.map((v, i) => (v == null ? null : [pl + i * cw + cw / 2, y(v), v, i] as const)).filter((p): p is readonly [number, number, number, number] => !!p);
          return <g key={s.name}><polyline points={pts.map((p) => `${p[0]},${p[1]}`).join(' ')} fill="none" stroke={color(s.color)} strokeWidth={2} />
            {pts.map((p) => <g key={p[3]} {...mark(s.tips[p[3]])}><circle cx={p[0]} cy={p[1]} r={5} fill={color(s.color)} stroke={css('--panel') || '#fff'} strokeWidth={2} />
              <text x={p[0]} y={p[1] - 9} textAnchor="middle" fontSize="10.5" fontWeight="600" fill={text}>{fmt(p[2])}</text></g>)}</g>; })}
    </>;
    csvRows = [['category', ...data.series.map((s) => `${s.name} (${unit})`)], ...data.cats.map((c, i) => [c, ...data.series.map((s) => s.values[i] ?? '')])];
  } else if (data.kind === 'box') {
    const cw = (W - pl - pr) / Math.max(1, data.series.length), bw = Math.min(46, cw * 0.45);
    body = data.series.map((s, i) => { const cx = pl + i * cw + cw / 2, q1 = quantile(s.values, 0.25), q2 = quantile(s.values, 0.5), q3 = quantile(s.values, 0.75);
      const mn = Math.min(...s.values), mx = Math.max(...s.values), c = color(s.color);
      return <g key={s.name} {...mark([...s.tip, `median ${fmt(q2)} ${unit} · quartiles ${fmt(q1)}–${fmt(q3)} · range ${fmt(mn)}–${fmt(mx)} · n = ${s.values.length}`])}>
        <line x1={cx} x2={cx} y1={y(mx)} y2={y(mn)} stroke={c} strokeWidth={1.5} />
        <line x1={cx - bw / 4} x2={cx + bw / 4} y1={y(mx)} y2={y(mx)} stroke={c} strokeWidth={1.5} /><line x1={cx - bw / 4} x2={cx + bw / 4} y1={y(mn)} y2={y(mn)} stroke={c} strokeWidth={1.5} />
        <rect x={cx - bw / 2} y={y(q3)} width={bw} height={Math.max(1, y(q1) - y(q3))} rx={3} fill={c} fillOpacity={0.22} stroke={c} strokeWidth={1.5} />
        <line x1={cx - bw / 2} x2={cx + bw / 2} y1={y(q2)} y2={y(q2)} stroke={c} strokeWidth={2.5} />
        <text x={cx} y={H - 10} textAnchor="middle" fontSize="11" fill={ink}>{s.name}</text>
        <text x={cx + bw / 2 + 4} y={y(q2) + 4} fontSize="10.5" fontWeight="600" fill={text}>{fmt(q2)}</text></g>; });
    csvRows = [['series', `value (${unit})`], ...data.series.flatMap((s) => s.values.map((v) => [s.name, v]))];
  } else {
    const xs = data.points.map((p) => p.x), xt = ticks(Math.min(0, ...xs), Math.max(...xs, 0) * 1.12 || 1);
    const x = (v: number) => pl + (W - pl - pr) * ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1));
    body = <>
      {xt.map((v) => <text key={`x${v}`} x={x(v)} y={H - 10} textAnchor="middle" fontSize="11" fill={ink}>{fmt(v)}</text>)}
      {data.points.map((p, i) => <g key={i} {...mark(p.tip)}><circle cx={x(p.x)} cy={y(p.y)} r={6} fill={color(p.color)} fillOpacity={0.85} stroke={css('--panel') || '#fff'} strokeWidth={1.5} /></g>)}
      <text x={W - pr} y={H - 22} textAnchor="end" fontSize="10.5" fill={ink}>{data.xLabel} ({data.xUnit})</text></>;
    csvRows = [['series', `${data.xLabel} (${data.xUnit})`, `${title} (${unit})`, 'detail'], ...data.points.map((p) => [p.series, p.x, p.y, p.tip.join(' · ')])];
  }
  const legend = data.kind === 'scatter' ? Array.from(new Map(data.points.map((p) => [p.series, p.color])).entries()) : data.series.map((s) => [s.name, s.color] as [string, string]);
  const csv = () => save(new Blob([csvRows.map((r) => r.map((v) => (typeof v === 'string' && /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n'], { type: 'text/csv' }), `${file}.csv`);
  const svgText = () => new XMLSerializer().serializeToString(svg.current!);
  const png = () => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = W * 2; c.height = H * 2; const g = c.getContext('2d')!;
      g.fillStyle = css('--panel') || '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height); c.toBlob((b) => b && save(b, `${file}.png`), 'image/png'); };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText())}`;
  };
  return <div className="chart-card" onMouseLeave={() => setTip(null)}>
    <div className="row gap"><div className="grow"><h3>{title}</h3><div className="small muted">{subtitle}</div></div>
      <div className="btn-group" role="group" aria-label={`export ${title}`}><button className="btn sm" onClick={csv}>CSV</button><button className="btn sm" onClick={png}>PNG</button>
        <button className="btn sm" onClick={() => save(new Blob([svgText()], { type: 'image/svg+xml' }), `${file}.svg`)}>SVG</button></div></div>
    <div className="lgd">{legend.map(([n, c]) => <span key={n}><i style={{ background: c }} />{n}</span>)}</div>
    <svg ref={svg} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="group" aria-label={title} style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      {tk.map((v) => <g key={v}><line x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} stroke={v === 0 ? axis : grid} />
        <text x={pl - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill={ink}>{fmt(v)}</text></g>)}
      {body}
      <text x={pl} y={11} fontSize="10.5" fill={ink}>{unit}</text>
    </svg>
    {note && <p className="tiny muted chart-note">{note}</p>}
    {tip && <div className="chart-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.lines.map((l, i) => <div key={i} className={i === 0 ? 'strong' : ''}>{l}</div>)}</div>}
  </div>;
}
