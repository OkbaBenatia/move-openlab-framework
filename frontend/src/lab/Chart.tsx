import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { num } from '../components/common';
import { tr } from '../i18n';
import { composeSvg, csvText, type ChartExport, type CsvRows } from './chartExport';
import { saveBlob, svgToPng } from './chartImage';
import { ticks } from './chartScale';

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
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };

/** Width of an element, followed as it changes (layout, window size, browser zoom). */
function useWidth(ref: React.RefObject<HTMLElement | null>, fallback: number, dep: unknown): number {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => { if (ref.current) setW(ref.current.clientWidth || fallback); }, [ref, fallback, dep]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width) || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback, dep]);
  return w;
}
const textW = (s: string, size = 11) => s.length * size * 0.58;          // approximate width of a label (Inter)

/** A chart in the interface's style (resolved colours, Inter, recessive grid), so the exported SVG and PNG look like the
 *  screen. Every mark carries its value; hovering or focusing a mark shows where the number comes from. The plot has a
 *  fixed height and follows the card's width (compact cards of equal size in a grid); Expand shows it larger. */
export const PLOT_HEIGHT = 215;
export function Chart({ title, subtitle, unit, data, fmt = (v) => num(v), file, note, meta, footer, select, register }: {
  title: string; subtitle: string; unit: string; data: ChartData; fmt?: (v: number) => string; file: string; note?: string;
  /** Recorded in the manifest of an exported set (metric, scope, methods…), and the provenance line of the image. */
  meta?: Record<string, unknown>; footer?: string;
  /** Selection for a combined export, and how the chart hands over what it draws (null when it leaves the screen). */
  select?: { checked: boolean; onChange: (on: boolean) => void }; register?: (file: string, get: (() => ChartExport) | null) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; lines: Tip } | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (!big) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setBig(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [big]);
  const W = Math.max(240, useWidth(host, 360, big));
  const H = big ? Math.max(PLOT_HEIGHT, Math.min(560, Math.round(window.innerHeight * 0.6))) : PLOT_HEIGHT;
  const pb = 30, pt = 18, pr = 10;
  const ink = css('--muted') || '#66758a', text = css('--text-2') || '#3d4b5f', grid = css('--grid') || '#e6eaf0', axis = css('--axis') || '#9aa6b5';
  const all = data.kind === 'scatter' ? data.points.map((p) => p.y) : data.kind === 'box' ? data.series.flatMap((s) => s.values) : data.series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all) * 1.12 || 1;
  const tk = ticks(lo < 0 ? lo * 1.12 : 0, hi);
  const y0 = tk[0], y1 = tk[tk.length - 1];
  const pl = Math.ceil(Math.max(30, ...tk.map((v) => textW(fmt(v)))) + 10);   // room for the widest tick label
  const y = (v: number) => pt + (H - pt - pb) * (1 - (v - y0) / (y1 - y0 || 1));
  const show = (e: React.MouseEvent | React.FocusEvent, lines: Tip) => {
    const card = (e.currentTarget as Element).closest('.chart-card')!.getBoundingClientRect();
    const r = (e.currentTarget as Element).getBoundingClientRect();
    setTip({ x: r.left - card.left + r.width / 2, y: r.top - card.top, lines });
  };
  const mark = (lines: Tip | null | undefined) => lines ? { tabIndex: 0, role: 'img', 'aria-label': lines.join(' · '), onMouseEnter: (e: React.MouseEvent) => show(e, lines),
    onMouseLeave: () => setTip(null), onFocus: (e: React.FocusEvent) => show(e, lines), onBlur: () => setTip(null), style: { cursor: 'default', outline: 'none' } } : {};

  let body: React.ReactNode = null, csvRows: CsvRows = [];
  if (data.kind === 'bars' || data.kind === 'line') {
    const cw = (W - pl - pr) / Math.max(1, data.cats.length), n = data.series.length;
    const bw = Math.max(4, Math.min(28, (cw - 14) / Math.max(1, n) - 2));
    // category labels never overlap: every k-th one is written when they would not fit; value labels only when legible
    const every = Math.max(1, Math.ceil(Math.max(...data.cats.map((c) => textW(c))) / Math.max(1, cw - 6)));
    const values = data.kind === 'line' ? cw >= 34 : bw >= 16 && Math.max(...data.series.flatMap((s) => s.values.map((v) => (v == null ? 0 : textW(fmt(v), 10.5))))) <= bw + 14;
    body = <>
      {data.cats.map((c, i) => (i % every === 0 ? <text key={c} x={pl + i * cw + cw / 2} y={H - 10} textAnchor="middle" fontSize="11" fill={ink}>{c}</text> : null))}
      {data.kind === 'bars' ? data.cats.map((c, i) => { const x0 = pl + i * cw + (cw - n * (bw + 2)) / 2;
        return <g key={c}>{data.series.map((s, j) => { const v = s.values[i]; if (v == null) return null; const x = x0 + j * (bw + 2), top = y(Math.max(0, v)), h = Math.abs(y(v) - y(0));
          return <g key={s.name} {...mark(s.tips[i])}><rect x={x} y={top} width={bw} height={Math.max(1, h)} rx={3} fill={color(s.color)} />
            {values && <text x={x + bw / 2} y={v >= 0 ? top - 5 : top + h + 12} textAnchor="middle" fontSize="10.5" fontWeight="600" fill={text}>{fmt(v)}</text>}</g>; })}</g>; })
        : data.series.map((s) => { const pts = s.values.map((v, i) => (v == null ? null : [pl + i * cw + cw / 2, y(v), v, i] as const)).filter((p): p is readonly [number, number, number, number] => !!p);
          return <g key={s.name}><polyline points={pts.map((p) => `${p[0]},${p[1]}`).join(' ')} fill="none" stroke={color(s.color)} strokeWidth={2} />
            {pts.map((p) => <g key={p[3]} {...mark(s.tips[p[3]])}><circle cx={p[0]} cy={p[1]} r={5} fill={color(s.color)} stroke={css('--panel') || '#fff'} strokeWidth={2} />
              {values && <text x={p[0]} y={p[1] - 9} textAnchor="middle" fontSize="10.5" fontWeight="600" fill={text}>{fmt(p[2])}</text>}</g>)}</g>; })}
    </>;
    csvRows = [['category', ...data.series.map((s) => (unit ? `${s.name} (${unit})` : s.name))], ...data.cats.map((c, i) => [c, ...data.series.map((s) => s.values[i] ?? '')])];
  } else if (data.kind === 'box') {
    const cw = (W - pl - pr) / Math.max(1, data.series.length), bw = Math.min(46, cw * 0.45);
    body = data.series.map((s, i) => { const cx = pl + i * cw + cw / 2, q1 = quantile(s.values, 0.25), q2 = quantile(s.values, 0.5), q3 = quantile(s.values, 0.75);
      const mn = Math.min(...s.values), mx = Math.max(...s.values), c = color(s.color);
      return <g key={s.name} {...mark([...s.tip, tr('median {median} {unit} · quartiles {q1}–{q3} · range {min}–{max} · n = {n}', { median: fmt(q2), unit, q1: fmt(q1), q3: fmt(q3), min: fmt(mn), max: fmt(mx), n: s.values.length })])}>
        <line x1={cx} x2={cx} y1={y(mx)} y2={y(mn)} stroke={c} strokeWidth={1.5} />
        <line x1={cx - bw / 4} x2={cx + bw / 4} y1={y(mx)} y2={y(mx)} stroke={c} strokeWidth={1.5} /><line x1={cx - bw / 4} x2={cx + bw / 4} y1={y(mn)} y2={y(mn)} stroke={c} strokeWidth={1.5} />
        <rect x={cx - bw / 2} y={y(q3)} width={bw} height={Math.max(1, y(q1) - y(q3))} rx={3} fill={c} fillOpacity={0.22} stroke={c} strokeWidth={1.5} />
        <line x1={cx - bw / 2} x2={cx + bw / 2} y1={y(q2)} y2={y(q2)} stroke={c} strokeWidth={2.5} />
        <text x={cx} y={H - 10} textAnchor="middle" fontSize="11" fill={ink}>{s.name}</text>
        <text x={cx + bw / 2 + 4} y={y(q2) + 4} fontSize="10.5" fontWeight="600" fill={text}>{fmt(q2)}</text></g>; });
    csvRows = [['series', unit ? `value (${unit})` : 'value'], ...data.series.flatMap((s) => s.values.map((v) => [s.name, v]))];
  } else {
    const xs = data.points.map((p) => p.x), xt0 = ticks(Math.min(0, ...xs), Math.max(...xs, 0) * 1.12 || 1);
    const xstep = Math.max(1, Math.ceil((xt0.length * Math.max(...xt0.map((v) => textW(fmt(v)))) + 12 * xt0.length) / Math.max(1, W - pl - pr)));
    const xt = xt0.filter((_, i) => i % xstep === 0 || i === xt0.length - 1);
    const x = (v: number) => pl + (W - pl - pr) * ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1));
    body = <>
      {xt.map((v) => <text key={`x${v}`} x={x(v)} y={H - 10} textAnchor="middle" fontSize="11" fill={ink}>{fmt(v)}</text>)}
      {data.points.map((p, i) => <g key={i} {...mark(p.tip)}><circle cx={x(p.x)} cy={y(p.y)} r={6} fill={color(p.color)} fillOpacity={0.85} stroke={css('--panel') || '#fff'} strokeWidth={1.5} /></g>)}
      <text x={W - pr} y={H - 22} textAnchor="end" fontSize="10.5" fill={ink}>{data.xLabel} ({data.xUnit})</text></>;
    csvRows = [['series', `${data.xLabel} (${data.xUnit})`, unit ? `${title} (${unit})` : title, 'detail'], ...data.points.map((p) => [p.series, p.x, p.y, p.tip.join(' · ')])];
  }
  const legend = data.kind === 'scatter' ? Array.from(new Map(data.points.map((p) => [p.series, p.color])).entries()) : data.series.map((s) => [s.name, s.color] as [string, string]);
  const drawnKind = data.kind === 'bars' ? (data.cats.length > 1 ? 'grouped' : 'bar') : data.kind;
  // what is exported is what is drawn: the plot on screen, with its title, legend and provenance around it
  const exported = (): ChartExport => {
    const c = composeSvg({ plot: new XMLSerializer().serializeToString(svg.current!), width: W, height: H, title, subtitle, legend: legend.map(([n, col]) => [n, color(col)]), note, footer,
      background: css('--panel') || '#ffffff', text: css('--text') || '#1c2733', muted: ink });
    return { file, title, subtitle, unit, kind: drawnKind, legend: legend.map(([n, col]) => [n, color(col)]), csv: csvRows, note, meta, ...c };
  };
  const exportedRef = useRef(exported);
  exportedRef.current = exported;
  useEffect(() => { register?.(file, () => exportedRef.current()); return () => register?.(file, null); }, [register, file]);
  const csv = () => saveBlob(new Blob([csvText(csvRows)], { type: 'text/csv' }), `${file}.csv`);
  const png = () => { const e = exported(); svgToPng(e.svg, e.width, e.height).then((b) => saveBlob(b, `${file}.png`)).catch(() => { /* the browser could not draw it */ }); };
  const card = <div className={`chart-card${big ? ' big' : ''}`} onMouseLeave={() => setTip(null)} role={big ? 'dialog' : undefined} aria-label={big ? title : undefined}>
    <div className="row gap chart-head">{select && !big && <input type="checkbox" className="chart-pick" checked={select.checked} onChange={(e) => select.onChange(e.target.checked)} aria-label={tr('select {title} for export', { title })} title={tr('Select this chart for a combined export')} />}
      <div className="grow chart-titles"><h3 title={title}>{title}</h3><div className="small muted" title={subtitle}>{subtitle}</div></div>
      <div className="btn-group" role="group" aria-label={tr('export {title}', { title })}><button className="btn sm" onClick={csv} title={tr('The data of this chart')}>CSV</button><button className="btn sm" onClick={png} title={tr('This chart as an image, with its title and legend')}>PNG</button>
        <button className="btn sm" onClick={() => saveBlob(new Blob([exported().svg], { type: 'image/svg+xml' }), `${file}.svg`)} title={tr('This chart as a vector image, with its title and legend')}>SVG</button>
        <button className="btn sm icon" aria-label={big ? tr('close the enlarged chart') : tr('enlarge the chart')} title={big ? tr('Back to the grid (Esc)') : tr('Enlarge')} onClick={() => setBig(!big)}>{big ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button></div></div>
    <div className="lgd">{legend.map(([n, c]) => <span key={n} title={n}><i style={{ background: c }} />{n}</span>)}</div>
    <div ref={host} className="chart-plot" data-chart={file} data-kind={drawnKind}>
    <svg ref={svg} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="group" aria-label={title} style={{ fontFamily: 'Inter, system-ui, sans-serif', display: 'block' }}>
      {tk.map((v) => <g key={v}><line x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} stroke={v === 0 ? axis : grid} />
        <text x={pl - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill={ink}>{fmt(v)}</text></g>)}
      {body}
      <text x={pl} y={11} fontSize="10.5" fill={ink}>{unit}</text>
    </svg></div>
    {note && <p className="tiny muted chart-note">{note}</p>}
    {tip && <div className="chart-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.lines.map((l, i) => <div key={i} className={i === 0 ? 'strong' : ''}>{l}</div>)}</div>}
  </div>;
  return big ? <><div className="chart-card chart-placeholder" aria-hidden="true" /><div className="overlay chart-overlay" onClick={() => setBig(false)}><div onClick={(e) => e.stopPropagation()}>{card}</div></div></> : card;
}
