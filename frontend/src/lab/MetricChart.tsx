import { useRef } from 'react';
import { num } from '../components/common';

export interface Series { name: string; color: string; values: (number | null)[] }

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function save(blob: Blob, name: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Grouped bars (one group per category, one bar per series) drawn as plain SVG with resolved colours, so the exported
 *  SVG and PNG look like the screen. Every bar carries its value; the legend names the series; CSV gives the numbers. */
export function MetricChart({ title, subtitle, unit, cats, series, fmt = (v) => num(v), file }: {
  title: string; subtitle: string; unit: string; cats: string[]; series: Series[]; fmt?: (v: number) => string; file: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const W = 470, H = 210, pl = 44, pb = 28, pt = 18, pr = 8;
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const max = Math.max(1e-9, ...vals) * 1.15;
  const step = (() => { const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw) ?? raw; })();
  const top = step * 4;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / top);
  const cw = (W - pl - pr) / Math.max(1, cats.length), bw = Math.max(6, Math.min(26, (cw - 24) / Math.max(1, series.length) - 2));
  const ink = css('--muted') || '#66758a', text = css('--text-2') || '#3d4b5f', grid = css('--grid') || '#e6eaf0', axis = css('--axis') || '#9aa6b5';
  const color = (c: string) => (c.startsWith('var(') ? css(c.slice(4, -1)) : c);
  const csv = () => save(new Blob([[['scenario', ...series.map((s) => `${s.name} (${unit})`)].join(','),
    ...cats.map((c, i) => [c, ...series.map((s) => s.values[i] ?? '')].join(','))].join('\n') + '\n'], { type: 'text/csv' }), `${file}.csv`);
  const svgText = () => new XMLSerializer().serializeToString(svg.current!);
  const svgOut = () => save(new Blob([svgText()], { type: 'image/svg+xml' }), `${file}.svg`);
  const png = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = W * 2; c.height = H * 2;
      const g = c.getContext('2d')!; g.fillStyle = css('--panel') || '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => b && save(b, `${file}.png`), 'image/png');
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText())}`;
  };
  return <div className="chart-card">
    <div className="row gap"><div className="grow"><h3>{title}</h3><div className="small muted">{subtitle}</div></div>
      <div className="btn-group" role="group" aria-label={`export ${title}`}><button className="btn sm" onClick={csv}>CSV</button><button className="btn sm" onClick={png}>PNG</button><button className="btn sm" onClick={svgOut}>SVG</button></div></div>
    <div className="lgd">{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>
    <svg ref={svg} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={title} style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      {[0, 1, 2, 3, 4].map((k) => <g key={k}><line x1={pl} x2={W - pr} y1={y(step * k)} y2={y(step * k)} stroke={grid} />
        <text x={pl - 6} y={y(step * k) + 4} textAnchor="end" fontSize="11" fill={ink}>{fmt(step * k)}</text></g>)}
      {cats.map((c, i) => { const x0 = pl + i * cw + (cw - series.length * (bw + 2)) / 2;
        return <g key={c}>{series.map((s, j) => { const v = s.values[i]; if (v == null) return null; const x = x0 + j * (bw + 2), yy = y(v), h = Math.max(0, H - pb - yy);
          return <g key={s.name}><rect x={x} y={yy} width={bw} height={h} rx={3} fill={color(s.color)} /><text x={x + bw / 2} y={yy - 5} textAnchor="middle" fontSize="10.5" fontWeight="600" fill={text}>{fmt(v)}</text></g>; })}
          <text x={pl + i * cw + cw / 2} y={H - 9} textAnchor="middle" fontSize="11" fill={ink}>{c}</text></g>; })}
      <line x1={pl} x2={W - pr} y1={H - pb} y2={H - pb} stroke={axis} />
      <text x={pl} y={11} fontSize="10.5" fill={ink}>{unit}</text>
    </svg>
  </div>;
}
