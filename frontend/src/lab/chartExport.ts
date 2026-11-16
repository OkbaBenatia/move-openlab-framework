/** Export of charts, as plain functions (no interface code, so they are unit-tested): the standalone image of one chart
 *  — its title, what it is computed over, its legend, the plot as drawn, and where the numbers come from —, the CSV of
 *  its data, the manifest of a set of charts, and a ZIP archive holding them. Nothing here computes a result: every
 *  number comes from the chart that is on screen. */

export type CsvRows = (string | number | null)[][];
export interface ChartExport {
  /** File name without extension (unique in a set of charts). */
  file: string; title: string; subtitle: string; unit: string;
  /** bar | grouped | line | box | scatter, as drawn. */
  kind: string;
  legend: [name: string, colour: string][];
  csv: CsvRows;
  /** The standalone SVG document and its size in CSS pixels. */
  svg: string; width: number; height: number;
  note?: string;
  /** What the manifest records about the chart beyond its title (metric id, scenario scope, method labels…). */
  meta?: Record<string, unknown>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Approximate width of a text in pixels (Inter): enough to wrap a legend and to cut a line that would overflow. */
export const textWidth = (s: string, size = 11) => s.length * size * 0.58;
const fit = (s: string, width: number, size: number) => { const max = Math.max(4, Math.floor(width / (size * 0.58))); return s.length <= max ? s : `${s.slice(0, max - 1)}…`; };

export const csvText = (rows: CsvRows): string => rows.map((r) => r.map((v) => (v == null ? '' : typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v))).join(',')).join('\n') + '\n';

/** One self-contained SVG: title, subtitle, legend (wrapped), the plot exactly as drawn (nested, unscaled), then the note
 *  and a provenance line. `plot` is the serialised `<svg>` of the plot with its own width, height and viewBox. */
export function composeSvg(o: { plot: string; width: number; height: number; title: string; subtitle: string; legend: [string, string][]; note?: string; footer?: string;
  background?: string; text?: string; muted?: string }): { svg: string; width: number; height: number } {
  const pad = 14, W = Math.max(280, Math.round(o.width) + 2 * pad), inner = W - 2 * pad;
  const text = o.text ?? '#1c2733', muted = o.muted ?? '#66758a', bg = o.background ?? '#ffffff';
  let y = pad + 14;
  const out: string[] = [`<text x="${pad}" y="${y}" font-size="14" font-weight="700" fill="${text}">${esc(fit(o.title, inner, 14))}</text>`];
  if (o.subtitle) { y += 16; out.push(`<text x="${pad}" y="${y}" font-size="11" fill="${muted}">${esc(fit(o.subtitle, inner, 11))}</text>`); }
  // legend: swatch + name, wrapped onto as many rows as needed (a name longer than the image is cut with an ellipsis)
  y += 8;
  let x = pad, row = 0;
  for (const [name, colour] of o.legend) {
    const label = fit(name, inner - 18, 11), w = 18 + textWidth(label) + 14;
    if (x > pad && x + w > pad + inner) { x = pad; row += 1; }
    const ly = y + 12 + row * 16;
    out.push(`<rect x="${x}" y="${ly - 9}" width="10" height="10" rx="2" fill="${esc(colour)}"/><text x="${x + 15}" y="${ly}" font-size="11" fill="${text}">${esc(label)}</text>`);
    x += w;
  }
  if (o.legend.length) y += 16 * (row + 1) + 4;
  const top = y + 4;
  // the plot keeps its own coordinate system: it is placed, never rescaled or redrawn
  const plot = o.plot.replace(/^<svg\b/, `<svg x="${pad}" y="${top}"`);
  y = top + Math.round(o.height);
  for (const line of [o.note, o.footer]) if (line) { y += 15; out.push(`<text x="${pad}" y="${y}" font-size="10" fill="${muted}">${esc(fit(line, inner, 10))}</text>`); }
  const H = y + pad;
  return { width: W, height: H, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, system-ui, sans-serif"><rect width="${W}" height="${H}" fill="${bg}"/>${out.join('')}${plot}</svg>` };
}

/** What a set of exported charts is, for whoever opens the archive later: one entry per chart with its files, title,
 *  metric, unit, type, scope and series, and the provenance of the compared results. */
export function manifest(charts: ChartExport[], provenance: Record<string, unknown>, exportedAt: string): Record<string, unknown> {
  return { format: 'move-openlab/chart-export@1', exported_at: exportedAt, ...provenance,
    charts: charts.map((c) => ({ title: c.title, computed_over: c.subtitle, unit: c.unit, chart_type: c.kind, series: c.legend.map(([n]) => n), ...(c.meta ?? {}), ...(c.note ? { note: c.note } : {}),
      image_size_px: { width: c.width, height: c.height }, data_rows: Math.max(0, c.csv.length - 1),
      files: { png: `charts/${c.file}.png`, svg: `charts/${c.file}.svg`, csv: `charts/${c.file}.csv` } })) };
}

// ---------------------------------------------------------------- ZIP (stored entries; no dependency)
let table: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!table) { table = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A ZIP archive of the given files, stored without compression (PNG is compressed already; the rest is small). File
 *  names are UTF-8. Readable by every unzip tool. */
export function zip(files: { name: string; data: Uint8Array }[], when: Date = new Date()): Uint8Array {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8(f.name), crc = crc32(f.data), n = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true); local.setUint32(18, n, true); local.setUint32(22, n, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true); cd.setUint16(14, date, true); cd.setUint32(16, crc, true); cd.setUint32(20, n, true); cd.setUint32(24, n, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), name, f.data);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + n;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const c of [...chunks, ...central, new Uint8Array(end.buffer)]) { out.set(c, p); p += c.length; }
  return out;
}

/** The names stored in a ZIP made by `zip` (used by the tests, and to say what an archive holds). */
export function zipNames(archive: Uint8Array): string[] {
  const v = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  if (end < 0 || v.getUint32(end, true) !== 0x06054b50) return [];
  const n = v.getUint16(end + 10, true); let p = v.getUint32(end + 16, true); const names: string[] = [];
  for (let i = 0; i < n; i += 1) { const len = v.getUint16(p + 28, true); names.push(new TextDecoder().decode(archive.subarray(p + 46, p + 46 + len))); p += 46 + len + v.getUint16(p + 30, true) + v.getUint16(p + 32, true); }
  return names;
}

/** The selection of charts to export, restricted to the charts that exist now (a chart that left the screen is dropped). */
export const selectedCharts = (selected: Set<string>, available: string[]): string[] => available.filter((id) => selected.has(id));
