#!/usr/bin/env node
// Browser check of the ML evaluation tab (Compare › Methods › ML evaluation), on synthetic and public data only:
//
//   MOVE_OPENLAB_DATA_DIR=<empty dir> python scripts/e2e/seed_ci.py
//   MOVE_OPENLAB_DATA_DIR=<same dir> MOVE_OPENLAB_PLUGIN_MODE=sandbox MOVE_OPENLAB_PLUGIN_DIR=<repository>/plugins \
//       move-openlab serve --host 127.0.0.1 --port 8801
//   node scripts/e2e/ml_evaluation.mjs --base http://127.0.0.1:8801 --creds <dir>/dev-credentials.json --out <out dir>
//
// It registers the example ML-assisted plug-in (plugins/example_scored_filter, kind "learned"), runs it as an extension
// of the public demonstration, and then, with real mouse and keyboard events in headless Chromium: checks "Not
// applicable" on the exact method and "Not available — import evaluation evidence" on the learned one; tries the public
// SYNTHETIC evidence file as it is (it names a placeholder method: refused in place, nothing stored); imports the same
// synthetic records as CSV with typed metadata; checks that the confusion matrix on screen is the one built into the
// example (TP 96 · FN 24 · FP 28 · TN 252); moves the threshold and checks the exploratory matrix and that the recorded
// decision is kept; withdraws the evidence. The synthetic records describe no method: the check is about the interface, not about the plug-in.
// Passwords come from the credentials file and are never printed. Writes ml-evaluation.json and screenshots.
// Exit code 1 when a step fails.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8801'), OUT = arg('out'), CREDS = arg('creds'), USER = arg('user', 'researcher1');
if (!OUT || !CREDS) { console.error('usage: ml_evaluation.mjs --base URL --creds FILE --out DIR'); process.exit(2); }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLE = join(ROOT, 'examples', 'ml-evaluation');
const PLUGIN = 'example_scored_filter', LEARNED = 'example-scored-filter-greedy', LEARNED_NAME = 'Example: scored pair filter + greedy', RIDE = 'public-ride-matching';
const KNOWN = { tp: 96, fn: 24, fp: 28, tn: 252 }, AT_07 = { tp: 79, fn: 41, fp: 11, tn: 269 };
const chrome = process.env.CHROME ?? (() => {
  const root = join(homedir(), '.cache/ms-playwright');
  const dir = existsSync(root) && readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().at(-1);
  return dir ? join(root, dir, 'chrome-linux64/chrome') : 'chromium';
})();
const SHOTS = join(OUT, 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const creds = JSON.parse(readFileSync(CREDS, 'utf8'));
const pw = (u) => (typeof creds[u] === 'string' ? creds[u] : creds[u]?.password);
const W = 1440, H = 1000;

const report = { base: BASE, started: new Date().toISOString(), steps: [], facts: {} };
const F = report.facts;
let n = 0;
const p = await launch(chrome, { width: W, height: H });
await p.size(W, H, 1);

const shot = async (name, settle = 500) => { await sleep(settle); const f = `${String(++n).padStart(2, '0')}-${name}.png`; await p.shot(join(SHOTS, f)); return f; };
const expect = (c, m) => { if (!c) throw new Error(m); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const api = (path, init = {}) => p.eval(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init)}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }))`);
const post = (path, body) => api(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const goHash = async (h, settle = 2000) => { await p.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(settle); };
// the card of one method in the ML evaluation tab, and what it shows
const card = (name) => `[...document.querySelectorAll('.ml-card')].find((c) => c.querySelector('h4')?.textContent === ${JSON.stringify(name)})`;
const cardText = (name) => p.eval(`(${card(name)})?.innerText ?? ''`);
const matrix = (name) => p.eval(`(() => { const c = ${card(name)}; if (!c) return null; const o = {}; for (const k of ['tp', 'fn', 'fp', 'tn']) { const b = c.querySelector('td[data-cell=' + k + '] b'); if (!b) return null; o[k] = Number(b.textContent.replace(/[^0-9]/g, '')); } return o; })()`);
const tile = (name, id) => p.eval(`(${card(name)})?.querySelector('[data-metric=${id}] b')?.textContent ?? null`);
const clickIn = async (name, text) => {
  const at = await p.eval(`(() => { const c = ${card(name)}; const b = c && [...c.querySelectorAll('button, summary, a')].find((x) => x.textContent.trim().includes(${JSON.stringify(text)})); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  expect(at, `no "${text}" on the card of ${name}`); await p.clickAt(at.x, at.y); await sleep(250);
};
async function signIn(user) {
  await p.clearCookies();
  await p.goto(`${BASE}/login`);
  await p.focusCss('input[name=username]'); await p.type(user);
  await p.focusCss('input[name=password]'); await p.type(pw(user));
  await p.click('Sign in', 'button');
  await p.waitFor('location.pathname === "/" && !!document.querySelector(".hdr")', 30000, `sign-in of ${user}`);
}
async function step(id, title, expected, fn) {
  const t0 = Date.now(), e0 = p.errors.length;
  const rec = { id, title, expected, actual: '', status: 'FAIL', evidence: [], ms: 0, page_errors: [] };
  try { const r = await fn(); rec.actual = r?.actual ?? ''; rec.evidence = r?.evidence ?? []; rec.status = 'PASS'; }
  catch (e) {
    rec.actual = `ERROR: ${String(e.message ?? e).slice(0, 500)}`;
    try { const f = `fail-${id}.png`; await p.shot(join(SHOTS, f)); rec.evidence.push(f); } catch { /* page gone */ }
  }
  rec.page_errors = p.errors.slice(e0); rec.ms = Date.now() - t0;
  if (rec.page_errors.length) { rec.status = 'FAIL'; rec.actual += ` · page errors: ${rec.page_errors.join(' | ').slice(0, 300)}`; }
  report.steps.push(rec);
  console.log(`${rec.status}  ${id} ${title} — ${rec.actual.slice(0, 220)}`);
  writeFileSync(join(OUT, 'ml-evaluation.json'), JSON.stringify(report, null, 1));
}
let base = '', cid = '', exactName = '';

await step('setup', 'An experiment with a learned method', 'The example ML-assisted plug-in is registered (sandboxed self-test) and run as an extension of the public demonstration; every run is validated.', async () => {
  await signIn(USER);
  await p.waitFor('!!document.querySelector(".lab-grid")', 90000, 'workspace');
  const demo = await post('/api/lab/demo');
  base = demo.body.baseline_id ?? (await api('/api/lab/experiments')).body.experiments.find((x) => x.demo && x.kind === 'baseline')?.campaign_id;
  expect(base, `no demonstration: ${JSON.stringify(demo.body).slice(0, 200)}`);
  const methods = (await api(`/api/problems/${RIDE}/methods`)).body;
  if (!JSON.stringify(methods).includes(`"${LEARNED}"`) || !(methods.methods ?? []).some((m) => m.method_id === LEARNED)) {
    const reg = await post(`/api/problems/${RIDE}/methods/register`, { plugin: PLUGIN });
    expect(reg.status === 200 || /already registered/.test(JSON.stringify(reg.body)), `registration ${reg.status} ${JSON.stringify(reg.body).slice(0, 300)}`);
    if (reg.status === 200) expect(reg.body.kind === 'learned', `kind ${reg.body.kind}`);
  }
  const ext = await post(`/api/campaigns/${base}/extend`, { methods: [[LEARNED, '1.0.0']] });
  expect(ext.status === 200, `extension ${ext.status} ${JSON.stringify(ext.body).slice(0, 300)}`);
  cid = ext.body.campaign_id;
  const job = (await post(`/api/campaigns/${cid}/execute`)).body;
  for (let i = 0; i < 600; i++) { const j = (await api(`/api/jobs/${job.job_id}`)).body; if (j.state !== 'running') { expect(j.state === 'done', `job ${j.state}`); break; } await sleep(300); }
  const e = (await api(`/api/lab/experiments/${cid}`)).body;
  const row = e.results.rows.find((r) => r.method_id === LEARNED);
  exactName = e.results.rows.find((r) => r.kind === 'exact')?.name ?? '';
  expect(row && row.kind === 'learned' && exactName && e.validation.accepted === e.validation.runs, `rows ${JSON.stringify(e.validation)} ${row?.kind}`);
  F.setup = { baseline: base, experiment: cid, learned: { name: row.name, kind: row.kind, served: row.totals.served }, validation: e.validation };
  return { actual: `Extension ${cid}: ${row.name} (kind ${row.kind}) ${row.totals.served} served; ${e.validation.accepted}/${e.validation.runs} runs validated.` };
});

await step('states', 'Not applicable and Not available', 'The exact method says "Not applicable" with the reason; the learned method without evidence says "Not available — import evaluation evidence"; no number is shown for either.', async () => {
  await goHash(`#/methods/${cid}`, 2500);
  await p.waitFor('!!document.querySelector("nav.tabs")', 30000, 'method comparison');
  await p.click('ML evaluation', 'nav.tabs button');
  await p.waitFor(`!!(${card(LEARNED_NAME)}) && !/Loading the evaluation/.test(document.querySelector('.ml-grid')?.innerText ?? '')`, 30000, 'evaluation cards');
  const exact = await cardText(exactName), learned = await cardText(LEARNED_NAME);
  expect(/Not applicable/.test(exact) && /makes no predictions/.test(exact) && !/Import evaluation evidence/.test(exact), `exact card: ${exact.slice(0, 200)}`);
  expect(await p.eval(`!(${card(exactName)}).querySelector('table.confusion, .ml-tile')`), 'the exact method shows figures');
  expect(/Not available — import evaluation evidence/.test(learned) && /labelled predictions are needed/.test(learned), `learned card: ${learned.slice(0, 200)}`);
  expect(await p.eval(`!(${card(LEARNED_NAME)}).querySelector('table.confusion, .ml-tile')`), 'figures without evidence');
  const s = await shot('not-applicable-and-not-available');
  return { actual: `Exact (“${exactName}”): Not applicable, no figure. Learned: “Not available — import evaluation evidence”, no figure.`, evidence: [s] };
});

await step('refusal', 'A refused file is explained in place', 'The public synthetic JSON names a placeholder method: the dialog shows the reason and nothing is stored.', async () => {
  await clickIn(LEARNED_NAME, 'Import evaluation evidence');
  await p.waitFor('!!document.querySelector(".ml-import")', 10000, 'import dialog');
  const dialog = await p.eval('document.querySelector(".ml-import").innerText');
  expect(/What is stored/.test(dialog) && /SHA-256/.test(dialog) && /not included in an exported bundle/.test(dialog), 'the dialog does not say what is stored');
  await p.setFiles('input[aria-label="evidence file"]', [join(EXAMPLE, 'synthetic-binary-evidence.json')]);
  await p.waitFor('/JSON evidence document/.test(document.querySelector(".ml-import").innerText)', 10000, 'file chosen');
  await p.click('Import evidence', '.ml-import button');
  await p.waitFor('!!document.querySelector(".ml-import [role=alert]")', 20000, 'refusal');
  const alert = await p.eval('document.querySelector(".ml-import [role=alert]").innerText');
  expect(/nothing was stored/.test(alert) && /synthetic-example-classifier/.test(alert) && /can only be imported for the method it names/.test(alert), `alert: ${alert}`);
  const ev = (await api(`/api/lab/experiments/${cid}/evaluation?method_id=${LEARNED}`)).body;
  expect(ev.available === false && ev.evaluations.length === 0, 'something was stored');
  const s = await shot('refused-in-place', 300);
  return { actual: `Refused in place: “${alert.replace(/\s+/g, ' ').slice(0, 170)}”; still no evaluation.`, evidence: [s] };
});

await step('import', 'Import evidence and read the matrix', `The synthetic records imported as CSV with typed metadata give TP ${KNOWN.tp} · FN ${KNOWN.fn} · FP ${KNOWN.fp} · TN ${KNOWN.tn} on screen, with provenance and the "imported evidence" badge.`, async () => {
  await p.setFiles('input[aria-label="evidence file"]', [join(EXAMPLE, 'synthetic-binary-evidence.csv')]);
  await p.waitFor('!!document.querySelector(".ml-import .ml-form")', 10000, 'metadata fields');
  const needed = await p.eval('document.querySelector(".ml-import [role=status]")?.innerText ?? ""');
  expect(/Still needed/.test(needed) && /Model name/.test(needed) && /Threshold/.test(needed), `missing fields not listed: ${needed}`);
  expect(await p.eval('[...document.querySelectorAll(".ml-import button")].find((b) => /Import evidence/.test(b.textContent)).disabled'), 'import enabled without metadata');
  const fields = { 'Model name': 'SYNTHETIC score generator (not a model)', 'Model version': '1.0.0', 'Feature pipeline name': 'none (synthetic)', 'Feature pipeline version': '1.0.0',
    'Feature pipeline description': 'No features: every score is drawn at random.', 'Dataset identifier': 'synthetic-binary-example-v1', 'Split': 'synthetic',
    'Population': 'SYNTHETIC — 400 artificial records; not a mobility result and not the output of any model', 'What one record is': 'one artificial record',
    'Meaning of label 1': 'label 1 of the synthetic generator (no real-world meaning)', 'Threshold': '0.5', 'Notes': 'SYNTHETIC EXAMPLE imported by the browser check: these figures evaluate no method.' };
  for (const [label, value] of Object.entries(fields)) await p.fill(`.ml-import [aria-label="${label}"]`, value);
  await sleep(300);
  const s1 = await shot('import-dialog-csv', 200);
  await p.click('Import evidence', '.ml-import button');
  await p.waitFor(`!document.querySelector(".ml-import") && !!(${card(LEARNED_NAME)})?.querySelector('table.confusion')`, 30000, 'imported evaluation');
  await sleep(600);
  const m = await matrix(LEARNED_NAME), text = await cardText(LEARNED_NAME);
  expect(same(m, KNOWN), `matrix on screen ${JSON.stringify(m)}`);
  for (const k of ['imported evidence', 'True positive', 'False negative', 'False positive', 'True negative', 'synthetic-binary-example-v1', 'score ≥ 0.5', 'SYNTHETIC score generator', 'none (synthetic)', 'sha256', 'Evidence imported and stored'])
    expect(text.includes(k), `the card lacks “${k}”`);
  const tiles = { accuracy: await tile(LEARNED_NAME, 'accuracy'), precision: await tile(LEARNED_NAME, 'precision'), recall: await tile(LEARNED_NAME, 'recall'), f1: await tile(LEARNED_NAME, 'f1'), roc_auc: await tile(LEARNED_NAME, 'roc_auc') };
  expect(tiles.accuracy === '87 %' && tiles.precision === '77.42 %' && tiles.recall === '80 %' && tiles.f1 === '78.69 %' && /%$/.test(tiles.roc_auc ?? ''), `tiles ${JSON.stringify(tiles)}`);
  const ev = (await api(`/api/lab/experiments/${cid}/evaluation?method_id=${LEARNED}`)).body.evaluations[0];
  expect(ev.origin === 'imported' && same(ev.confusion, KNOWN) && ev.evidence_sha256.length === 64, 'API disagrees with the screen');
  expect(text.includes(ev.evidence_sha256.slice(0, 16)), 'evidence digest not shown');
  expect(await p.eval(`!!(${card(LEARNED_NAME)}).querySelector('.ml-curve svg polyline.c-precision') && !!(${card(LEARNED_NAME)}).querySelector('.ml-threshold input[type=range]')`), 'no threshold control or curve');
  const e = (await api(`/api/lab/experiments/${cid}`)).body;
  F.import = { matrix: m, tiles, evidence_sha256: ev.evidence_sha256, records: ev.candidates, experiment_locked: e.campaign.locked };
  const s2 = await shot('confusion-matrix-and-metrics', 300);
  return { actual: `On screen: TP ${m.tp} · FN ${m.fn} · FP ${m.fp} · TN ${m.tn}; accuracy ${tiles.accuracy}, precision ${tiles.precision}, recall ${tiles.recall}, F1 ${tiles.f1}; evidence ${ev.evidence_sha256.slice(0, 16)}….`, evidence: [s1, s2] };
});

await step('threshold', 'Explore another threshold', `At 0.7 the matrix becomes TP ${AT_07.tp} · FN ${AT_07.fn} · FP ${AT_07.fp} · TN ${AT_07.tn}, flagged exploratory; the recorded decision stays ${KNOWN.tp}/${KNOWN.fn}/${KNOWN.fp}/${KNOWN.tn} and comes back with "Recorded".`, async () => {
  await p.eval(`(${card(LEARNED_NAME)}).querySelector('.ml-threshold').scrollIntoView({ block: 'center' })`);
  await p.fill(`.ml-threshold input[type=number]`, '0.7');
  await p.waitFor(`/exploratory threshold/.test((${card(LEARNED_NAME)}).innerText)`, 20000, 'exploratory badge');
  await sleep(500);
  const m = await matrix(LEARNED_NAME), text = await cardText(LEARNED_NAME);
  expect(same(m, AT_07), `matrix at 0.7 ${JSON.stringify(m)}`);
  expect(/not the recorded decision/.test(text) && text.includes(`TP ${KNOWN.tp} · FP ${KNOWN.fp} · TN ${KNOWN.tn} · FN ${KNOWN.fn}`), 'the recorded decision is not kept on screen');
  expect(await p.eval(`!!(${card(LEARNED_NAME)}).querySelector('.ml-curve .mark.explored')`), 'explored threshold not marked on the curve');
  const precision = await tile(LEARNED_NAME, 'precision');
  const recordedNow = (await api(`/api/lab/experiments/${cid}/evaluation?method_id=${LEARNED}`)).body.evaluations[0];
  expect(same(recordedNow.confusion, KNOWN) && recordedNow.exploratory === false, 'exploring changed the stored evaluation');
  const s1 = await shot('exploratory-threshold', 300);
  // the slider moves the threshold too (keyboard on the range input)
  await p.focusCss(`.ml-threshold input[type=range]`);
  for (let i = 0; i < 4; i++) await p.key('ArrowRight', 'ArrowRight', 39);
  await sleep(900);
  const moved = await p.eval(`document.querySelector('.ml-threshold input[type=number]').value`);
  expect(Number(moved) > 0.7 && Number(moved) < 0.75, `slider did not move the threshold: ${moved}`);
  await clickIn(LEARNED_NAME, 'Recorded: 0.5');
  await p.waitFor(`!/exploratory threshold/.test((${card(LEARNED_NAME)}).innerText)`, 10000, 'back to the recorded decision');
  await sleep(300);
  const back = await matrix(LEARNED_NAME);
  expect(same(back, KNOWN), `matrix after reset ${JSON.stringify(back)}`);
  F.threshold = { at_0_7: m, precision_at_0_7: precision, slider_moved_to: Number(moved), after_reset: back };
  return { actual: `At 0.7: TP ${m.tp} · FN ${m.fn} · FP ${m.fp} · TN ${m.tn} (precision ${precision}), flagged exploratory; slider → ${moved}; “Recorded: 0.5” restores ${back.tp}/${back.fn}/${back.fp}/${back.tn}.`, evidence: [s1] };
});

await step('views', 'Dark theme, French, and the record is untouched', 'The tab reads correctly in the dark theme and in French; the exact method is still "Not applicable"; the experiment record carries no evidence.', async () => {
  await p.eval(`document.documentElement.setAttribute('data-theme', 'dark')`);
  const dark = await p.eval(`(() => { const c = ${card(LEARNED_NAME)}; const bg = (e) => getComputedStyle(e).backgroundColor; return { card: bg(c), tile: bg(c.querySelector('.ml-tile')), text: getComputedStyle(c.querySelector('.ml-tile b')).color, curve: bg(c.querySelector('.ml-curve svg')) }; })()`);
  const lum = (rgb) => { const v = rgb.match(/[\d.]+/g).map(Number); return (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255; };
  expect(lum(dark.card) < 0.25 && lum(dark.tile) < 0.25 && lum(dark.curve) < 0.25 && lum(dark.text) > 0.6, `dark theme colours ${JSON.stringify(dark)}`);
  await p.eval(`(${card(LEARNED_NAME)}).scrollIntoView({ block: 'start' })`);
  const s1 = await shot('dark-theme', 500);
  await p.eval(`document.documentElement.removeAttribute('data-theme'); sessionStorage.setItem('move-openlab-lang', 'fr'); location.reload()`);
  await p.waitFor('!!document.querySelector("nav.tabs")', 30000, 'reload');
  await p.click('Évaluation ML', 'nav.tabs button');
  await p.waitFor(`!!(${card(LEARNED_NAME)})?.querySelector('table.confusion')`, 30000, 'evaluation in French');
  const fr = await cardText(LEARNED_NAME), frExact = await cardText(exactName);
  for (const k of ['preuves importées', 'Vrai positif', 'Faux négatif', 'Seuil', 'Importer des preuves d’évaluation', 'Chaîne de caractéristiques']) expect(fr.includes(k), `French card lacks “${k}”`);
  expect(/Sans objet/.test(frExact), `exact card in French: ${frExact.slice(0, 120)}`);
  expect(same(await matrix(LEARNED_NAME), KNOWN), 'matrix changed with the language');
  const s2 = await shot('french', 400);
  await p.eval(`sessionStorage.setItem('move-openlab-lang', 'en'); location.reload()`);
  await p.waitFor('!!document.querySelector("nav.tabs")', 30000, 'reload');
  const record = (await api(`/api/campaigns/${cid}/record.json`)).body;
  expect(!/evidence|ml_evaluation/.test(typeof record === 'string' ? record : JSON.stringify(record)), 'the experiment record mentions the evidence');
  return { actual: 'Dark theme: dark surfaces, light text; French: translated labels, same matrix; the experiment record does not mention the evidence.', evidence: [s1, s2] };
});

await step('withdraw', 'Withdraw the evidence', 'Withdrawing hides the evidence (the card is "Not available" again and says one is withdrawn); the stored file can still be downloaded.', async () => {
  await p.click('ML evaluation', 'nav.tabs button');
  await p.waitFor(`!!(${card(LEARNED_NAME)})?.querySelector('table.confusion')`, 30000, 'evaluation');
  const sha = (await api(`/api/lab/experiments/${cid}/evaluation?method_id=${LEARNED}`)).body.evaluations[0].evidence_sha256;
  await clickIn(LEARNED_NAME, 'Class balance, labels, import and notes');
  const details = await cardText(LEARNED_NAME);
  expect(details.includes(sha) && /cannot verify that they are the method’s real predictions/.test(details) && /Download the stored evidence/.test(details), 'details lack the digest, the caveat or the download');
  await clickIn(LEARNED_NAME, 'Withdraw this evidence');
  expect(/The file is kept/.test(await cardText(LEARNED_NAME)), 'no confirmation asked');
  const s1 = await shot('withdraw-confirmation', 200);
  await p.eval(`(() => { const c = ${card(LEARNED_NAME)}; [...c.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Withdraw').click(); return true; })()`);
  await p.waitFor(`/Not available — import evaluation evidence/.test((${card(LEARNED_NAME)})?.innerText ?? '')`, 20000, 'card without evidence');
  const text = await cardText(LEARNED_NAME);
  expect(/1 imported evidence withdrawn/.test(text) && await p.eval(`!(${card(LEARNED_NAME)}).querySelector('table.confusion, .ml-tile')`), `after withdrawal: ${text.slice(0, 200)}`);
  const ev = (await api(`/api/lab/experiments/${cid}/evaluation?method_id=${LEARNED}`)).body, file = await api(`/api/lab/experiments/${cid}/evaluation/evidence/${sha}`);
  expect(ev.available === false && ev.withdrawn === 1 && file.status === 200, `API after withdrawal: ${ev.available} ${ev.withdrawn} ${file.status}`);
  return { actual: `Evidence ${sha.slice(0, 16)}… withdrawn: the card shows no figure and “1 imported evidence withdrawn”; the stored file still downloads (${file.status}).`, evidence: [s1] };
});

report.finished = new Date().toISOString();
report.summary = { total: report.steps.length, pass: report.steps.filter((j) => j.status === 'PASS').length };
writeFileSync(join(OUT, 'ml-evaluation.json'), JSON.stringify(report, null, 1));
console.log(`${report.summary.pass}/${report.summary.total} steps passed`);
await p.close();
process.exit(report.summary.pass === report.summary.total ? 0 : 1);
