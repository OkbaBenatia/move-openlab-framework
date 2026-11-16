#!/usr/bin/env node
// The main browser journeys, on synthetic and public data only — run in CI and runnable locally:
//
//   MOVE_OPENLAB_DATA_DIR=<empty dir> python scripts/e2e/seed_ci.py
//   MOVE_OPENLAB_DATA_DIR=<same dir> MOVE_OPENLAB_PORT=8791 MOVE_OPENLAB_TILE_URL=none ./start-local.sh
//   node scripts/e2e/ci_journeys.mjs --base http://127.0.0.1:8791 --creds <dir>/dev-credentials.json --out <out dir>
//
// Journeys: sign-in; first-use public demonstration; Generate (seeded synthetic demand on the synthetic grid) and
// Save & Run; compare exactly two experiments; export one ZIP; workspace isolation; import into a second researcher's
// workspace; independent reproduction; add a method (sandboxed plug-in) and validate it; phone layout smoke test.
// Real mouse and keyboard events in headless Chromium. Passwords come from the credentials file and are never printed,
// saved or captured. Writes ci-journeys.json (per journey: expected, actual, PASS/FAIL, evidence) and screenshots.
// Exit code 1 when a journey fails.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8791'), OUT = arg('out'), CREDS = arg('creds');
const A = 'researcher1', B = 'researcher2', AREA = 'Synthetic grid';
if (!OUT || !CREDS) { console.error('usage: ci_journeys.mjs --base URL --creds FILE --out DIR'); process.exit(2); }
const chrome = process.env.CHROME ?? (() => {
  const root = join(homedir(), '.cache/ms-playwright');
  const dir = existsSync(root) && readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().at(-1);
  return dir ? join(root, dir, 'chrome-linux64/chrome') : 'chromium';
})();
const SHOTS = join(OUT, 'screenshots'), DL = join(OUT, 'downloads');
mkdirSync(SHOTS, { recursive: true }); mkdirSync(DL, { recursive: true });
const creds = JSON.parse(readFileSync(CREDS, 'utf8'));
const pw = (u) => (typeof creds[u] === 'string' ? creds[u] : creds[u]?.password);
const W = 1440, H = 900;

const report = { base: BASE, started: new Date().toISOString(), journeys: [], facts: {} };
const F = report.facts;
let n = 0;
const p = await launch(chrome, { width: W, height: H });
await p.size(W, H, 1);
await p.allowDownloads(DL);

const shot = async (name, settle = 600) => { await sleep(settle); const f = `${String(++n).padStart(2, '0')}-${name}.png`; await p.shot(join(SHOTS, f)); return f; };
const expect = (c, m) => { if (!c) throw new Error(m); };
const text = (css = 'body') => p.eval(`(document.querySelector(${JSON.stringify(css)})?.innerText ?? '')`);
const api = (path, init = {}) => p.eval(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }))`);
const goHash = async (h, settle = 2500) => { await p.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(settle); };
const cidNow = async () => decodeURIComponent((await p.eval('location.hash')).split('/')[2] ?? '');
const experiment = async (cid) => (await api(`/api/lab/experiments/${cid}`)).body;
const choose = (css, value) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) throw new Error('no select ' + ${JSON.stringify(css)});
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
const next = async () => { await p.click('Next', '.wizard-foot button'); await sleep(700); };
const armJob = () => p.eval(`(() => { window.__jobSeen = false; const o = new MutationObserver(() => { if (document.querySelector('.job')) { window.__jobSeen = true; o.disconnect(); } }); o.observe(document.body, { childList: true, subtree: true }); return true; })()`);
async function waitJob(timeout = 300000) {
  await p.waitFor('window.__jobSeen === true || !!document.querySelector(".job")', 30000, 'job progress');
  await p.waitFor('["done","error","cancelled","interrupted"].includes(document.querySelector(".job")?.dataset.state) || !document.querySelector(".job")', timeout, 'job end');
  return p.eval('document.querySelector(".job")?.dataset.state ?? "gone"');
}
const waitWorkspace = () => p.waitFor('!!document.querySelector(".lab-grid") && !/Loading the demonstration/.test(document.querySelector(".lab-notes")?.innerText ?? "")', 90000, 'workspace');
async function signIn(user) {
  await p.clearCookies();
  await p.goto(`${BASE}/login`);
  await p.focusCss('input[name=username]'); await p.type(user);
  await p.focusCss('input[name=password]'); await p.type(pw(user));
  await p.click('Sign in', 'button');
  await p.waitFor('location.pathname === "/" && !!document.querySelector(".hdr")', 30000, `sign-in of ${user}`);
}
async function signOut() {
  await p.click('profile', '.hdr button');
  await p.click('Sign out', '[role=menu] button, .menu button, .menu a');
  await p.waitFor('location.pathname === "/login"', 15000, 'login page after sign-out');
}
async function journey(id, title, expected, fn) {
  const t0 = Date.now(), e0 = p.errors.length;
  try { await p.key('Escape'); } catch { /* no page yet */ }
  const rec = { id, title, expected, actual: '', status: 'FAIL', evidence: [], ms: 0, page_errors: [] };
  try {
    const r = await fn();
    rec.actual = r?.actual ?? ''; rec.evidence = r?.evidence ?? []; rec.status = 'PASS';
  } catch (e) {
    rec.actual = `ERROR: ${String(e.message ?? e).slice(0, 500)}`;
    try { const f = `fail-${id}.png`; await p.shot(join(SHOTS, f)); rec.evidence.push(f); } catch { /* page gone */ }
  }
  rec.page_errors = p.errors.slice(e0); rec.ms = Date.now() - t0;
  if (rec.page_errors.length) { rec.status = 'FAIL'; rec.actual += ` · page errors: ${rec.page_errors.join(' | ').slice(0, 300)}`; }
  report.journeys.push(rec);
  console.log(`${rec.status}  ${id} ${title} — ${rec.actual.slice(0, 200)}`);
  writeFileSync(join(OUT, 'ci-journeys.json'), JSON.stringify(report, null, 1));
}
let demoBase = '', demoVariant = '', mine = '', exported = '';

await journey('login', 'Sign in', 'The sign-in page accepts the researcher and opens the application.', async () => {
  await p.goto(`${BASE}/`);
  await p.waitFor('location.pathname === "/login"', 15000, 'redirect to sign-in');
  const s = await shot('sign-in', 300);
  await signIn(A);
  return { actual: `${A} signed in (password from the credentials file, not shown).`, evidence: [s] };
});

await journey('demo', 'First-use public demonstration', 'The Montbéliard demonstration is installed once and opens with its map and validated, locked results.', async () => {
  await waitWorkspace(); await sleep(2500);
  const list = (await api('/api/lab/experiments')).body.experiments;
  const demos = list.filter((x) => x.demo);
  demoBase = demos.find((x) => x.kind === 'baseline')?.campaign_id ?? '';
  demoVariant = demos.find((x) => x.kind === 'variant' && x.parent === demoBase)?.campaign_id ?? '';
  const e = await experiment(demoBase);
  expect(demoBase && demoVariant && e.campaign.locked && e.validation.accepted === e.validation.runs, `demo ${demoBase} ${JSON.stringify(e.validation)}`);
  expect(await p.eval('!!document.querySelector(".lab-grid .leaflet-container")') && /Validated/.test(await text('.labbar')), 'no map or validation state');
  await p.goto(`${BASE}/`); await waitWorkspace(); await sleep(1500);
  const again = (await api('/api/lab/experiments')).body.experiments.length;
  expect(again === list.length, `re-installed: ${list.length} → ${again}`);
  const s = await shot('demo-workspace', 800);
  F.demo = { baseline: demoBase, variant: demoVariant, validation: e.validation };
  return { actual: `Demonstration baseline ${demoBase}: ${e.validation.accepted}/${e.validation.runs} validated, locked; installed once.`, evidence: [s] };
});

await journey('generate', 'Generate and Save & Run', 'A seeded synthetic scenario on the synthetic grid is previewed, saved and run; every solution is validated.', async () => {
  await goHash(`#/workspace/${demoBase}`, 2500);
  await p.click('Generate', '.labbar button');
  await p.waitFor('!!document.querySelector(".wizard .wizard-map .leaflet-container")', 15000, 'wizard');
  const area = (await api('/api/geo/areas')).body.areas.find((a) => a.name === AREA && a.network_id);
  expect(area, 'no synthetic grid area');
  await choose('select[aria-label=area]', area.area_id); await sleep(1500);
  await p.click('Synthetic demand', '.wizard label'); await next();
  await p.fill('.wizard input[aria-label=drivers]', '8'); await p.fill('.wizard input[aria-label=riders]', '12'); await p.fill('.wizard input[aria-label=seed]', '7');
  await p.waitFor('/8 drivers · 12 riders/.test(document.querySelector("[aria-label=\\"preview summary\\"]")?.innerText ?? "")', 60000, 'preview');
  await next();
  await p.fill('.wizard input[aria-label=from]', '07:30'); await p.fill('.wizard input[aria-label=to]', '08:00');
  await p.fill('.wizard input[aria-label="max detour minutes"]', '20'); await p.fill('.wizard input[aria-label="max detour ratio"]', '1'); await sleep(2000);
  await p.waitFor('/8 drivers · 12 riders/.test(document.querySelector("[aria-label=\\"preview summary\\"]")?.innerText ?? "")', 60000, 'preview with constraints');
  const preview = await text('[aria-label="preview summary"]');
  await next();
  await p.fill('.wizard input[aria-label="experiment name"]', 'CI · synthetic grid'); await p.fill('.wizard input[aria-label=repetitions]', '2'); await sleep(300);
  await next();
  const s1 = await shot('wizard-review', 300);
  await armJob();
  await p.click('Save & Run', '.wizard-foot button');
  const st = await waitJob(); expect(st === 'done' || st === 'gone', `job ${st}`);
  await sleep(3000); mine = await cidNow();
  const e = await experiment(mine);
  expect(e.validation.runs > 0 && e.validation.accepted === e.validation.runs && e.campaign.repetitions === 2, `validation ${JSON.stringify(e.validation)}`);
  const s2 = await shot('generated-results', 1000);
  F.generated = { campaign_id: mine, preview, validation: e.validation, rows: e.results.rows.map((r) => ({ method: r.method_id, totals: r.totals })) };
  return { actual: `“${preview}”; experiment ${mine}: ${e.validation.accepted}/${e.validation.runs} validated; ${e.results.rows.map((r) => `${r.name} ${r.totals.served} served`).join(', ')}.`, evidence: [s1, s2] };
});

await journey('compare-two', 'Compare exactly two experiments', 'The picker counts exactly what is ticked; the comparison shows A (reference) and B and nothing else.', async () => {
  const titles = Object.fromEntries((await api('/api/lab/experiments')).body.experiments.map((x) => [x.campaign_id, x.title]));
  await goHash(`#/workspace/${demoBase}`, 3000);
  // one Compare entry: it opens the Methods tab when the experiment has several methods; experiments are chosen on the Experiments tab
  await p.click('Compare', '.labbar button'); await p.waitFor('location.hash.startsWith("#/methods/") || location.hash.startsWith("#/compare/")', 30000, 'Compare'); await sleep(500); if (await p.eval('location.hash.startsWith("#/methods/")')) { await p.click('Experiments', 'nav.compare-kind button'); await sleep(600); } await p.waitFor('!!document.querySelector(".picker-drawer .cands")', 30000, 'picker'); await sleep(600);
  const ok = await p.eval(`(() => { const i = [...document.querySelectorAll('.picker-drawer input[type=checkbox]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(titles[demoVariant])} && !x.disabled); if (!i) return false; i.click(); return true; })()`);
  expect(ok, 'variant not offered'); await sleep(400);
  const foot = await text('.picker-drawer .drawer-foot');
  expect(/^2 selected/.test(foot) && /Compare selected \(2\)/.test(foot), `footer ${foot}`);
  await p.click('Compare selected (2)', '.picker-drawer button');
  await p.waitFor('!!document.querySelector(".cmp-table")', 60000, 'comparison'); await sleep(2000);
  const ids = decodeURIComponent(await p.eval('location.hash')).replace('#/compare/', '').split(/[|,]/);
  expect(ids.length === 2 && ids[0] === demoBase && ids[1] === demoVariant, `route ${ids}`);
  const s = await shot('compare-two', 600);
  return { actual: `Footer “${foot.split(' · ')[0]}”; comparison of ${ids.join(' (reference) vs ')}.`, evidence: [s] };
});

await journey('export', 'Export one ZIP', 'Exactly one bundle file is downloaded, with the evidence report inside.', async () => {
  await goHash(`#/workspace/${mine}`, 3000);
  await p.click('Export', '.labbar button');
  await p.waitFor('!!document.querySelector(".exportd .exlist")', 20000, 'export dialog');
  const before = p.downloadCount();
  await p.click('xport', '.exportd .drawer-foot button.primary');
  await p.waitDownload(before, 60000);
  await p.waitFor('/Bundle saved/.test(document.querySelector(".exportd")?.innerText)', 30000, 'confirmation'); await sleep(2500);
  const count = p.downloadCount() - before, done = await text('.exportd');
  const s = await shot('export-done', 200);
  await p.click('Done', '.exportd button');
  exported = readdirSync(DL).filter((f) => f.endsWith('.zip')).map((f) => join(DL, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1);
  expect(count === 1 && exported && /evidence\/report\.json/.test(done), `downloads ${count} ${done.slice(0, 160)}`);
  F.export = { file: basename(exported), bytes: statSync(exported).size };
  return { actual: `1 download: ${basename(exported)} (${statSync(exported).size} bytes), evidence report inside.`, evidence: [s] };
});

await journey('isolation', 'Workspace isolation', 'Another researcher cannot read, export or see the first researcher\'s experiment.', async () => {
  await signOut(); await signIn(B); await waitWorkspace(); await sleep(2000);
  const a = await api(`/api/lab/experiments/${mine}`), c = await api(`/api/campaigns/${mine}/export`);
  const listed = (await api('/api/lab/experiments')).body.experiments.some((x) => x.campaign_id === mine);
  expect(a.status === 404 && c.status === 404 && !listed, `${a.status} ${c.status} listed=${listed}`);
  return { actual: `As ${B}: experiment → ${a.status}, export → ${c.status}, not listed.`, evidence: [] };
});

await journey('import', 'Import into a second workspace', 'The bundle is verified before anything is stored, then imported and opened read-only.', async () => {
  const before = (await api('/api/lab/experiments')).body.experiments.length;
  await p.click('Import', '.labbar button'); await p.click('Import a bundle file', '[role=menuitem]');
  await p.waitFor('!!document.querySelector(".importd")', 10000, 'import dialog');
  await p.setFiles('input[aria-label="bundle file to inspect"]', [exported]);
  await p.waitFor('!!document.querySelector(".importd .checks")', 60000, 'inspection'); await sleep(600);
  const t = await text('.importd');
  for (const k of ['Integrity verified', 'Evidence report']) expect(t.includes(k), `inspection lacks ${k}`);
  expect((await api('/api/lab/experiments')).body.experiments.length === before, 'stored before confirmation');
  const s = await shot('import-verified', 300);
  await p.click('Import experiment', '.importd button', true);
  await p.waitFor('/Integrity verified/.test(document.querySelector(".lab-notes")?.innerText ?? "")', 60000, 'import notice'); await sleep(2000);
  const e = await experiment(await cidNow());
  expect(e.campaign.campaign_id === mine && e.campaign.imported, `opened ${e.campaign.campaign_id}`);
  return { actual: `Integrity verified before storing; ${mine} imported into ${B}'s workspace (imported=${e.campaign.imported}).`, evidence: [s] };
});

await journey('reproduce', 'Independent reproduction', 'Run again re-executes the frozen scenarios: validated, Reproduced, reported separately from comparability.', async () => {
  await armJob();
  await p.click('Run again', '.labbar button');
  const st = await waitJob(); expect(st === 'done' || st === 'gone', `job ${st}`);
  await sleep(3000);
  const cid = await cidNow(), e = await experiment(cid);
  expect(e.campaign.kind === 'reproduction' && e.reproduction?.reproduced && e.validation.accepted === e.validation.runs, `kind ${e.campaign.kind} ${JSON.stringify(e.reproduction)}`);
  const s = await shot('reproduced', 800);
  F.reproduction = { campaign_id: cid, reproduced: e.reproduction.reproduced, validation: e.validation };
  return { actual: `${cid}: ${e.validation.accepted}/${e.validation.runs} validated; Reproduced.`, evidence: [s] };
});

await journey('add-method', 'Add a method and validate it', 'My Greedy Matching is registered (code pinned, sandboxed self-test), runs as an extension and every solution is validated.', async () => {
  const bBase = (await api('/api/lab/experiments')).body.experiments.find((x) => x.demo && x.kind === 'baseline')?.campaign_id;
  await goHash(`#/workspace/${bBase}`, 3000);
  await p.click('Add method', '.lab-right button');
  await p.waitFor('!!document.querySelector("[role=dialog]") && /Add a method/.test(document.body.innerText)', 10000, 'add method dialog');
  await p.click('Register my method', '.choice'); await sleep(1200);
  await p.eval(`(() => { const row = [...document.querySelectorAll('[role=dialog] .row, [role=dialog] li, [role=dialog] div')].reverse().find((r) => /My Greedy Matching/.test(r.innerText) && [...r.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Register')); [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Register').click(); return true; })()`);
  await p.waitFor('/Registered My Greedy Matching/.test(document.querySelector("[role=dialog]")?.innerText ?? "")', 120000, 'registration');
  await p.click('close', '[role=dialog] button'); await sleep(1500);
  await p.eval(`document.querySelector('.lab-right input[aria-label="My Greedy Matching"]').click()`); await sleep(400);
  await armJob();
  await p.click('Run added methods', '.labbar button');   // an added method: the run is an extension
  const st = await waitJob(); expect(st === 'done' || st === 'gone', `job ${st}`);
  await sleep(3000);
  const ext = await cidNow(), e = await experiment(ext);
  const row = e.results.rows.find((r) => r.method_id === 'my-greedy-matching');
  expect(ext !== bBase && row && e.validation.accepted === e.validation.runs && !row.proven_optimal, `validation ${JSON.stringify(e.validation)}`);
  const s = await shot('custom-method', 800);
  return { actual: `Extension ${ext}: ${e.validation.accepted}/${e.validation.runs} validated; My Greedy Matching ${row.totals.served} served, no optimality claimed.`, evidence: [s] };
});

await journey('mobile', 'Phone layout smoke test', 'At 375 × 812 the Workspace renders without horizontal scrolling or page errors.', async () => {
  await p.size(375, 812, 2, true); await p.goto(`${BASE}/`); await waitWorkspace(); await sleep(2500);
  const fit = await p.eval('({ sw: document.documentElement.scrollWidth, w: innerWidth })');
  const s = await shot('phone', 400);
  await p.size(W, H, 1);
  expect(fit.sw <= fit.w + 1, `page ${fit.sw} px wide for ${fit.w} px`);
  return { actual: `Page ${fit.sw} px wide for a ${fit.w} px viewport.`, evidence: [s] };
});

report.finished = new Date().toISOString();
report.summary = { total: report.journeys.length, pass: report.journeys.filter((j) => j.status === 'PASS').length };
writeFileSync(join(OUT, 'ci-journeys.json'), JSON.stringify(report, null, 1));
console.log(`${report.summary.pass}/${report.summary.total} journeys passed`);
await p.close();
process.exit(report.summary.pass === report.summary.total ? 0 : 1);
