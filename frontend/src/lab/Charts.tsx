import { useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { Metric } from '../api/client';
import { domainValue, sameEmissionSemantics } from '../mobility/api';
import type { ResultRow } from './api';

/** A metric that can be charted for every row of a comparison. Only metrics with a value for at least one row are
 *  offered: unsupported metrics are never shown. Emission figures are offered only when every row that has them
 *  shares one scope, baseline and CO2/CO2e basis. */
export interface ChartMetric { id: string; label: string; unit: string; better: string | null; group: string; get: (r: ResultRow) => number | null }
export type DomainMetric = { id: string; label: string; unit: string; better: string | null };

export function chartMetrics(metrics: Metric[], rows: ResultRow[], domain: DomainMetric[] = []): ChartMetric[] {
  const emissions = sameEmissionSemantics(rows.map((r) => r.domain)) && rows.every((r) => !r.domain || r.domain.complete);
  const all: ChartMetric[] = [
    ...metrics.map((m) => ({ id: m.id, label: m.label, unit: m.unit, better: m.better, group: 'Objective', get: (r: ResultRow) => r.totals[m.id] ?? null })),
    ...(rows[0]?.descriptive ?? []).map((d) => ({ id: d.id, label: d.label, unit: d.unit, better: d.better, group: 'Mobility', get: (r: ResultRow) => r.descriptive.find((x) => x.id === d.id)?.value ?? null })),
    ...(emissions ? domain.map((d) => ({ id: `domain:${d.id}`, label: d.unit === '%' ? `${d.label} (%)` : d.label, unit: d.unit, better: d.better, group: 'Emissions', get: (r: ResultRow) => domainValue(r.domain, d.id) })) : []),
    { id: 'gap_pct', label: 'Gap to the exact reference', unit: '%', better: 'lower', group: 'Quality', get: (r) => r.gap_pct },
    { id: 'total_time_s', label: 'Median total time', unit: 's', better: 'lower', group: 'Runtime', get: (r) => r.total_time_s },
    { id: 'solver_time_s', label: 'Median solver time', unit: 's', better: 'lower', group: 'Runtime', get: (r) => r.solver_time_s },
  ];
  return all.filter((m) => rows.some((r) => typeof m.get(r) === 'number'));
}

const ORIGIN_SHORT: Record<string, string> = { baseline: 'original', variant: 'original', reproduction: 're-run', extended: 'added' };
export const rowLabel = (r: ResultRow, rows: ResultRow[]) =>
  rows.filter((x) => x.method_id === r.method_id).length > 1 ? `${r.name} (${ORIGIN_SHORT[r.campaign_kind] ?? r.campaign_kind})` : r.name;

const fmt = (v: number, unit: string) => (unit === 's' ? (v < 1 ? `${(v * 1000).toFixed(1)} ms` : v < 120 ? `${v.toFixed(2)} s` : `${(v / 60).toFixed(1)} min`)
  : unit === 'g' ? (Math.abs(v) < 1000 ? `${Math.round(v)} g` : `${(v / 1000).toFixed(1)} kg`)
  : `${Number.isInteger(v) ? v : v.toFixed(1)}${unit === '%' ? ' %' : unit === 'km' || unit === 'g/km' ? ` ${unit}` : ''}`);

function cssVar(name: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }

/** Horizontal bar chart of one metric across methods (hand-written SVG, no chart library) with CSV, SVG and PNG export. */
export function Charts({ metrics, rows, title, domain = [] }: { metrics: Metric[]; rows: ResultRow[]; title: string; domain?: DomainMetric[] }) {
  const options = useMemo(() => chartMetrics(metrics, rows, domain), [metrics, rows, domain]);
  const [mid, setMid] = useState(options[0]?.id ?? '');
  const svg = useRef<SVGSVGElement>(null);
  const m = options.find((o) => o.id === mid) ?? options[0];
  if (!m) return <p className="muted small">No metric to chart yet.</p>;
  const data = rows.map((r) => ({ label: rowLabel(r, rows), value: m.get(r) }));
  const max = Math.max(...data.map((d) => d.value ?? 0), 0) || 1;
  const W = 560, LW = 190, BH = 22, GAP = 10, TOP = 8, H = TOP + data.length * (BH + GAP) + 20;
  const x = (v: number) => (v / max) * (W - LW - 90);
  const groups = Array.from(new Set(options.map((o) => o.group)));
  const name = `${title} — ${m.label}`.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').toLowerCase();

  const serialise = () => {
    const el = svg.current!.cloneNode(true) as SVGSVGElement;
    el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    el.querySelectorAll('[data-fill]').forEach((n) => n.setAttribute('fill', cssVar(n.getAttribute('data-fill')!)));
    el.querySelectorAll('[data-stroke]').forEach((n) => n.setAttribute('stroke', cssVar(n.getAttribute('data-stroke')!)));
    return new XMLSerializer().serializeToString(el);
  };
  const save = (blob: Blob, ext: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}.${ext}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
  const csv = () => save(new Blob([`method,${m.label} (${m.unit || 'value'})\n` + data.map((d) => `"${d.label.replace(/"/g, '""')}",${d.value ?? ''}`).join('\n') + '\n'], { type: 'text/csv' }), 'csv');
  const png = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = W * 3; c.height = H * 3;
      const g = c.getContext('2d')!; g.fillStyle = cssVar('--panel'); g.fillRect(0, 0, c.width, c.height); g.scale(3, 3); g.drawImage(img, 0, 0, W, H);
      c.toBlob((b) => b && save(b, 'png'));
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialise());
  };
  return <div className="chart-panel">
    <div className="row gap">
      <label className="row small">Metric <select aria-label="chart metric" value={m.id} onChange={(e) => setMid(e.target.value)}>
        {groups.map((g) => <optgroup key={g} label={g}>{options.filter((o) => o.group === g).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</optgroup>)}</select></label>
      {m.better && <span className="small muted">{m.better} is better</span>}
      <span className="grow" />
      <button className="btn sm" onClick={csv}><Download size={12} /> CSV</button>
      <button className="btn sm" onClick={() => save(new Blob([serialise()], { type: 'image/svg+xml' }), 'svg')}><Download size={12} /> SVG</button>
      <button className="btn sm" onClick={png}><Download size={12} /> PNG</button>
    </div>
    <div className="chart"><svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${m.label} by method`} fontFamily="system-ui, sans-serif">
      <line x1={LW} x2={LW} y1={TOP - 4} y2={H - 16} data-stroke="--line" stroke="var(--line)" />
      {data.map((d, i) => { const y = TOP + i * (BH + GAP); const w = d.value == null ? 0 : Math.max(6, x(d.value));
        return <g key={d.label}>
          <title>{`${d.label}: ${d.value == null ? 'not available' : fmt(d.value, m.unit)}`}</title>
          <text x={LW - 8} y={y + BH / 2 + 4} textAnchor="end" fontSize="12" data-fill="--text" fill="var(--text)">{d.label.length > 30 ? d.label.slice(0, 29) + '…' : d.label}</text>
          {d.value != null && <path d={`M${LW},${y} h${w - 4} q4,0 4,4 v${BH - 8} q0,4 -4,4 h${-(w - 4)} z`} data-fill="--accent" fill="var(--accent)" />}
          <text x={LW + w + 6} y={y + BH / 2 + 4} fontSize="12" data-fill="--muted" fill="var(--muted)">{d.value == null ? 'n/a' : fmt(d.value, m.unit)}</text>
        </g>; })}
      <text x={LW} y={H - 3} fontSize="10" data-fill="--muted" fill="var(--muted)">{m.label}{m.unit ? ` (${m.unit})` : ''}</text>
    </svg></div>
  </div>;
}
