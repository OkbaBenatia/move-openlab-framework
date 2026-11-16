#!/usr/bin/env node
// Participant and vehicle authoring in the scenario editor, on synthetic data only (the data directory made by
// scripts/e2e/seed_ci.py):
//
//   MOVE_OPENLAB_DATA_DIR=<empty dir> python scripts/e2e/seed_ci.py
//   MOVE_OPENLAB_DATA_DIR=<same dir> MOVE_OPENLAB_TILE_URL=none move-openlab serve --host 127.0.0.1 --port 8802
//   node scripts/e2e/authoring.mjs --base http://127.0.0.1:8802 --creds <dir>/dev-credentials.json --out <out dir>
//
// Checks: the Randomize dialog (ratio, shares, refusals, a rectangle, the same seed gives the same places) and the
// expected numbers of driver and rider markers; a palette item dragged onto the map (pointer events) adds a
// participant; a rider's details (a time) and a vehicle's capacity are changed and saved; a marker is dragged and
// snapped, and refused outside the area; Undo (button and Ctrl+Z) and Cancel; the scenario is saved and run and every
// result is validated; at phone width (375 px) tap-to-place adds a participant. Real mouse, touch and keyboard events
// in headless Chromium. Passwords come from the credentials file and are never printed. Writes authoring.json and
// screenshots; exit code 1 when a check fails.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8802'), OUT = arg('out'), CREDS = arg('creds');
const USER = 'researcher1', AREA = 'Synthetic grid';
if (!OUT || !CREDS) { console.error('usage: authoring.mjs --base URL --creds FILE --out DIR'); process.exit(2); }
const chrome = process.env.CHROME ?? (() => {
  const root = join(homedir(), '.cache/ms-playwright');
  const dir = existsSync(root) && readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().at(-1);
  return dir ? join(root, dir, 'chrome-linux64/chrome') : 'chromium';
})();
mkdirSync(OUT, { recursive: true });
const creds = JSON.parse(readFileSync(CREDS, 'utf8'));
const pw = (u) => (typeof creds[u] === 'string' ? creds[u] : creds[u]?.password);
const W = 1440, H = 900;

const report = { base: BASE, started: new Date().toISOString(), checks: [], facts: {} };
const F = report.facts;
let n = 0;
const p = await launch(chrome, { width: W, height: H });
await p.size(W, H, 1);

const shot = async (name, settle = 500) => { await sleep(settle); const f = `${String(++n).padStart(2, '0')}-${name}.png`; await p.shot(join(OUT, f)); return f; };
const expect = (c, m) => { if (!c) throw new Error(m); };
const text = (css = 'body') => p.eval(`(document.querySelector(${JSON.stringify(css)})?.innerText ?? '')`);
const api = (path, init = {}) => p.eval(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }))`);
const choose = (css, value) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) throw new Error('no select ' + ${JSON.stringify(css)});
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
const next = async () => { await p.click('Next', '.wizard-foot button'); await sleep(700); };
const count = (css) => p.eval(`document.querySelectorAll(${JSON.stringify(css)}).length`);
const centre = (css) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const mapAt = (fx, fy) => p.eval(`(() => { const r = document.querySelector('.wizard-map .leaflet-container').getBoundingClientRect(); return { x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy} }; })()`);
const MODAL = '[role=dialog][aria-label="randomize participants"]', PANEL = '.wizard-map .pp-wrap:not([hidden]) .pp-card';
const markers = async () => ({ drivers: await count('.wizard-map .mk[data-kind=driver]'), riders: await count('.wizard-map .mk[data-kind=rider]') });
/** Start and end places of every participant of one role, as the editor's list shows them. */
const places = (role) => p.eval(`Object.fromEntries([...document.querySelectorAll('.wizard table[aria-label=${role}] tbody tr')].map((r) => [r.cells[0].innerText.trim(), [...r.cells[1].querySelectorAll('button')].map((b) => b.dataset.at)]))`);
const times = (role) => p.eval(`Object.fromEntries([...document.querySelectorAll('.wizard table[aria-label=${role}] tbody tr')].map((r) => [r.cells[0].innerText.trim(), [r.cells[2].querySelector('input').value, r.cells[3].querySelector('input').value]]))`);
const summary = (d, r) => p.waitFor(`new RegExp('^${d} drivers · ${r} riders').test(document.querySelector('[aria-label="preview summary"]')?.innerText ?? '')`, 60000, `preview of ${d} drivers and ${r} riders`);
const openRandomize = async () => { await p.click('Randomize…', '.wizard .authoring-bar button'); await p.waitFor(`!!document.querySelector(${JSON.stringify(MODAL)})`, 10000, 'Randomize dialog'); await sleep(300); };
const field = (label, value) => p.fill(`${MODAL} input[aria-label="${label}"]`, String(value));
const generate = async () => { await p.click('Generate', `${MODAL} button`, true); await p.waitFor(`!document.querySelector(${JSON.stringify(MODAL)})`, 60000, 'generation'); await sleep(900); };
// (a marker is never scrolled into view: that would scroll the map's own container)
const marker = (ref, kind) => p.eval(`(() => { const e = document.querySelector('.wizard-map .mk[data-ref="${ref}"][data-kind="${kind}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
/** A marker of this kind that no other marker covers (its centre is its own), away from the map's edges: { ref, x, y }. */
const freeMarker = (kind, not = []) => p.eval(`(() => { const box = document.querySelector('.wizard-map .leaflet-container').getBoundingClientRect();
  for (const e of document.querySelectorAll('.wizard-map .mk[data-kind="${kind}"]')) { const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (${JSON.stringify(not)}.includes(e.dataset.ref) || x < box.left + 60 || x > box.right - 380 || y < box.top + 60 || y > box.bottom - 60) continue;
    if (e.contains(document.elementFromPoint(x, y))) return { ref: e.dataset.ref, x, y }; }
  return null; })()`);
const armJob = () => p.eval(`(() => { window.__jobSeen = false; const o = new MutationObserver(() => { if (document.querySelector('.job')) { window.__jobSeen = true; o.disconnect(); } }); o.observe(document.body, { childList: true, subtree: true }); return true; })()`);
async function waitJob(timeout = 300000) {
  await p.waitFor('window.__jobSeen === true || !!document.querySelector(".job")', 30000, 'job progress');
  await p.waitFor('["done","error","cancelled","interrupted"].includes(document.querySelector(".job")?.dataset.state) || !document.querySelector(".job")', timeout, 'job end');
  return p.eval('document.querySelector(".job")?.dataset.state ?? "gone"');
}
const waitWorkspace = () => p.waitFor('!!document.querySelector(".lab-grid") && !/Loading the demonstration/.test(document.querySelector(".lab-notes")?.innerText ?? "")', 120000, 'workspace');
async function check(id, title, expected, fn) {
  const t0 = Date.now(), e0 = p.errors.length;
  const rec = { id, title, expected, actual: '', status: 'FAIL', evidence: [], ms: 0, page_errors: [] };
  try {
    const r = await fn();
    rec.actual = r?.actual ?? ''; rec.evidence = r?.evidence ?? []; rec.status = 'PASS';
  } catch (e) {
    rec.actual = `ERROR: ${String(e.message ?? e).slice(0, 500)}`;
    try { const f = `fail-${id}.png`; await p.shot(join(OUT, f)); rec.evidence.push(f); } catch { /* page gone */ }
  }
  rec.page_errors = p.errors.slice(e0); rec.ms = Date.now() - t0;
  if (rec.page_errors.length) { rec.status = 'FAIL'; rec.actual += ` · page errors: ${rec.page_errors.join(' | ').slice(0, 300)}`; }
  report.checks.push(rec);
  console.log(`${rec.status}  ${id} ${title} — ${rec.actual.slice(0, 220)}`);
  writeFileSync(join(OUT, 'authoring.json'), JSON.stringify(report, null, 1));
}
let mine = '';

await check('A0', 'Sign in and open the editor', 'The researcher signs in, opens Generate on the synthetic grid and reaches the participants step.', async () => {
  await p.clearCookies(); await p.goto(`${BASE}/login`);
  await p.focusCss('input[name=username]'); await p.type(USER);
  await p.focusCss('input[name=password]'); await p.type(pw(USER));
  await p.click('Sign in', 'button');
  await p.waitFor('location.pathname === "/" && !!document.querySelector(".hdr")', 30000, 'sign-in');
  await waitWorkspace(); await sleep(2000);
  await p.click('Generate', '.labbar button');
  await p.waitFor('!!document.querySelector(".wizard .wizard-map .leaflet-container")', 15000, 'wizard');
  const area = (await api('/api/geo/areas')).body.areas.find((a) => a.name === AREA && a.network_id);
  expect(area, 'no synthetic grid area');
  F.area = { bbox: area.bbox, network: area.network_id };
  await choose('select[aria-label=area]', area.area_id); await sleep(1200);
  await p.click('Place participants on the map', '.wizard label'); await next();
  expect(await count('.wizard .palette .pal-item') === 5, 'palette without its five items');
  const s = await shot('participants-step');
  return { actual: `${USER} signed in; editor on “${AREA}”, participants step with the palette (Driver, Rider, three vehicle types).`, evidence: [s] };
});

await check('A0b', 'The list buttons still place participants by clicks', 'Add driver / Add rider, then two clicks on the map, place a participant as before; a point outside the area is refused in the participant\'s row and can be placed again; the route preview works.', async () => {
  const clickMap = async (fx, fy) => { const pt = await mapAt(fx, fy); await p.clickAt(pt.x, pt.y); await sleep(700); };
  await p.click('Add driver', '.wizard button');
  expect(/Click the map to place the start point of D1/.test(await text('.wizard')), 'no placement prompt for D1');
  await clickMap(0.38, 0.42); await clickMap(0.56, 0.58);
  await p.click('Add rider', '.wizard button'); await clickMap(0.44, 0.47); await clickMap(0.52, 0.55);
  await p.click('Add rider', '.wizard button'); await clickMap(0.35, 0.6); await clickMap(0.3, 0.012);          // the second point lies outside the area
  await p.waitFor('[...document.querySelectorAll(".wizard table[aria-label=riders] tr")].some((r) => /R2/.test(r.innerText) && /from the road network/.test(r.innerText))', 20000, 'the refusal in the row of R2');
  const refused = await p.eval(`[...document.querySelectorAll('.wizard table[aria-label=riders] tr')].find((r) => /R2/.test(r.innerText))?.innerText.replace(/\\s+/g, ' ')`);
  expect(/end point of R2/.test(await text('.wizard .authoring-hint')), 'the refused point is no longer asked for');
  await clickMap(0.5, 0.36);
  await summary(1, 2);
  await p.click('Route', '.wizard table[aria-label=drivers] button');
  await p.waitFor('/ min ·|km/.test(document.querySelector(".wizard table[aria-label=drivers]")?.innerText ?? "")', 30000, 'route preview');
  const s = await shot('list-buttons');
  // start again from an empty scenario for the next checks (Undo takes every step back)
  for (let i = 0; i < 12 && await p.eval(`!document.querySelector('.wizard .authoring-bar button[aria-label=undo]').disabled`); i++) { await p.click('Undo', '.wizard .authoring-bar button', true); await sleep(250); }
  const left = { drivers: await count('.wizard table[aria-label=drivers] tbody tr'), riders: await count('.wizard table[aria-label=riders] tbody tr') };
  expect(left.drivers === 0 && left.riders === 0, `Undo left ${JSON.stringify(left)}`);
  return { actual: `D1, R1 and R2 placed by clicks (1 driver · 2 riders previewed, route shown); outside point refused in the row: “${refused?.slice(0, 120)}”; Undo back to an empty scenario.`, evidence: [s] };
});

await check('A1', 'Randomize: one dialog, checked before and by the server', 'The dialog opens with defaults; the ratio sets the number of drivers; shares that do not sum to 100 and an impossible trip length are refused with a message.', async () => {
  await openRandomize();
  await field('number of drivers', 6); await field('number of riders', 9); await sleep(200);
  const r0 = await p.eval(`document.querySelector('${MODAL} input[aria-label="driver-to-rider ratio"]').value`);
  await field('driver-to-rider ratio', 1); await sleep(300);
  const d1 = await p.eval(`document.querySelector('${MODAL} input[aria-label="number of drivers"]').value`);
  expect(r0 === '0.67' && d1 === '9', `ratio ${r0}, drivers after ratio 1: ${d1}`);
  await field('number of drivers', 6); await sleep(200);
  await field('combustion share', 50); await field('electric share', 30); await sleep(300);
  const sum = await text(`${MODAL} [role=alert]`), off = await p.eval(`[...document.querySelectorAll('${MODAL} button')].find((b) => b.innerText.trim() === 'Generate').disabled`);
  expect(/add up to 80 %, not 100 %/.test(sum) && off, `shares not refused: “${sum}” disabled=${off}`);
  const s1 = await shot('randomize-shares-refused', 200);
  await field('electric share', 50); await field('vehicle capacity default', 0); await sleep(300);
  const cap = await text(`${MODAL} [role=alert]`);
  expect(/at least 1 seat/.test(cap), `capacity 0 not refused: “${cap}”`);
  await field('vehicle capacity default', 3); await field('minimum trip km', 50); await sleep(300);
  await p.click('Generate', `${MODAL} button`, true);
  await p.waitFor(`/too small for trips of at least 50000 m/.test(document.querySelector('${MODAL} [role=alert]')?.innerText ?? '')`, 20000, 'the server refusal');
  const refused = await text(`${MODAL} [role=alert]`);
  F.refusals = { shares: sum, capacity: cap, server: refused };
  return { actual: `Ratio 0.67 → typed 1 → 9 drivers; “${sum}”; “${cap}”; server: “${refused}”.`, evidence: [s1] };
});

await check('A2', 'Generate: participants and vehicles on the map, reproducible', 'Generate puts 6 driver and 9 rider markers on the editor map with a 50/50 combustion/electric fleet of 3 seats; the same seed gives the same places, another seed other places; a rectangle keeps every point inside it.', async () => {
  await field('minimum trip km', 1); await field('departures from', '07:30'); await field('departures to', '08:00'); await field('random seed', 42); await sleep(300);
  const s0 = await shot('randomize-dialog', 200);
  await generate(); await summary(6, 9);
  const m = await markers();
  expect(m.drivers === 6 && m.riders === 9, `markers ${JSON.stringify(m)}`);
  const a = { d: await places('drivers'), r: await places('riders') };
  const glyphs = await p.eval(`[...document.querySelectorAll('.wizard-map .mk[data-kind=driver]')].map((e) => e.dataset.glyph).sort().join('')`);
  expect(glyphs === 'CCCEEE', `fleet ${glyphs}`);
  const t = await times('drivers');
  expect(Object.values(t).every(([e, l]) => e >= '07:30' && e <= '08:00' && l > e), `windows ${JSON.stringify(t)}`);
  const note = await text('[aria-label="generation summary"]');
  expect(/seed 42/.test(note), `no generation summary: ${note}`);
  const s1 = await shot('generated-on-map');
  // a rectangle: the middle half of the area
  await openRandomize(); await p.click('Rectangle', `${MODAL} .seg button`, true);
  await p.waitFor(`!!document.querySelector('${MODAL} .rz-map .leaflet-container .box-handle')`, 10000, 'the rectangle on the small map'); await sleep(600);
  const s2 = await shot('randomize-rectangle', 300);
  await field('random seed', 7); await generate(); await summary(6, 9);
  const [s, w, nn, e] = F.area.bbox, box = [s + (nn - s) / 4, w + (e - w) / 4, nn - (nn - s) / 4, e - (e - w) / 4];
  const all = [...Object.values(await places('drivers')), ...Object.values(await places('riders'))].flat().map((x) => x.split(',').map(Number));
  expect(all.length === 30 && all.every(([la, lo]) => la >= box[0] - 1e-4 && la <= box[2] + 1e-4 && lo >= box[1] - 1e-4 && lo <= box[3] + 1e-4), 'a point lies outside the rectangle');
  const s3 = await shot('generated-in-rectangle');
  await p.click('Undo', '.wizard .authoring-bar button', true); await sleep(900);
  const back = { d: await places('drivers'), r: await places('riders') };
  expect(JSON.stringify(back) === JSON.stringify(a), 'Undo did not bring the seed-42 participants back');
  // another seed, then the first seed again with the same settings (the scenario used by the next checks)
  await openRandomize(); await field('random seed', 43); await generate(); await summary(6, 9);
  const b = { d: await places('drivers'), r: await places('riders') };
  await openRandomize();
  expect(await p.eval(`document.querySelector('${MODAL} input[aria-label="number of drivers"]').value`) === '6', 'the dialog forgot the counts');
  await field('random seed', 42); await field('combustion share', 50); await field('electric share', 50); await field('vehicle capacity default', 3); await field('minimum trip km', 1);
  await field('departures from', '07:30'); await field('departures to', '08:00'); await generate(); await summary(6, 9);
  const c = { d: await places('drivers'), r: await places('riders') };
  expect(JSON.stringify(a) === JSON.stringify(c) && JSON.stringify(a) !== JSON.stringify(b), 'seed 42 twice did not give the same places, or seed 43 gave the same');
  F.generated = { markers: m, fleet: glyphs, first_driver: a.d.D1 };
  return { actual: `6 driver and 9 rider markers, fleet ${glyphs}; rectangle: 30 points inside; Undo restores the previous generation; seed 43 different, seed 42 again identical.`, evidence: [s0, s1, s2, s3] };
});

await check('B1', 'Drag a palette item onto the map', 'A Rider dragged from the palette onto the map (pointer events) gets its pick-up point there, then its destination by a click, then a small form; saving adds it. An Electric item adds a driver with an electric vehicle.', async () => {
  const from = await centre('.wizard .pal-item[data-item=rider]'), drop = await mapAt(0.42, 0.44);
  await p.drag(from.x, from.y, drop.x, drop.y); await sleep(900);
  expect(/end point of R10/.test(await text('.wizard .authoring-hint')), `no destination prompt: ${await text('.wizard .authoring-hint')}`);
  const s1 = await shot('palette-dropped', 200);
  const dest = await mapAt(0.6, 0.62); await p.clickAt(dest.x, dest.y);
  await p.waitFor(`!!document.querySelector(${JSON.stringify(PANEL)})`, 15000, 'the new rider form'); await sleep(300);
  expect(/New rider · R10/.test(await text(PANEL)), `form title: ${(await text(PANEL)).slice(0, 60)}`);
  await p.fill(`${PANEL} input[aria-label="earliest pick-up"]`, '07:40'); await p.fill(`${PANEL} input[aria-label="latest pick-up"]`, '08:05');
  const s2 = await shot('new-rider-form', 200);
  await p.click('Save participant', `${PANEL} button`);
  await p.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, 15000, 'form saved'); await summary(6, 10);
  const r10 = (await places('riders')).R10, t10 = (await times('riders')).R10;
  expect(r10 && r10[0] !== r10[1] && t10[0] === '07:40' && t10[1] === '08:05', `R10 ${JSON.stringify(r10)} ${JSON.stringify(t10)}`);
  // every point is a node of the 0.004° grid: snapped to the road network
  const onGrid = r10.flatMap((x) => x.split(',').map(Number)).every((v) => Math.abs(v / 0.004 - Math.round(v / 0.004)) < 1e-3);
  expect(onGrid, `R10 not snapped: ${r10}`);
  const ev = await centre('.wizard .pal-item[data-item="vehicle:electric"]'), drop2 = await mapAt(0.36, 0.6);
  await p.drag(ev.x, ev.y, drop2.x, drop2.y); await sleep(900);
  const dest2 = await mapAt(0.62, 0.4); await p.clickAt(dest2.x, dest2.y);
  await p.waitFor(`/New driver · D7/.test(document.querySelector(${JSON.stringify(PANEL)})?.innerText ?? '')`, 15000, 'the new driver form'); await sleep(300);
  await p.click('Save participant', `${PANEL} button`);
  await p.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, 15000, 'driver saved'); await summary(7, 10);
  const g7 = await p.eval(`document.querySelector('.wizard-map .mk[data-ref=D7][data-kind=driver]')?.dataset.glyph`);
  expect(g7 === 'E', `D7 vehicle glyph ${g7}`);
  const m = await markers();
  expect(m.drivers === 7 && m.riders === 10, `markers ${JSON.stringify(m)}`);
  const s3 = await shot('after-palette');
  F.dragged = { R10: r10, D7: (await places('drivers')).D7 };
  return { actual: `R10 dragged from the palette, snapped (${r10.join(' → ')}), 07:40–08:05; D7 added with an electric vehicle; 7 driver and 10 rider markers.`, evidence: [s1, s2, s3] };
});

await check('B2', 'Details of a rider and capacity of a vehicle', 'A click on a rider marker opens its details; a too-early latest arrival is refused with what to change; a new pick-up time is saved. A driver\'s vehicle gets another capacity.', async () => {
  const rm = await freeMarker('rider'); expect(rm, 'no rider marker to click');
  const R = rm.ref; await p.clickAt(rm.x, rm.y);
  await p.waitFor(`new RegExp('Rider · ${R}$', 'm').test(document.querySelector(${JSON.stringify(PANEL)})?.innerText ?? '')`, 15000, `details of ${R}`); await sleep(300);
  const before = (await times('riders'))[R];
  await p.fill(`${PANEL} input[aria-label="latest arrival"]`, before[0]);
  await p.click('Save participant', `${PANEL} button`);
  await p.waitFor(`/earlier than the direct travel time allows/.test(document.querySelector('${PANEL} [role=alert]')?.innerText ?? '')`, 15000, 'the refusal');
  const refusal = await text(`${PANEL} [role=alert]`);
  const s1 = await shot('rider-arrival-refused', 200);
  await p.fill(`${PANEL} input[aria-label="latest arrival"]`, ''); await p.fill(`${PANEL} input[aria-label="latest pick-up"]`, '08:44');
  await p.click('Save participant', `${PANEL} button`);
  await p.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, 15000, `${R} saved`); await sleep(500);
  const after = (await times('riders'))[R];
  expect(after[0] === before[0] && after[1] === '08:44', `${R} ${before} → ${after}`);
  const dm = await freeMarker('driver', ['D7']); expect(dm, 'no driver marker to click');
  const D = dm.ref; await p.clickAt(dm.x, dm.y);
  await p.waitFor(`new RegExp('Driver · ${D}$', 'm').test(document.querySelector(${JSON.stringify(PANEL)})?.innerText ?? '')`, 15000, `details of ${D}`); await sleep(300);
  const cap0 = await p.eval(`document.querySelector('${PANEL} input[aria-label="vehicle capacity"]').value`);
  await p.fill(`${PANEL} input[aria-label="vehicle capacity"]`, '0'); await p.click('Save participant', `${PANEL} button`); await sleep(300);
  const capRefused = await text(`${PANEL} [role=alert]`);
  expect(/at least 1 seat/.test(capRefused), `capacity 0 accepted: ${capRefused}`);
  await p.fill(`${PANEL} input[aria-label="vehicle capacity"]`, '2');
  const s2 = await shot('driver-details', 200);
  await p.click('Save participant', `${PANEL} button`);
  await p.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, 15000, `${D} saved`); await sleep(500);
  const vehicles = () => p.eval(`Object.fromEntries([...document.querySelectorAll('.wizard select[aria-label^="vehicle of "]')].map((e) => [e.getAttribute('aria-label').slice(11), e.value]))`);
  const v = await vehicles();
  expect(cap0 === '3' && /-2p$/.test(v[D]) && Object.entries(v).filter(([id]) => id !== D && id !== 'D7').every(([, x]) => /-3p$/.test(x)), `capacity ${cap0}; vehicles ${JSON.stringify(v)}`);
  F.details = { rider: R, times: { before, after }, refusal, driver: D, vehicle: v[D] };
  return { actual: `${R} pick-up until ${before[1]} → 08:44 after the refusal “${refusal.slice(0, 110)}…”; ${D} from ${cap0} to 2 seats (${v[D]}), capacity 0 refused.`, evidence: [s1, s2] };
});

await check('B3', 'Drag a marker; Undo and Cancel', 'A marker dragged inside the area is snapped to the road network; outside the area the move is refused and the marker goes back. Undo (button, then Ctrl+Z) restores the previous states; a cancelled placement adds nothing.', async () => {
  const D = F.details?.driver ?? 'D1';
  const from = await freeMarker('driver', [D]); expect(from, 'no driver marker to drag');
  const M = from.ref, p0 = (await places('drivers'))[M], to = await mapAt(0.31, 0.52);
  await p.drag(from.x, from.y, to.x, to.y); await sleep(1200);
  const p1 = (await places('drivers'))[M];
  const onGrid = p1[0].split(',').map(Number).every((v) => Math.abs(v / 0.004 - Math.round(v / 0.004)) < 1e-3);
  expect(p1[0] !== p0[0] && p1[1] === p0[1] && onGrid, `${M} ${p0} → ${p1}`);
  const s1 = await shot('marker-dragged', 200);
  const from2 = await marker(M, 'driver'), out = await mapAt(0.31, 0.012);
  await p.drag(from2.x, from2.y, out.x, out.y); await sleep(1200);
  const notice = await text('.wizard-body [role=alert]'), p2 = (await places('drivers'))[M];
  expect(/outside the working area/.test(notice) && p2[0] === p1[0], `outside move: “${notice}” ${p2}`);
  const back = await marker(M, 'driver');
  expect(Math.abs(back.x - from2.x) < 3 && Math.abs(back.y - from2.y) < 3, 'the refused marker did not go back');
  const s2 = await shot('marker-move-refused', 200);
  await p.click('Undo', '.wizard .authoring-bar button', true); await sleep(700);
  const p3 = (await places('drivers'))[M];
  expect(p3[0] === p0[0], `Undo button: ${p3} (expected ${p0})`);
  // Ctrl+Z undoes the capacity change made before (focus outside any field)
  const vehicle = () => p.eval(`document.querySelector('.wizard select[aria-label="vehicle of ${D}"]')?.value`);
  await p.eval('document.activeElement?.blur()'); await p.chord('z', 'KeyZ', 90, 2); await sleep(700);
  const v1 = await vehicle();
  expect(/-3p$/.test(v1), `Ctrl+Z: ${D} vehicle ${v1}`);
  // the capacity change again through the list's link to the details, then cancelled placements
  await p.eval(`document.querySelector('.wizard button[aria-label="details of ${D}"]').click()`);
  await p.waitFor(`new RegExp('Driver · ${D}$', 'm').test(document.querySelector(${JSON.stringify(PANEL)})?.innerText ?? '')`, 15000, `details of ${D}`); await sleep(300);
  await p.fill(`${PANEL} input[aria-label="vehicle capacity"]`, '2'); await p.click('Save participant', `${PANEL} button`);
  await p.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, 15000, `${D} saved`); await sleep(400);
  expect(/-2p$/.test(await vehicle()), 'the capacity was not changed again');
  const before = await markers();
  await p.click('Driver', '.wizard .pal-item', true); await sleep(400);
  expect(/start point of D8/.test(await text('.wizard .authoring-hint')), 'the palette item is not armed');
  await p.click('Cancel placement', '.wizard .authoring-hint button'); await sleep(500);
  const mid = await markers();
  // a new participant whose form is cancelled is removed too
  await p.click('Rider', '.wizard .pal-item', true); await sleep(300);
  for (const [fx, fy] of [[0.3, 0.5], [0.45, 0.46]]) { const pt = await mapAt(fx, fy); await p.clickAt(pt.x, pt.y); await sleep(900); }
  await p.waitFor(`/New rider · R11/.test(document.querySelector(${JSON.stringify(PANEL)})?.innerText ?? '')`, 15000, 'the form of R11');
  await p.click('Cancel', `${PANEL} button`, true); await sleep(500);
  const after = await markers();
  expect(JSON.stringify(before) === JSON.stringify(mid) && JSON.stringify(before) === JSON.stringify(after) && before.drivers === 7 && before.riders === 10, `cancel: ${JSON.stringify([before, mid, after])}`);
  await summary(7, 10);
  F.moved = { driver: M, from: p0, to: p1, refused: notice };
  return { actual: `${M} moved and snapped (${p1[0]}), refused outside (“${notice.slice(0, 80)}…”), Undo button and Ctrl+Z restore; cancelled placements leave 7 drivers and 10 riders.`, evidence: [s1, s2] };
});

await check('C1', 'Save, run, validated', 'The edited scenario is saved as generated data (seed and parameters recorded, hand edits listed) and run; every solution is validated.', async () => {
  await next(); await next();
  await p.fill('.wizard input[aria-label="experiment name"]', 'Authoring · generated and edited'); await p.fill('.wizard input[aria-label=repetitions]', '1'); await sleep(300);
  await next();
  const review = await text('.review');
  expect(/seed 42/.test(review) && /generated on the road network/.test(review), `review: ${review.slice(0, 300)}`);
  const s1 = await shot('review', 300);
  await armJob();
  await p.click('Save & Run', '.wizard-foot button');
  const st = await waitJob(); expect(st === 'done' || st === 'gone', `job ${st}`);
  await sleep(3000); mine = decodeURIComponent((await p.eval('location.hash')).split('/')[2] ?? '');
  const e = (await api(`/api/lab/experiments/${mine}`)).body;
  expect(e.validation.runs > 0 && e.validation.accepted === e.validation.runs, `validation ${JSON.stringify(e.validation)}`);
  const sc = e.scenarios[0], inst = (await api(`/api/geo/instances/${sc.instance_hash}`)).body, prov = inst.provenance;
  expect(inst.drivers.length === 7 && inst.riders.length === 10, `stored ${inst.drivers.length} drivers, ${inst.riders.length} riders`);
  expect(prov.source === 'generator' && prov.seed === 42 && /authoring/.test(prov.generator) && prov.parameters.capacity === 3, `provenance ${JSON.stringify(prov).slice(0, 300)}`);
  expect(['D7', F.details.rider, 'R10'].every((id) => prov.edited_agents.includes(id)) && !prov.edited_agents.includes(F.moved.driver), `edited ${prov.edited_agents}`);
  const d1 = inst.drivers.find((d) => d.id === F.details.driver), d7 = inst.drivers.find((d) => d.id === 'D7');
  expect(d1.vehicle.passenger_capacity === 2 && d7.vehicle.powertrain === 'BEV', `${d1.id} ${d1.vehicle.passenger_capacity} seats, D7 ${d7.vehicle.powertrain}`);
  const s2 = await shot('validated-results', 1200);
  F.run = { campaign_id: mine, validation: e.validation, provenance: prov, served: e.results.rows.map((r) => `${r.name}: ${r.totals.served}`) };
  return { actual: `Experiment ${mine}: ${e.validation.accepted}/${e.validation.runs} validated; provenance generator seed 42, edited ${prov.edited_agents.join(', ')}; ${F.run.served.join(' · ')}.`, evidence: [s1, s2] };
});

await check('C2', 'From the Workspace: Randomize and a marker\'s details', 'The Workspace Randomize button opens the editor on a new version with the dialog; “Edit participants…” on a marker opens that participant\'s details. The frozen scenario stays unchanged.', async () => {
  const before = (await api(`/api/lab/experiments/${mine}`)).body.scenarios[0].instance_hash;
  await p.click('Randomize', '.edit-people button');
  await p.waitFor(`!!document.querySelector(${JSON.stringify(MODAL)})`, 20000, 'the dialog from the Workspace'); await sleep(500);
  const d = await p.eval(`document.querySelector('${MODAL} input[aria-label="number of drivers"]').value`), r = await p.eval(`document.querySelector('${MODAL} input[aria-label="number of riders"]').value`);
  expect(d === '7' && r === '10', `counts ${d}/${r}`);
  const s1 = await shot('workspace-randomize', 200);
  await p.click('Cancel', `${MODAL} button`, true); await sleep(300);
  await p.eval(`document.querySelector('.wizard button[aria-label=close]').click()`); await sleep(800);
  const pos = await p.eval(`(() => { for (const e of document.querySelectorAll('.lab-grid .mk[data-ref^="R"]')) { const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; if (e.contains(document.elementFromPoint(x, y))) return { x, y }; } return null; })()`);
  expect(pos, 'no rider marker on the Workspace map'); await p.clickAt(pos.x, pos.y);
  await p.waitFor('!!document.querySelector(".inspect-card")', 10000, 'the read-only card'); await sleep(300);
  const id = (await text('.inspect-card')).match(/Rider · (\S+)/)?.[1];
  await p.click('Edit participants…', '.inspect-card button');
  await p.waitFor(`new RegExp('Rider · ${id}').test(document.querySelector(${JSON.stringify(PANEL)})?.innerText ?? '')`, 20000, `details of ${id} in the editor`);
  const s2 = await shot('workspace-edit-participant', 300);
  await p.eval(`document.querySelector('.wizard button[aria-label=close]').click()`); await sleep(800);
  const after = (await api(`/api/lab/experiments/${mine}`)).body.scenarios[0].instance_hash;
  expect(before === after, 'the frozen scenario changed');
  return { actual: `Workspace Randomize → dialog with 7 drivers / 10 riders; “Edit participants…” on ${id} → its details in the editor; frozen scenario ${after.slice(0, 10)}… unchanged.`, evidence: [s1, s2] };
});

await check('C3', 'A hand edit of generated demand keeps its provenance', 'In a scenario of the seeded synthetic generator, editing one rider by hand turns the participants into the scenario\'s own; the saved scenario keeps the generator and its seed and lists the edited participant.', async () => {
  await p.click('Generate', '.labbar button');
  await p.waitFor('!!document.querySelector(".wizard .wizard-map .leaflet-container")', 15000, 'wizard');
  const area = (await api('/api/geo/areas')).body.areas.find((a) => a.name === AREA && a.network_id);
  await choose('select[aria-label=area]', area.area_id); await sleep(1200);
  await p.click('Synthetic demand', '.wizard label'); await next();
  await p.fill('.wizard input[aria-label=drivers]', '5'); await p.fill('.wizard input[aria-label=riders]', '6'); await p.fill('.wizard input[aria-label=seed]', '9');
  await summary(5, 6); await sleep(600);
  expect(await count('.wizard table[aria-label=riders]') === 0, 'a generated scenario already lists its participants as editable');
  const rm = await freeMarker('rider'); expect(rm, 'no rider marker to click'); await p.clickAt(rm.x, rm.y);
  await p.waitFor(`new RegExp('Rider · ${rm.ref}$', 'm').test(document.querySelector(${JSON.stringify(PANEL)})?.innerText ?? '')`, 15000, `details of ${rm.ref}`); await sleep(300);
  await p.fill(`${PANEL} input[aria-label="earliest pick-up"]`, '05:00'); await p.fill(`${PANEL} input[aria-label="latest pick-up"]`, '23:00');
  await p.click('Save participant', `${PANEL} button`);
  await p.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, 15000, 'saved'); await summary(5, 6);
  const rows = { drivers: await count('.wizard table[aria-label=drivers] tbody tr'), riders: await count('.wizard table[aria-label=riders] tbody tr') };
  expect(rows.drivers === 5 && rows.riders === 6, `the participants were not taken over: ${JSON.stringify(rows)}`);
  await next(); await next(); await next();
  const review = await text('.review');
  expect(/started from generated or sampled participants \(seed 9\)/.test(review), `review: ${review.slice(-300)}`);
  const s1 = await shot('review-edited-generated', 300);
  const before = (await api('/api/geo/scenarios')).body.scenarios.length;
  await p.click('Save Scenario', '.wizard-foot button');
  await p.waitFor('!document.querySelector(".wizard")', 30000, 'wizard closed'); await sleep(800);
  const lib = (await api('/api/geo/scenarios')).body.scenarios;
  const rec = [...lib].sort((x, y) => (x.created_at < y.created_at ? 1 : -1))[0];
  const prov = (await api(`/api/geo/scenarios/${rec.scenario_id}`)).body.scenario.provenance;
  expect(lib.length === before + 1 && prov.source === 'generator' && prov.seed === 9 && /synthetic/.test(prov.generator) && JSON.stringify(prov.edited_agents) === JSON.stringify([rm.ref]), `provenance ${JSON.stringify(prov)}`);
  return { actual: `${rm.ref} edited by hand in a synthetic scenario (seed 9): saved with generator ${prov.generator}, seed ${prov.seed}, edited ${prov.edited_agents.join(', ')}.`, evidence: [s1] };
});

await check('D1', 'Phone width: tap to place', 'At 375 px the palette, the map and the form fit the screen; tapping Rider, then the map twice, adds a rider through the form; a driver is added the same way.', async () => {
  await p.size(375, 812, 2, true); await p.touch(true); await sleep(800);
  await p.eval(`location.hash = '#/workspace/${mine}'`); await sleep(2500);
  const tapOn = async (label, scope, exact = false) => { let at = null; for (let i = 0; i < 40 && !at; i++) { at = await p.find(label, scope, exact); if (!at) await sleep(150); } expect(at && !at.disabled, `nothing to tap: ${label}`); await p.tap(at.x, at.y); await sleep(250); };
  await tapOn('Generate', '.labbar button');
  await p.waitFor('!!document.querySelector(".wizard .wizard-map .leaflet-container")', 20000, 'wizard');
  const area = (await api('/api/geo/areas')).body.areas.find((a) => a.name === AREA && a.network_id);
  await choose('select[aria-label=area]', area.area_id); await sleep(1200);
  await tapOn('Place participants on the map', '.wizard label'); await tapOn('Next', '.wizard-foot button'); await sleep(800);
  const fits = () => p.eval('document.documentElement.scrollWidth <= window.innerWidth + 1 && [...document.querySelectorAll(".wizard .pal-item, .wizard .authoring-bar .btn")].every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1; })');
  expect(await fits(), 'the participants step overflows 375 px');
  const mapBox = await p.eval(`(() => { const r = document.querySelector('.wizard-map .leaflet-container').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height }; })()`);
  expect(mapBox.h >= 200 && mapBox.bottom <= 813, `the map is not on the phone screen: ${JSON.stringify(mapBox)}`);
  const s1 = await shot('phone-participants-step', 300);
  const placeTwo = async (a, b) => { for (const [fx, fy] of [a, b]) { const pt = await mapAt(fx, fy); await p.tap(pt.x, pt.y); await sleep(1100); } };
  await tapOn('Rider', '.wizard .pal-item', true);
  expect(/start point of R1/.test(await text('.wizard .authoring-hint')), `hint: ${await text('.wizard .authoring-hint')}`);
  await placeTwo([0.4, 0.4], [0.6, 0.62]);
  await p.waitFor(`/New rider · R1/.test(document.querySelector('.pp-wrap:not([hidden]) .pp-card')?.innerText ?? '')`, 15000, 'the form on the phone');
  const sheet = await p.eval(`(() => { const r = document.querySelector('.pp-wrap').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1 && r.top >= 0; })()`);
  expect(sheet, 'the form does not fit the phone screen');
  const s2 = await shot('phone-form', 300);
  await tapOn('Save participant', '.pp-card button');
  await p.waitFor(`!document.querySelector('.pp-wrap:not([hidden]) .pp-card')`, 15000, 'saved on the phone'); await sleep(600);
  await tapOn('Driver', '.wizard .pal-item', true); await placeTwo([0.35, 0.6], [0.65, 0.35]);
  await p.waitFor(`/New driver · D1/.test(document.querySelector('.pp-wrap:not([hidden]) .pp-card')?.innerText ?? '')`, 15000, 'the driver form on the phone');
  await tapOn('Save participant', '.pp-card button');
  await p.waitFor(`!document.querySelector('.pp-wrap:not([hidden]) .pp-card')`, 15000, 'driver saved on the phone'); await summary(1, 1);
  const rows = { drivers: await count('.wizard table[aria-label=drivers] tbody tr'), riders: await count('.wizard table[aria-label=riders] tbody tr') }, m = await markers();
  expect(rows.drivers === 1 && rows.riders === 1 && m.drivers === 1 && m.riders === 1 && (await places('riders')).R1.every(Boolean), `rows ${JSON.stringify(rows)} markers ${JSON.stringify(m)}`);
  const s3 = await shot('phone-placed', 300);
  // the dialog and the dark theme at phone width
  await tapOn('Randomize…', '.wizard .authoring-bar button');
  await p.waitFor(`!!document.querySelector(${JSON.stringify(MODAL)})`, 10000, 'the dialog on the phone'); await sleep(400);
  expect(await p.eval(`(() => { const e = document.querySelector(${JSON.stringify(MODAL)}), r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1 && e.scrollWidth <= e.clientWidth + 1; })()`), 'the dialog overflows 375 px');
  const s4 = await shot('phone-randomize', 300);
  const theme = await p.eval('document.documentElement.dataset.theme ?? ""');
  await p.eval('document.documentElement.dataset.theme = "dark"'); const s5 = await shot('phone-randomize-dark', 400);
  await p.eval(`if (${JSON.stringify(theme)}) document.documentElement.dataset.theme = ${JSON.stringify(theme)}; else delete document.documentElement.dataset.theme`);
  await tapOn('Cancel', `${MODAL} button`, true);
  await p.eval(`document.querySelector('.wizard button[aria-label=close]').click()`); await sleep(600);
  return { actual: 'At 375 px: palette Rider → tap, tap → form as a bottom sheet → saved; a driver the same way (1 driver, 1 rider, previewed); the dialog fits; dark theme captured.', evidence: [s1, s2, s3, s4, s5] };
});
await p.touch(false); await p.size(W, H, 1); await sleep(500);

await check('D2', 'Dark theme at desktop width', 'The dialog and the details form read correctly in the dark theme.', async () => {
  await p.eval(`location.hash = '#/workspace/${mine}'`); await sleep(2500);
  const theme = await p.eval('document.documentElement.dataset.theme ?? ""');
  await p.eval('document.documentElement.dataset.theme = "dark"');
  await p.click('Randomize', '.edit-people button');
  await p.waitFor(`!!document.querySelector(${JSON.stringify(MODAL)})`, 20000, 'the dialog'); await sleep(500);
  const s1 = await shot('dark-randomize', 300);
  await p.click('Cancel', `${MODAL} button`, true); await sleep(400);
  const r1 = await marker('R1', 'rider'); await p.clickAt(r1.x, r1.y);
  await p.waitFor(`!!document.querySelector(${JSON.stringify(PANEL)})`, 15000, 'details'); const s2 = await shot('dark-details', 300);
  await p.eval(`document.querySelector('.wizard button[aria-label=close]').click()`); await sleep(500);
  await p.eval(`if (${JSON.stringify(theme)}) document.documentElement.dataset.theme = ${JSON.stringify(theme)}; else delete document.documentElement.dataset.theme`);
  return { actual: 'Dialog and details form captured in the dark theme.', evidence: [s1, s2] };
});

report.finished = new Date().toISOString();
report.summary = { total: report.checks.length, pass: report.checks.filter((c) => c.status === 'PASS').length };
writeFileSync(join(OUT, 'authoring.json'), JSON.stringify(report, null, 1));
console.log(`\n${report.summary.pass}/${report.summary.total} checks passed — ${join(OUT, 'authoring.json')}`);
await p.close();
process.exit(report.summary.pass === report.summary.total ? 0 : 1);
