#!/usr/bin/env node
// Browser checks of the two public sample packages, on the data directory made by seed_ci.py (synthetic accounts; the
// Montbéliard road network is NOT installed there — the "network not installed" case):
//
//   MOVE_OPENLAB_DATA_DIR=<empty dir> python scripts/e2e/seed_ci.py
//   MOVE_OPENLAB_DATA_DIR=<same dir> MOVE_OPENLAB_PORT=8791 MOVE_OPENLAB_TILE_URL=none ./start-local.sh
//   node scripts/e2e/samples.mjs --base http://127.0.0.1:8791 --creds <dir>/dev-credentials.json --out <out dir>
//        [--base2 URL --creds2 FILE]   a second installation that stores the Montbéliard road network ("installed" case)
//
// Checks: Import ▾ → Try a sample shows both cards; both files download and their SHA-256 equal the published ones
// (examples/SHA256SUMS and the application's state); the sample scenario is verified and imported into the scenario
// library, opened in a new experiment with both built-in methods, run, every run validated, routes on the map from the
// package's geometry; the Import dialog routes a scenario package to the scenario importer; the sample experiment is
// verified and imported, its results labelled as imported (never as executed here), compared, reproduced → Reproduced;
// the guide at 375 px and in the dark theme. With --base2: the same package is rebuilt there and identical.
// Real mouse and keyboard events in headless Chromium. Passwords come from the credentials files and are never printed.
// Writes samples.json (per check: expected, actual, PASS/FAIL, evidence) and screenshots. Exit 1 on a failure.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8791'), OUT = arg('out'), CREDS = arg('creds'), BASE2 = arg('base2'), CREDS2 = arg('creds2');
const USER = 'researcher1', RIDE = 'public-ride-matching';
if (!OUT || !CREDS) { console.error('usage: samples.mjs --base URL --creds FILE --out DIR [--base2 URL --creds2 FILE]'); process.exit(2); }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chrome = process.env.CHROME ?? (() => {
  const root = join(homedir(), '.cache/ms-playwright');
  const dir = existsSync(root) && readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().at(-1);
  return dir ? join(root, dir, 'chrome-linux64/chrome') : 'chromium';
})();
const SHOTS = join(OUT, 'screenshots'), DL = join(OUT, 'downloads');
rmSync(DL, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true }); mkdirSync(DL, { recursive: true });
const published = Object.fromEntries(readFileSync(join(ROOT, 'examples', 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/).reverse()));
const report = { base: BASE, started: new Date().toISOString(), published, checks: [] };
let n = 0, p;
const shot = async (name, settle = 700) => { await sleep(settle); const f = `${String(++n).padStart(2, '0')}-${name}.png`; await p.shot(join(SHOTS, f)); return f; };
const expect = (c, m) => { if (!c) throw new Error(m); };
const text = (css = 'body') => p.eval(`(document.querySelector(${JSON.stringify(css)})?.innerText ?? '')`);
const api = (path, init = {}) => p.eval(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }))`);
const goHash = async (h, settle = 2500) => { await p.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(settle); };
const cidNow = async () => decodeURIComponent((await p.eval('location.hash')).split('/')[2] ?? '');
const experiment = async (cid) => (await api(`/api/lab/experiments/${cid}`)).body;
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const waitWorkspace = () => p.waitFor('!!document.querySelector(".lab-grid") && !/Loading the demonstration/.test(document.querySelector(".lab-notes")?.innerText ?? "")', 90000, 'workspace');
const armJob = () => p.eval(`(() => { window.__jobSeen = false; const o = new MutationObserver(() => { if (document.querySelector('.job')) { window.__jobSeen = true; o.disconnect(); } }); o.observe(document.body, { childList: true, subtree: true }); return true; })()`);
async function waitJob(timeout = 300000) {
  await p.waitFor('window.__jobSeen === true || !!document.querySelector(".job")', 30000, 'job progress');
  await p.waitFor('["done","error","cancelled","interrupted"].includes(document.querySelector(".job")?.dataset.state) || !document.querySelector(".job")', timeout, 'job end');
  return p.eval('document.querySelector(".job")?.dataset.state ?? "gone"');
}
async function signIn(base, creds, user) {
  if (p) await p.close();
  p = await launch(chrome, { width: 1440, height: 900 }); await p.size(1440, 900, 1); await p.allowDownloads(DL);
  const pw = (u) => (typeof creds[u] === 'string' ? creds[u] : creds[u]?.password);
  await p.goto(`${base}/login`);
  await p.focusCss('input[name=username]'); await p.type(user);
  await p.focusCss('input[name=password]'); await p.type(pw(user));
  await p.click('Sign in', 'button');
  await p.waitFor('location.pathname === "/" && !!document.querySelector(".hdr")', 30000, `sign-in of ${user}`);
  await waitWorkspace(); await sleep(2500);
}
async function check(id, expected, fn) {
  const e0 = p.errors.length, rec = { id, expected, actual: '', status: 'FAIL', evidence: [], page_errors: [] };
  try { const r = await fn(); rec.actual = r?.actual ?? ''; rec.evidence = r?.evidence ?? []; rec.status = 'PASS'; }
  catch (e) { rec.actual = `ERROR: ${String(e.message ?? e).slice(0, 500)}`; try { const f = `fail-${id}.png`; await p.shot(join(SHOTS, f)); rec.evidence.push(f); } catch { /* */ } }
  rec.page_errors = p.errors.slice(e0);
  if (rec.page_errors.length) { rec.status = 'FAIL'; rec.actual += ` · page errors: ${rec.page_errors.join(' | ').slice(0, 300)}`; }
  report.checks.push(rec);
  console.log(`${rec.status}  ${id} — ${rec.actual.slice(0, 220)}`);
  writeFileSync(join(OUT, 'samples.json'), JSON.stringify(report, null, 1));
}
const openSamples = async () => {
  if (await p.eval('!!document.querySelector(".samples-guide")')) return;
  await p.click('Import', '.labbar button'); await p.click('Try a sample', '[role=menuitem]');
  await p.waitFor('!!document.querySelector(".samples-guide")', 10000, 'Try a sample guide');
};
const downloadFrom = async (label, name) => {
  const before = p.downloadCount();
  await p.click(label, '.samples-guide button'); await p.waitDownload(before);
  for (let i = 0; i < 40 && !existsSync(join(DL, name)); i++) await sleep(150);
  expect(existsSync(join(DL, name)), `downloaded file ${name} not found in ${readdirSync(DL).join(', ')}`);
  return sha(join(DL, name));
};
const close = async () => { await p.key('Escape'); await sleep(400); };

await signIn(BASE, JSON.parse(readFileSync(CREDS, 'utf8')), USER);
const st0 = (await api('/api/lab/state')).body;
const sc0 = st0.sample_scenario, ex0 = st0.sample;
let scenarioName = '', instanceHash = '', runCid = '', importedCid = '';

await check('try-a-sample', 'Import ▾ → Try a sample opens one guide with two cards: Sample scenario and Sample experiment.', async () => {
  await openSamples();
  await p.waitFor('!!document.querySelector(".samples-guide .pkg-checks")', 30000, 'scenario verification');
  const cards = await p.eval('[...document.querySelectorAll(".samples-guide .sample-card")].map((c) => c.dataset.sample)');
  expect(JSON.stringify(cards) === '["scenario","experiment"]', `cards ${cards}`);
  const s = await shot('try-a-sample');
  return { actual: `cards: ${cards.join(', ')}`, evidence: [s] };
});

await check('downloads', 'Both files download; their SHA-256 equal examples/SHA256SUMS and the values the application publishes.', async () => {
  await openSamples();
  const a = await downloadFrom('Download sample scenario', sc0.filename);
  const b = await downloadFrom('Download sample bundle', ex0.filename);
  expect(a === published['sample_scenario.zip'] && a === sc0.sha256, `scenario ${a} vs ${published['sample_scenario.zip']} / ${sc0.sha256}`);
  expect(b === published['sample_experiment.zip'] && b === ex0.sha256, `experiment ${b} vs ${published['sample_experiment.zip']} / ${ex0.sha256}`);
  report.downloads = { [sc0.filename]: a, [ex0.filename]: b };
  return { actual: `${sc0.filename} ${a.slice(0, 16)}… = published; ${ex0.filename} ${b.slice(0, 16)}… = published (sample_experiment.zip)` };
});

await check('scenario-import', 'The sample scenario is verified (checksums, instance hash, licences; its composition rebuilt on the demonstration road network shipped with the installation and identical) and imported into the scenario library.', async () => {
  await openSamples();
  const checks = await text('.samples-guide [data-sample=scenario] .pkg-checks');
  for (const k of ['Archive and manifest', 'Frozen instance', 'Replay geometry', 'Editable composition', 'rebuilt here on the installed road network and identical', 'No executable code']) expect(checks.includes(k), `checks lack ${k}: ${checks}`);
  await p.click('Import the sample scenario', '.samples-guide button');
  await p.waitFor('/scenario library/.test(document.querySelector(".samples-guide [data-sample=scenario]")?.innerText ?? "")', 30000, 'imported');
  const card = await text('.samples-guide [data-sample=scenario]');
  expect(!/Editing the participants needs the area's road network/.test(card), 'the card says the road network is missing, but it ships with the installation');
  await p.eval(`document.querySelector('.samples-guide .pkg-more')?.setAttribute('open', '')`);
  const facts = await text('.samples-guide .pkg-more');
  expect(/Licence Ouverte/.test(facts) && /OpenStreetMap contributors/.test(facts), `licences: ${facts.slice(0, 300)}`);
  const lib = (await api('/api/geo/scenarios')).body.scenarios.find((s) => s.instance_hash === sc0.instance_hash);
  expect(lib && lib.category === 'Imported' && lib.source === 'imported scenario package', `library ${JSON.stringify(lib)}`);
  scenarioName = lib.name; instanceHash = lib.instance_hash;
  const s = await shot('scenario-imported');
  return { actual: `in the library as “${lib.name}” (${lib.drivers} drivers, ${lib.riders} riders, ${lib.category}); checks: ${checks.replace(/\n+/g, ' | ').slice(0, 300)}`, evidence: [s] };
});

await check('scenario-run', 'Open it in a new experiment, tick both built-in methods, Run: every run validated; the map draws the routes from the package geometry.', async () => {
  await openSamples();
  await p.click('Open it in a new experiment', '.samples-guide button');
  await p.waitFor(`!!document.querySelector('.lab-left input[aria-label=${JSON.stringify(scenarioName)}]')?.checked`, 15000, 'scenario ticked in the new experiment');
  const builtin = (await api(`/api/problems/${RIDE}/methods`)).body.builtin;
  for (const m of builtin) await p.eval(`(() => { const b = document.querySelector('.lab-right input[aria-label=${JSON.stringify(m.name)}]'); if (!b) throw new Error('no method ' + ${JSON.stringify(m.name)}); if (!b.checked) b.click(); return true; })()`);
  await sleep(400);
  const s0 = await shot('new-experiment-ready');
  await armJob();
  await p.click('Save & Run', '.lab-left button');
  const stt = await waitJob(); expect(stt === 'done' || stt === 'gone', `job ${stt}`);
  await sleep(3000);
  runCid = await cidNow();
  const e = await experiment(runCid);
  expect(e.validation.runs > 0 && e.validation.accepted === e.validation.runs, `validation ${JSON.stringify(e.validation)}`);
  expect(new Set(e.methods.map((m) => m.method_id)).size === builtin.length, `methods ${e.methods.map((m) => m.method_id)}`);
  const runs = (await api(`/api/campaigns/${runCid}`)).body.campaign.runs;
  const pb = (await api(`/api/geo/playback/${runCid}/${runs[0].run_id}`)).body;
  expect(pb.geometry === 'road', `playback geometry ${pb.geometry}`);
  // routes are drawn on a canvas (or SVG paths): something must be drawn in the overlay pane
  const ink = () => p.eval(`(() => { const c = document.querySelector('.lab-grid .leaflet-overlay-pane canvas'); let n = 0;
    if (c) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++; }
    return n + document.querySelectorAll('.lab-grid .leaflet-overlay-pane path').length * 1000; })()`);
  let paths = 0;
  for (let i = 0; i < 60 && paths <= 100; i++) { paths = await ink(); if (paths <= 100) await sleep(300); }
  expect(paths > 100, `nothing drawn on the map (${paths})`);
  const badge = await text('.labbar');
  const s1 = await shot('scenario-run-validated', 1200);
  return { actual: `${runCid}: ${e.validation.accepted}/${e.validation.runs} validated (${builtin.map((m) => m.method_id).join(', ')}); playback geometry “${pb.geometry}”; ${paths} drawn map pixels; toolbar “${badge.replace(/\n+/g, ' ').slice(0, 80)}”`, evidence: [s0, s1] };
});

await check('import-dialog-routing', 'Import ▾ → Import a bundle file… with the downloaded scenario package: the manifest is read and the scenario importer verifies it.', async () => {
  await p.click('Import', '.labbar button'); await p.click('Import a bundle file', '[role=menuitem]');
  await p.waitFor('!!document.querySelector(".importd")', 10000, 'import dialog');
  await p.setFiles('input[aria-label="bundle file to inspect"]', [join(DL, sc0.filename)]);
  await p.waitFor('!!document.querySelector(".importd .pkg-checks")', 60000, 'scenario inspection');
  const t = await text('.importd');
  expect(/Import scenario/.test(t) && /Already in your scenario library/.test(t), `dialog: ${t.slice(0, 300)}`);
  const s = await shot('import-dialog-scenario');
  await p.click('Import scenario', '.importd button', true);
  await p.waitFor('!document.querySelector(".importd") && location.hash.includes("__new__")', 20000, 'new experiment after import');
  return { actual: 'scenario package recognised by its manifest; already in the library; Import scenario opens a new experiment with it', evidence: [s] };
});

await check('experiment-import', 'The sample experiment is verified and imported through “Try an imported experiment”; its results are labelled imported, never executed here.', async () => {
  await goHash(`#/workspace/${runCid}`, 2500);
  await openSamples();
  await p.click('Try an imported experiment', '.samples-guide button');
  await p.waitFor('!!document.querySelector(".guide .checks")', 30000, 'integrity report');
  const before = p.downloadCount();
  await p.click('Download sample bundle', '.guide button'); await p.waitDownload(before);
  await p.click('Import the sample', '.guide button');
  await p.waitFor('/Imported/.test(document.querySelector(".guide")?.innerText)', 30000, 'imported');
  const checks = (await text('.guide .checks')).replace(/\n+/g, ' | ');
  const s0 = await shot('experiment-verified-imported');
  await p.click('Open in the workspace', '.guide button');
  await sleep(3000);
  importedCid = await cidNow();
  const e = await experiment(importedCid);
  const item = (await api('/api/lab/experiments')).body.experiments.find((x) => x.campaign_id === importedCid);
  expect(e.campaign.imported && item?.category === 'Imported', `imported ${e.campaign.imported} ${item?.category}`);
  const left = await text('.lab-left');
  expect(/Imported/.test(left), 'no Imported label in the scenario panel');
  const s1 = await shot('experiment-imported-results', 1200);
  return { actual: `${importedCid}: imported=${e.campaign.imported}, category ${item.category}, ${e.validation.accepted}/${e.validation.runs} validated; ${checks.slice(0, 260)}`, evidence: [s0, s1] };
});

await check('experiment-compare-reproduce', 'Compare the imported results, then reproduce them here (Run again): the verdict is Reproduced.', async () => {
  await p.click('Compare', '.labbar button');            // several methods: Compare › Methods of this experiment
  await p.waitFor('location.hash.startsWith("#/methods/") || location.hash.startsWith("#/compare/")', 15000, 'compare view'); await sleep(2500);
  const s0 = await shot('experiment-compare');
  await goHash(`#/workspace/${importedCid}`, 3000);
  await openSamples();
  await p.click('Try an imported experiment', '.samples-guide button');
  await p.waitFor('!!document.querySelector(".guide .checks")', 30000, 'guide');
  await armJob();
  await p.click('Reproduce on this installation', '.guide button');
  const stt = await waitJob(); expect(stt === 'done' || stt === 'gone', `job ${stt}`);
  await p.waitFor('/Reproduced/.test(document.querySelector(".guide")?.innerText ?? "")', 60000, 'Reproduced verdict');
  const verdict = (await text('.guide .note')).replace(/\n+/g, ' ');
  const s1 = await shot('experiment-reproduced');
  await p.click('Compare original and reproduction', '.guide button');
  await p.waitFor('location.hash.startsWith("#/compare")', 15000, 'compare original and reproduction'); await sleep(2500);
  const s2 = await shot('compare-original-reproduction');
  return { actual: verdict.slice(0, 240), evidence: [s0, s1, s2] };
});

await check('phone-dark', 'At 375 px and in the dark theme the guide fits the screen (no horizontal scrolling).', async () => {
  const theme = (t) => p.eval(`(async () => { localStorage.setItem('move-openlab-theme', '${t}'); return (await fetch('/api/lab/preferences', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: '${t}' }) })).status; })()`);
  await p.size(375, 812, 2, true); await theme('dark');                     // the dark theme is a choice of the account
  await p.goto(`${BASE}/`); await waitWorkspace(); await sleep(2000);
  expect(await p.eval('document.documentElement.dataset.theme') === 'dark', 'not in the dark theme');
  await openSamples(); await p.waitFor('!!document.querySelector(".samples-guide .pkg-checks")', 30000, 'verification');
  const fit = await p.eval('({ sw: document.documentElement.scrollWidth, w: innerWidth, dw: document.querySelector(".samples-guide").scrollWidth, cw: document.querySelector(".samples-guide").clientWidth })');
  const s = await shot('samples-phone-dark', 600);
  await p.eval('document.querySelector(".samples-guide").scrollTop = 99999'); const s2 = await shot('samples-phone-dark-bottom', 400);
  await theme('light'); await p.size(1440, 900, 1);
  expect(fit.sw <= fit.w + 1 && fit.dw <= fit.cw + 1, `page ${fit.sw}/${fit.w}, drawer ${fit.dw}/${fit.cw}`);
  return { actual: `page ${fit.sw} px for ${fit.w} px; drawer ${fit.dw} px for ${fit.cw} px`, evidence: [s, s2] };
});

if (BASE2 && CREDS2) {
  await signIn(BASE2, JSON.parse(readFileSync(CREDS2, 'utf8')), USER);
  await check('installed-network', 'Where the Montbéliard road network is installed, the sample scenario is rebuilt from its composition and identical.', async () => {
    await openSamples();
    await p.waitFor('!!document.querySelector(".samples-guide .pkg-checks")', 60000, 'scenario verification');
    const checks = await text('.samples-guide [data-sample=scenario] .pkg-checks');
    expect(/rebuilt here on the installed road network and identical/.test(checks), `checks: ${checks}`);
    const card = await text('.samples-guide [data-sample=scenario]');
    expect(/Rebuilt here and identical/.test(card), 'no rebuilt-and-identical note');
    const s = await shot('installed-network-rebuilt');
    return { actual: checks.replace(/\n+/g, ' | ').slice(0, 300), evidence: [s] };
  });
}

report.finished = new Date().toISOString();
report.summary = { total: report.checks.length, pass: report.checks.filter((c) => c.status === 'PASS').length };
writeFileSync(join(OUT, 'samples.json'), JSON.stringify(report, null, 1));
console.log(`${report.summary.pass}/${report.summary.total} checks passed`);
await p.close();
process.exit(report.summary.pass === report.summary.total ? 0 : 1);
