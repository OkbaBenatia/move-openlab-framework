#!/usr/bin/env node
// Browser checks of the result views, on synthetic and public data only (the data directory made by seed_ci.py):
//
//   MOVE_OPENLAB_DATA_DIR=<empty dir> python scripts/e2e/seed_ci.py
//   MOVE_OPENLAB_DATA_DIR=<same dir> MOVE_OPENLAB_PORT=8791 MOVE_OPENLAB_TILE_URL=none ./start-local.sh
//   node scripts/e2e/final_corrections.mjs --base http://127.0.0.1:8791 --creds <dir>/dev-credentials.json --out <out dir>
//
// Checks: an administrator and a researcher see the same results and CO₂ summary for the same public demonstration;
// the administrator of a public installation is an ordinary administrator (no restricted section); "Choose metrics"
// (one selection for the Workspace results, Compare › Methods, Compare › Experiments and the charts): checkboxes,
// select all, deselect all, reset to defaults, kept for the account or for the tab; every chart type; chart selection and
// the combined export — the ZIP is opened and its PNG, SVG, CSV and manifest are verified (real images, not blank); the
// two kinds of comparison; the public synthetic benchmark; French and English.
// Real mouse and keyboard events in headless Chromium. Passwords come from the credentials file and are never printed.
// Writes final-corrections.json (per check: expected, actual, PASS/FAIL, evidence) and screenshots. Exit 1 on a failure.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8791'), OUT = arg('out'), CREDS = arg('creds');
const ADMIN = 'administrator1', RES = 'researcher1';
if (!OUT || !CREDS) { console.error('usage: final_corrections.mjs --base URL --creds FILE --out DIR'); process.exit(2); }
const chrome = process.env.CHROME ?? (() => {
  const root = join(homedir(), '.cache/ms-playwright');
  const dir = existsSync(root) && readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().at(-1);
  return dir ? join(root, dir, 'chrome-linux64/chrome') : 'chromium';
})();
const SHOTS = join(OUT, 'screenshots'), DL = join(OUT, 'downloads');
mkdirSync(SHOTS, { recursive: true }); mkdirSync(DL, { recursive: true });
const creds = JSON.parse(readFileSync(CREDS, 'utf8'));
const pw = (u) => (typeof creds[u] === 'string' ? creds[u] : creds[u]?.password);
const report = { base: BASE, started: new Date().toISOString(), checks: [] };
let n = 0, p;
const shot = async (name, settle = 700) => { await sleep(settle); const f = `${String(++n).padStart(2, '0')}-${name}.png`; await p.shot(join(SHOTS, f)); return f; };
const check = (id, expected, cond, actual, evidence) => { report.checks.push({ id, expected, actual: String(actual).slice(0, 600), status: cond ? 'PASS' : 'FAIL', evidence }); console.log(cond ? 'PASS' : 'FAIL', '·', id, '·', String(actual).slice(0, 200)); };
const text = (css = 'body') => p.eval(`(document.querySelector(${JSON.stringify(css)})?.innerText ?? '')`);
const flat = async (css) => (await text(css)).replace(/\s*\n+\s*/g, ' | ');
const api = (path) => p.eval(`fetch(${JSON.stringify(path)}, { credentials: 'same-origin' }).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }))`);
const goHash = async (h, settle = 3500) => { await p.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(settle); };
const waitWorkspace = () => p.waitFor('!!document.querySelector(".lab-grid") && !/Loading the demonstration/.test(document.querySelector(".lab-notes")?.innerText ?? "")', 90000, 'workspace');
async function signIn(user) {
  if (p) await p.close();
  p = await launch(chrome, { width: 1440, height: 900 }); await p.size(1440, 900, 1); await p.allowDownloads(DL);
  await p.goto(`${BASE}/login`);
  await p.focusCss('input[name=username]'); await p.type(user);
  await p.focusCss('input[name=password]'); await p.type(pw(user));
  await p.click('Sign in', 'button');
  await p.waitFor('location.pathname === "/" && !!document.querySelector(".hdr")', 30000, `sign-in of ${user}`);
  await waitWorkspace(); await sleep(2500);
}
// the script is repeatable: a metric choice kept for the account by an earlier run is cleared (an empty list = defaults)
const resetMetrics = async (reload = true) => { await clearMetrics(); if (reload) { await p.goto(`${BASE}/`); await waitWorkspace(); await sleep(2500); } };
const clearMetrics = () => p.eval(`fetch('/api/lab/state', { credentials: 'same-origin' }).then((r) => r.json()).then((s) => fetch('/api/lab/preferences', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ metrics: Object.fromEntries(Object.keys(s.preferences.metrics ?? {}).map((k) => [k, []])) }) })).then((r) => r.status)`);
const demoIds = async () => { const e = (await api('/api/lab/experiments')).body.experiments; return { base: e.find((x) => x.demo && x.kind === 'baseline')?.campaign_id, variant: e.find((x) => x.demo && x.kind === 'variant')?.campaign_id }; };
const noTime = (s) => s.replace(/[\d.,]+\s*(ms|s)\b/g, '<t>');                 // runtimes are measured per execution
const headers = () => p.eval(`[...document.querySelectorAll('table.results thead th')].map((x) => x.innerText.trim()).filter(Boolean)`);
const openChooser = async (scope = '.lab-right') => { await p.click('Choose metrics', `${scope} button`); await p.waitFor('!!document.querySelector(".metric-chooser")', 8000, 'Choose metrics dialog'); await sleep(300); };
const tick = (label, on) => p.eval(`(() => { const b = [...document.querySelectorAll('.metric-chooser .metric-choice input')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return 'missing'; if (b.checked !== ${on}) b.click(); return b.checked; })()`);
const chooserBtn = async (label) => { await p.click(label, '.metric-chooser button', true); await sleep(250); };
const ticked = () => p.eval(`[...document.querySelectorAll('.metric-chooser .metric-choice input')].filter((x) => x.checked).map((x) => x.getAttribute('aria-label'))`);
const apply = async () => { await p.click('Apply', '.metric-chooser button', true); await p.waitFor('!document.querySelector(".metric-chooser")', 8000, 'dialog closed'); await sleep(900); };
const remember = (on) => p.eval(`(() => { const b = document.querySelector('.metric-chooser .remember input'); if (b.checked !== ${on}) b.click(); return b.checked; })()`);

// ---- archive readers (no dependency): a stored ZIP, a PNG header and its pixel data
function unzip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), end = buf.length - 22;
  if (v.getUint32(end, true) !== 0x06054b50) throw new Error('not a ZIP archive');
  const files = {}; let q = v.getUint32(end + 16, true);
  for (let i = 0; i < v.getUint16(end + 10, true); i++) {
    const len = v.getUint16(q + 28, true), size = v.getUint32(q + 24, true), off = v.getUint32(q + 42, true), method = v.getUint16(q + 10, true);
    const name = new TextDecoder().decode(buf.subarray(q + 46, q + 46 + len));
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    if (method !== 0) throw new Error(`unexpected compression in ${name}`);
    files[name] = buf.subarray(start, start + size);
    q += 46 + len + v.getUint16(q + 30, true) + v.getUint16(q + 32, true);
  }
  return files;
}
function png(b) {
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20), channels = { 2: 3, 6: 4, 0: 1, 4: 2 }[b[25]] ?? 4;
  const idat = []; let q = 8;
  while (q < b.length) { const len = b.readUInt32BE(q), type = b.toString('latin1', q + 4, q + 8); if (type === 'IDAT') idat.push(b.subarray(q + 8, q + 8 + len)); q += 12 + len; }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels + 1;
  // how much of the image is drawn: rows whose bytes are not all one value (a blank canvas has none)
  let rows = 0; const seen = new Set();
  for (let y = 0; y < height; y++) { const row = raw.subarray(y * stride + 1, (y + 1) * stride); let varied = false; for (let x = channels; x < row.length; x++) if (row[x] !== row[x - channels]) { varied = true; break; } if (varied) rows += 1; for (let x = 0; x < row.length; x += 97) seen.add(row[x]); }
  return { width, height, drawnRows: rows, distinct: seen.size };
}

try {
  // ================================================================ 1 · the same public experiment, two roles
  await signIn(ADMIN); await resetMetrics();
  const hdrAdmin = await flat('.hdr');
  check('admin-ordinary', 'On a public installation the administrator has the public application: Workspace and Library, no restricted section.',
    /Workspace/.test(hdrAdmin) && /Library/.test(hdrAdmin) && !/Private Research/.test(hdrAdmin) && !(await p.eval('!!document.querySelector(".ctx-bar")')), hdrAdmin.slice(0, 140));
  const info = (await api('/api/info')).body, studies = (await api('/api/lab/studies')).body;
  check('admin-no-restricted', 'The server lists no restricted problem and no study for the administrator.', info.problems.every((x) => !x.restricted) && studies.studies.length === 0, `${info.problems.length} problems, ${studies.studies.length} studies`);
  const a = await demoIds();
  await goHash(`#/workspace/${a.base}`, 6000);
  const co2A = await flat('section.co2'), resA = await flat('table.results');
  check('admin-co2-card', 'The Montbéliard demonstration shows its CO₂ summary in the Workspace for the administrator: avoided CO₂ against everyone driving alone.',
    /−\s*[\d.,]+\s*(kg|g)/.test(co2A) && /everyone drives alone/i.test(co2A) && /per served rider/.test(co2A), co2A, await shot('admin-workspace-co2'));
  const domA = (await api(`/api/lab/experiments/${a.base}`)).body.results.rows.map((r) => [r.method_id, r.totals, r.domain?.baseline_g, r.domain?.solution_g, r.domain?.avoided_g, r.domain?.avoided_pct, r.domain?.per_served_request_g]);

  await signIn(RES); await resetMetrics();
  const r = await demoIds();
  await goHash(`#/workspace/${r.base}`, 6000);
  const co2R = await flat('section.co2'), resR = await flat('table.results');
  check('researcher-same-co2', 'A researcher sees exactly the same CO₂ summary card for the same demonstration.', co2R === co2A, co2R, await shot('researcher-workspace-co2'));
  check('researcher-same-results', 'A researcher sees the same validated results (runtimes aside).', noTime(resR) === noTime(resA), noTime(resR).slice(0, 200));
  const domR = (await api(`/api/lab/experiments/${r.base}`)).body.results.rows.map((x) => [x.method_id, x.totals, x.domain?.baseline_g, x.domain?.solution_g, x.domain?.avoided_g, x.domain?.avoided_pct, x.domain?.per_served_request_g]);
  check('api-same-values', 'The API gives both accounts identical totals, baseline, emissions, avoided emissions, reduction and per-served-rider values.', JSON.stringify(domA) === JSON.stringify(domR) && domR.every((x) => x[4] > 0), JSON.stringify(domR[0]).slice(0, 200));

  // ================================================================ 2 · Choose metrics in the Workspace
  const h0 = await headers();
  check('workspace-default-columns', 'The Workspace results start with the compact default columns.', ['Served', 'Δ vs ref.', 'Time'].every((x) => h0.includes(x)) && h0.length <= 6, h0.join(' · '));
  await openChooser();
  const groups = await p.eval(`[...document.querySelectorAll('.metric-chooser legend')].map((x) => x.innerText.trim())`);
  check('chooser-groups', 'The dialog groups the metrics: Validation, Optimization, Performance, Mobility and CO₂ (ML evaluation and Custom metrics appear when the experiment has them).',
    ['Validation', 'Optimization', 'Performance', 'Mobility and CO₂'].every((g) => groups.includes(g)), groups.join(' · '), await shot('choose-metrics'));
  await remember(false);
  await tick('Runtime', false); await tick('CO₂e reduction', true); await tick('Validated runs', true);
  await apply();
  const h1 = await headers();
  check('checkboxes-control-columns', 'Unticking Runtime removes its column; ticking CO₂e reduction and Validated runs adds theirs.', !h1.includes('Time') && h1.includes('CO₂e reduction') && h1.includes('Validated'), h1.join(' · '), await shot('workspace-chosen-columns'));
  const co2Cells = await p.eval(`[...document.querySelectorAll('table.results td[data-metric="co2_avoided_pct"]')].map((x) => x.innerText.trim())`);
  check('co2-column-values', 'The CO₂e reduction column carries the real percentages (never 0 % as a placeholder).', co2Cells.length >= 2 && co2Cells.every((x) => /^[\d.,]+ %$/.test(x) && parseFloat(x) > 0), co2Cells.join(' · '));
  await openChooser(); await chooserBtn('Select all');
  const allN = (await ticked()).length, total = await p.eval(`document.querySelectorAll('.metric-chooser .metric-choice input').length`);
  await chooserBtn('Deselect all');
  const none = (await ticked()).length, applyOff = await p.eval(`[...document.querySelectorAll('.metric-chooser button')].find((b) => b.innerText.trim() === 'Apply').disabled`);
  check('select-all-deselect-all', 'Select all ticks every metric; Deselect all unticks them and Apply waits for at least one metric.', allN === total && total > 8 && none === 0 && applyOff === true, `${allN}/${total} then ${none}, Apply disabled: ${applyOff}`);
  await chooserBtn('Reset to defaults'); const defs = await ticked(); await apply();
  const h2 = await headers();
  check('reset-to-defaults', 'Reset to defaults restores the default columns.', JSON.stringify(h2) === JSON.stringify(h0), `${defs.join(', ')} → ${h2.join(' · ')}`);
  // a choice kept for the account is the one every view uses
  await openChooser(); await remember(true); await tick('CO₂e reduction', true); await tick('Vehicle distance', true); await apply();
  const saved = (await api('/api/lab/state')).body.preferences.metrics ?? {};
  check('saved-for-account', 'With "Keep this choice for my account" the choice is stored in the account preferences, per problem.', Object.values(saved).some((v) => v.includes('co2_avoided_pct') && v.includes('vehicle_km')), JSON.stringify(saved).slice(0, 200));

  // ================================================================ 3 · Compare › Methods: same choice, charts, export
  await p.click('Compare', '.topbar button, .lab button'); await sleep(5000);
  const hashM = await p.eval('decodeURIComponent(location.hash)');
  const note = await flat('.compare-kind-note');
  check('compare-methods-open', 'One Compare entry opens Methods | Experiments, with a line saying what Methods compares.', /^#\/methods\//.test(hashM) && /Methods: different algorithms on the same matched scenarios/.test(note), `${hashM} · ${note}`, await shot('compare-methods'));
  const rowsM = await p.eval(`[...document.querySelectorAll('table.cmp-table tbody tr:not(.grp) td:first-child')].map((x) => x.innerText.trim())`);
  check('methods-same-choice', 'Compare › Methods shows the metrics chosen in the Workspace (same selection).', rowsM.includes('CO₂e reduction') && rowsM.includes('Vehicle distance') && !rowsM.includes('CO₂e avoided'), rowsM.join(' · '));
  await p.click('Charts', '.tabs button', true); await sleep(2500);
  const cards = () => p.eval(`[...document.querySelectorAll('.chart-plot')].map((x) => ({ file: x.dataset.chart, kind: x.dataset.kind, bars: x.querySelectorAll('rect').length, lines: x.querySelectorAll('polyline').length, dots: x.querySelectorAll('circle').length }))`);
  const kinds = {};
  for (const [label, want] of [['Bar', 'bar'], ['Grouped bar', 'grouped'], ['Line', 'line'], ['Box plot', 'box'], ['Scatter', 'scatter']]) {
    const st = await p.eval(`(() => { const b = [...document.querySelectorAll('[aria-label="chart type"] button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); return b ? { disabled: b.disabled, why: b.title } : null; })()`);
    if (!st) { kinds[label] = 'missing'; continue; }
    if (st.disabled) { kinds[label] = `disabled: ${st.why}`; continue; }
    await p.click(label, '[aria-label="chart type"] button', true); await sleep(900);
    const c = (await cards()).filter((x) => x.kind === want);
    const drawn = c.filter((x) => (want === 'line' ? x.lines > 0 && x.dots > 0 : want === 'scatter' ? x.dots > 0 : x.bars > 0)).length;
    kinds[label] = c.length && drawn === c.length ? `${c.length} charts drawn` : `FAILED: ${c.length} cards, ${drawn} drawn`;
    await shot(`charts-${want}`);
  }
  check('chart-types', 'Bar, grouped bar, line and scatter draw their marks for every chosen metric; a type the recorded data cannot support is disabled with the reason (box plot needs five values per series).',
    ['Bar', 'Grouped bar', 'Line', 'Scatter'].every((k) => /charts drawn/.test(kinds[k])) && (/charts drawn/.test(kinds['Box plot']) || /^disabled: .+/.test(kinds['Box plot'])), JSON.stringify(kinds));
  await p.click('Bar', '[aria-label="chart type"] button', true); await sleep(800);
  // chart metric selection with checkboxes: the same dialog, from the charts
  await p.click('Choose metrics', '.chart-controls button'); await p.waitFor('!!document.querySelector(".metric-chooser")', 8000, 'dialog from charts');
  await remember(false); await tick('Vehicle distance', false); await apply();
  const afterUntick = (await cards()).map((x) => x.file);
  check('chart-metric-checkboxes', 'Unticking a metric in the dialog removes its chart; the others stay.', !afterUntick.some((f) => /vehicle_km/.test(f)) && afterUntick.length >= 3, afterUntick.join(' · '));
  // selection and combined export
  const sel0 = await flat('.chart-export');
  await p.click('Select all charts', '.chart-export button', true); await sleep(400);
  const selAll = await flat('.chart-export');
  await p.click('Clear selection', '.chart-export button', true); await sleep(400);
  const selNone = await flat('.chart-export');
  const available = (await cards()).map((x) => x.file);
  const two = available.slice(0, 2);
  for (const f of two) await p.eval(`(() => { const card = document.querySelector('.chart-plot[data-chart=${JSON.stringify(f).replace(/"/g, '\\"')}]').closest('.chart-card'); card.querySelector('.chart-pick').click(); return true; })()`);
  await sleep(400);
  const selTwo = await flat('.chart-export');
  check('chart-selection', 'Charts are selected one by one, all at once, or cleared; the count follows.', /^0 of \d+ charts selected/.test(sel0) && new RegExp(`^${available.length} of ${available.length} charts selected`).test(selAll) && /^0 of/.test(selNone) && new RegExp(`^2 of ${available.length} charts selected`).test(selTwo),
    `${sel0.slice(0, 26)} → ${selAll.slice(0, 26)} → ${selNone.slice(0, 26)} → ${selTwo.slice(0, 26)}`, await shot('charts-two-selected'));
  const before = p.downloadCount();
  await p.click('Export selected (ZIP)', '.chart-export button'); await p.waitDownload(before, 30000); await sleep(600);
  const zipFile = readdirSync(DL).filter((f) => /^move_openlab_charts_.*\.zip$/.test(f)).map((f) => join(DL, f)).sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0];
  const files = unzip(readFileSync(zipFile)), names = Object.keys(files);
  const want = [...two.flatMap((f) => [`charts/${f}.png`, `charts/${f}.svg`, `charts/${f}.csv`]), 'manifest.json', 'README.txt'];
  check('zip-contents', 'The ZIP holds a PNG, an SVG and a CSV for each selected chart (and only those), a manifest and a README.', JSON.stringify(names.sort()) === JSON.stringify([...want].sort()), names.join(' · '));
  const man = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
  const m0 = man.charts[0];
  check('manifest', 'The manifest records title, metric, unit, chart type, scenario scope, method labels and provenance.',
    man.format === 'move-openlab/chart-export@1' && man.charts.length === 2 && ['title', 'metric', 'metric_id', 'unit', 'chart_type', 'scenario_scope', 'methods', 'series', 'computed_over', 'files'].every((k) => k in m0) && m0.methods.length >= 2
      && Array.isArray(man.compared) && man.compared.every((c) => c.campaign_id && c.method && c.validator_version && /^\d+\/\d+$/.test(c.runs_accepted)), JSON.stringify(m0).slice(0, 320));
  const images = two.map((f, i) => ({ f, ...png(Buffer.from(files[`charts/${f}.png`])), want: man.charts[i].image_size_px }));
  check('png-real-images', 'Every PNG is the rendered chart: its size is twice the recorded image size (2× resolution), and it is drawn (marks, title, legend), not a blank canvas.',
    images.every((im) => im.width === 2 * im.want.width && im.height === 2 * im.want.height && im.width >= 560 && im.height >= 500 && im.drawnRows > im.height * 0.25 && im.distinct > 12), JSON.stringify(images.map((im) => ({ f: im.f, size: `${im.width}×${im.height}`, drawnRows: im.drawnRows, distinct: im.distinct }))));
  const svg0 = Buffer.from(files[`charts/${two[0]}.svg`]).toString('utf8'), csv0 = Buffer.from(files[`charts/${two[0]}.csv`]).toString('utf8');
  check('svg-labels-legend', 'The SVG carries the chart title, what it is computed over, a legend entry per method and the plot marks.',
    svg0.includes(m0.title.replace(/&/g, '&amp;')) && m0.series.every((s) => svg0.includes(s.replace(/&/g, '&amp;').slice(0, 20))) && (svg0.match(/<rect /g) ?? []).length >= 3 && /MOVE OpenLab/.test(svg0), `${svg0.length} bytes · ${m0.series.join(' / ')}`);
  check('csv-data', 'The CSV carries the numbers behind the chart, one column per method.', csv0.trim().split('\n').length >= 2 && m0.series.every((s) => csv0.includes(s.slice(0, 12))) && /\d/.test(csv0.split('\n')[1]), csv0.trim().replace(/\n/g, ' ⏎ ').slice(0, 220));

  // ================================================================ 4 · Compare › Experiments
  await goHash(`#/compare/${r.base}|${r.variant}`, 6000);
  const noteE = await flat('.compare-kind-note');
  const rowsE = await p.eval(`[...document.querySelectorAll('table.cmp-table tbody tr[data-metric] td:first-child')].map((x) => x.innerText.trim())`);
  const evidence = await flat('#cmp-evidence');
  check('compare-experiments', 'Compare › Experiments keeps validation, reproducibility and comparability, says what it compares, and shows the account’s chosen metrics.',
    /Experiments: separate experiments with each other/.test(noteE) && rowsE.includes('CO₂e reduction') && /validat/i.test(evidence) && /reproducib/i.test(evidence), `${rowsE.join(' · ')}`, await shot('compare-experiments'));
  const tabs = await flat('nav.tabs');
  check('compare-experiments-views', 'Results, Charts, Maps, Replay and Diff are all there.', ['Results', 'Charts', 'Maps', 'Replay', 'Diff'].every((t) => tabs.includes(t)), tabs);
  await p.click('Choose metrics', '.cmp-head button'); await p.waitFor('!!document.querySelector(".metric-chooser")', 8000, 'dialog in Experiments');
  await remember(false); await tick('Runtime', false); await apply();
  const rowsE2 = await p.eval(`[...document.querySelectorAll('table.cmp-table tbody tr[data-metric] td:first-child')].map((x) => x.innerText.trim())`);
  check('experiments-checkboxes', 'The same dialog controls the rows of the Experiments table.', rowsE.includes('Runtime') && !rowsE2.includes('Runtime'), rowsE2.join(' · '));

  // ================================================================ 5 · French / English
  await p.click('FR', '.lang-seg button', true); await sleep(2500);
  const fr = await text();
  check('french', 'The new controls are in French when French is chosen.', /Choisir les métriques/.test(fr) && /Expériences : des expériences distinctes/.test(fr), (await flat('.cmp-head')).slice(0, 200), await shot('french'));
  await p.eval(`(() => { const b = [...document.querySelectorAll('.lang-prompt button')].find((x) => /Non|No/.test(x.innerText)); if (b) b.click(); return true; })()`);
  await p.click('EN', '.lang-seg button', true); await sleep(2000);
  await p.eval(`(() => { const b = [...document.querySelectorAll('.lang-prompt button')].find((x) => /Non|No/.test(x.innerText)); if (b) b.click(); return true; })()`);
  check('english-back', 'English comes back.', /Choose metrics/.test(await text()), 'EN');

  // ================================================================ 6 · the public synthetic benchmark (no map: charts in the Workspace)
  await goHash('#/benchmarks', 3500);
  const bench = await text();
  check('benchmark-page', 'The public synthetic assignment benchmark is available, says what a benchmark is, and holds no placeholder.', /Public synthetic assignment benchmark/i.test(bench) && /Compare or Benchmark\?/.test(bench) && /reproduces the results of no other study/.test(bench) && !/Planned/i.test(bench), (await flat('main')).slice(0, 200), await shot('benchmarks'));
  await p.click('Run the public benchmark', 'button'); await p.waitFor('location.hash.startsWith("#/workspace/")', 30000, 'benchmark opened in the Workspace');
  await p.waitFor('document.querySelectorAll(".chart-plot").length > 0', 240000, 'benchmark results charted');
  await sleep(1500);
  const bc = await cards();
  check('benchmark-workspace-charts', 'The benchmark runs, is validated, and its charts (with the same metric choice and export) appear in the Workspace.', bc.length >= 2 && bc.every((x) => x.bars + x.dots + x.lines > 0) && /charts selected/.test(await flat('.chart-export')) && /accepted/.test(await text('.lab-right')), `${bc.length} charts · ${(await flat('.evidence')).slice(0, 90)}`, await shot('benchmark-workspace'));
  await resetMetrics(false);
  check('no-page-errors', 'No script error occurred in the pages.', p.errors.length === 0, p.errors.slice(0, 3).join(' | ') || 'none');
} catch (e) {
  check('script', 'The script runs to its end.', false, e?.stack ?? String(e), p ? await shot('failure').catch(() => undefined) : undefined);
} finally {
  if (p) await p.close();
  report.finished = new Date().toISOString();
  const pass = report.checks.filter((c) => c.status === 'PASS').length;
  report.summary = { pass, total: report.checks.length };
  writeFileSync(join(OUT, 'final-corrections.json'), JSON.stringify(report, null, 1));
  console.log(`SUMMARY ${pass}/${report.checks.length} PASS`);
  process.exit(pass === report.checks.length ? 0 : 1);
}
