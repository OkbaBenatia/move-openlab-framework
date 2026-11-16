// Chart export: the standalone image, the CSV, the manifest and the ZIP archive of a selection. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSvg, crc32, csvText, manifest, selectedCharts, utf8, zip, zipNames, type ChartExport } from '../src/lab/chartExport.ts';

const PLOT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 215" width="360" height="215"><rect x="40" y="20" width="24" height="150" fill="#2f6fde"/><text x="52" y="14">15</text></svg>';

test('the exported image holds the plot as drawn, with its title, what it is computed over, its legend and provenance', () => {
  const c = composeSvg({ plot: PLOT, width: 360, height: 215, title: 'Served riders', subtitle: 'Exact matching · sum over 3 scenarios', legend: [['A · Exact matching MILP', '#2f6fde'], ['B · Greedy <fast>', '#00887f']],
    note: 'B: comparable with conditions', footer: 'MOVE OpenLab · A: Montbéliard Demo — Baseline' });
  assert.ok(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+"/.test(c.svg));
  for (const part of ['Served riders', 'sum over 3 scenarios', 'A · Exact matching MILP', 'B · Greedy &lt;fast&gt;', 'comparable with conditions', 'Montbéliard Demo']) assert.ok(c.svg.includes(part), part);
  assert.ok(c.svg.includes('<rect x="40" y="20" width="24" height="150" fill="#2f6fde"/>'), 'the marks of the plot are in the image');
  assert.ok(c.width >= 360 && c.height > 215 + 40, `image ${c.width}×${c.height} is larger than the plot: room for title and legend`);
  assert.equal((c.svg.match(/<svg\b/g) ?? []).length, 2);                    // the document and the nested plot, nothing else
});

test('a long legend wraps instead of leaving the image', () => {
  const legend = Array.from({ length: 8 }, (_, i) => [`${String.fromCharCode(65 + i)} · A method with a rather long name`, '#888'] as [string, string]);
  const one = composeSvg({ plot: PLOT, width: 360, height: 215, title: 't', subtitle: '', legend: legend.slice(0, 1) });
  const many = composeSvg({ plot: PLOT, width: 360, height: 215, title: 't', subtitle: '', legend });
  assert.ok(many.height > one.height + 16 * 3, 'more rows for more series');
  for (const m of many.svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="10"/g)) assert.ok(Number(m[1]) < many.width - 20, 'every legend swatch is inside the image');
});

test('CSV: quoted where needed, an absent value is empty and never zero', () => {
  assert.equal(csvText([['category', 'A (kg)', 'B (kg)'], ['All 3 scenarios', 62.4, null], ['says "x", y', 0, 1]]), 'category,A (kg),B (kg)\nAll 3 scenarios,62.4,\n"says ""x"", y",0,1\n');
});

const chart = (file: string): ChartExport => ({ file, title: 'CO₂e emissions', subtitle: 'sum over 3 scenarios', unit: 'kg', kind: 'bar', legend: [['A · Exact', '#2f6fde']], csv: [['category', 'A (kg)'], ['All', 62.4]],
  svg: '<svg/>', width: 388, height: 300, meta: { metric_id: 'co2', metric: 'CO₂e emissions', scenario_scope: 'all 3 scenarios', methods: ['Exact matching MILP'] } });

test('the manifest names, for every chart, its title, metric, unit, type, scope, methods and files, with the provenance', () => {
  const m = manifest([chart('co2_bar'), chart('served_grouped')], { application: 'MOVE OpenLab', compared: [{ label: 'A', campaign_id: 'c-1' }] }, '2026-11-16T10:00:00.000Z') as { charts: Record<string, unknown>[]; compared: unknown[]; format: string };
  assert.equal(m.format, 'move-openlab/chart-export@1');
  assert.equal(m.compared.length, 1);
  assert.equal(m.charts.length, 2);
  assert.deepEqual(m.charts[0].files, { png: 'charts/co2_bar.png', svg: 'charts/co2_bar.svg', csv: 'charts/co2_bar.csv' });
  for (const k of ['title', 'unit', 'chart_type', 'series', 'metric_id', 'metric', 'scenario_scope', 'methods', 'computed_over', 'image_size_px', 'data_rows']) assert.ok(k in m.charts[0], k);
});

test('only the charts that are on screen are exported, in their order', () => {
  assert.deepEqual(selectedCharts(new Set(['c', 'a', 'gone']), ['a', 'b', 'c']), ['a', 'c']);
  assert.deepEqual(selectedCharts(new Set(), ['a', 'b']), []);
});

test('CRC-32 and the ZIP archive: every file is stored under its name and can be read back', () => {
  assert.equal(crc32(utf8('123456789')), 0xcbf43926);
  const files = [{ name: 'charts/co2_bar.csv', data: utf8('category,A (kg)\nAll,62.4\n') }, { name: 'charts/é_bar.svg', data: utf8('<svg/>') }, { name: 'manifest.json', data: utf8('{}') }];
  const z = zip(files, new Date(2026, 10, 16, 10, 0, 0));
  assert.deepEqual(zipNames(z), files.map((f) => f.name));
  assert.equal(new DataView(z.buffer).getUint32(0, true), 0x04034b50);        // local file header
  const text = new TextDecoder().decode(z);
  assert.ok(text.includes('All,62.4') && text.includes('<svg/>'), 'stored, not transformed');
  assert.equal(zip([]).length, 22);                                           // an empty archive is still a valid one
});
