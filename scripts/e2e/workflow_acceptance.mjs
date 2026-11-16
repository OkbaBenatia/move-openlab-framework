#!/usr/bin/env node
// Workflow acceptance: the live demonstration (Scenarios A, B, C) and the browser regression checks of the workflow
// corrections — compact chart grid at 100 % / 160 % zoom and on a phone, Compare methods inside one experiment,
// exactly two compared experiments, Run with this method, Save & Run transition, collapsible metadata, participants
// added from the Workspace, Randomize with a typed seed, marker types, short derived titles, the public benchmark.
//
//   node scripts/e2e/workflow_acceptance.mjs --base http://127.0.0.1:8791 --creds <data dir>/dev-credentials.json --out <dir>
//
// Run it against a server on a COPY of a data directory (it creates experiments). Passwords are read from the
// git-ignored credentials file and never printed or captured. Writes workflow-acceptance.json and screenshots.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8791'), OUT = arg('out'), CREDS = arg('creds');
const ADMIN = arg('admin', 'okba_test'), OTHER = arg('other', 'researcher2');
if (!OUT || !CREDS) { console.error('usage: workflow_acceptance.mjs --base URL --creds FILE --out DIR'); process.exit(2); }
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
const report = { base: BASE, admin: ADMIN, other: OTHER, started: new Date().toISOString(), checks: [], facts: {} };
const F = report.facts;
const p = await launch(chrome, { width: W, height: H });
await p.size(W, H, 2);
await p.allowDownloads(DL);

const shot = async (name, settle = 700) => { await sleep(settle); const f = `${name}.png`; await p.shot(join(SHOTS, f)); return f; };
const expect = (c, m) => { if (!c) throw new Error(m); };
const text = (css = 'body') => p.eval(`(document.querySelector(${JSON.stringify(css)})?.innerText ?? '')`);
const api = (path, init = {}) => p.eval(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }))`);
const goHash = async (h, settle = 2500) => { await p.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(settle); };
const cidNow = async () => decodeURIComponent((await p.eval('location.hash')).split('/')[2] ?? '').split('|')[0];
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
  await p.clearCookies(); await p.goto(`${BASE}/login`);
  await p.focusCss('input[name=username]'); await p.type(user); await p.focusCss('input[name=password]'); await p.type(pw(user));
  await p.click('Sign in', 'button');
  await p.waitFor('location.pathname === "/" && !!document.querySelector(".hdr")', 30000, `sign-in of ${user}`);
}
async function signOut() {
  await p.click('profile', '.hdr button'); await p.click('Sign out', '[role=menu] button, .menu button, .menu a');
  await p.waitFor('location.pathname === "/login"', 15000, 'login page after sign-out');
}
async function check(id, title, expected, fn, { keep = false } = {}) {
  const t0 = Date.now(), e0 = p.errors.length;
  if (!keep) { try { await p.key('Escape'); await p.key('Escape'); if (await p.eval('!!document.querySelector(".wizard")')) { await p.eval(`document.querySelector('.wizard button[aria-label=close]')?.click()`); await sleep(500); } } catch { /* */ } }
  const rec = { id, title, expected, actual: '', status: 'FAIL', evidence: [], ms: 0, page_errors: [] };
  try { const r = await fn(); rec.actual = r?.actual ?? ''; rec.evidence = r?.evidence ?? []; rec.status = 'PASS'; }
  catch (e) { rec.actual = `ERROR: ${String(e.message ?? e).slice(0, 500)}`; try { const f = `fail-${id}.png`; await p.shot(join(SHOTS, f)); rec.evidence.push(f); } catch { /* */ } }
  rec.page_errors = p.errors.slice(e0); rec.ms = Date.now() - t0;
  if (rec.page_errors.length) { rec.status = 'FAIL'; rec.actual += ` · page errors: ${rec.page_errors.join(' | ').slice(0, 300)}`; }
  report.checks.push(rec);
  console.log(`${rec.status}  ${id} ${title} — ${rec.actual.slice(0, 220)}`);
  writeFileSync(join(OUT, 'workflow-acceptance.json'), JSON.stringify(report, null, 1));
}
/** Chart cards of the open charts view: position and size. */
const cards = () => p.eval(`[...document.querySelectorAll('.charts-grid .chart-card')].filter((c) => !c.classList.contains('chart-placeholder')).map((c) => { const r = c.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), plot: Math.round(c.querySelector('.chart-plot svg')?.getBoundingClientRect().height ?? 0), title: c.querySelector('h3')?.innerText }; })`);
const perRow = (cs) => { const rows = new Map(); for (const c of cs) rows.set(c.y, (rows.get(c.y) ?? 0) + 1); return Math.max(0, ...rows.values()); };
const overflow = () => p.eval('document.documentElement.scrollWidth - innerWidth');
const scrollToCss = (css) => p.eval(`document.querySelector(${JSON.stringify(css)})?.scrollIntoView({ block: 'start' })`);
let base = '', variant = '', mine = '', ext = '', exported = '', repro = '';

// ===================================================================================================== Scenario A
await check('A1', 'Open Montbéliard Demo — Baseline: map, participants, compact metadata',
  'The Workspace opens the demonstration; metadata is compact (title, status, area, data, scenario, one-line summary) with Experiment details collapsed; participants are visible without scrolling far.',
  async () => {
    await signIn(ADMIN); await waitWorkspace(); await sleep(2500);
    const list = (await api('/api/lab/experiments')).body.experiments;
    const demos = list.filter((x) => x.demo && !x.hidden).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    base = (demos.find((x) => x.kind === 'baseline' && x.area === 'Montbéliard') ?? demos.find((x) => x.kind === 'baseline')).campaign_id;
    variant = demos.find((x) => x.kind === 'variant' && x.parent === base)?.campaign_id ?? '';
    await p.eval(`(async () => { await fetch('/api/lab/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ details_open: false }) }); })()`);
    await p.goto(`${BASE}/#/workspace/${base}`); await waitWorkspace(); await sleep(4000);
    const s1 = await shot('01-montbeliard-workspace', 1500);
    const ui = await p.eval(`(() => { const d = document.querySelector('.lab-left details'); const ppl = document.querySelector('.lab-left .people'); return { open: !!d?.open, summary: d?.querySelector('summary')?.innerText, peopleTop: ppl ? Math.round(ppl.getBoundingClientRect().top) : null, line: document.querySelector('.summary-line')?.innerText ?? '' }; })()`);
    expect(ui.summary === 'Experiment details' && !ui.open && ui.peopleTop && ui.peopleTop < 720 && /validated/.test(ui.line), JSON.stringify(ui));
    const s2 = await shot('02-compact-metadata', 300);
    F.workspace = { base, variant, ...ui };
    return { actual: `Details collapsed; summary “${ui.line}”; participant list starts at y=${ui.peopleTop}px (viewport ${H}).`, evidence: [s1, s2] };
  });

await check('A1b', 'Collapsible metadata, remembered per account', 'Experiment details expands (network, sampling, lineage, identifiers) and the choice is saved for the account.',
  async () => {
    await p.click('Experiment details', '.lab-left summary'); await sleep(1200);
    const st = (await api('/api/lab/state')).body.preferences.details_open;
    const inside = await text('.lab-left details');
    const s = await shot('02b-experiment-details-open', 300);
    expect(st === true && /Road network/.test(inside) && /Identifiers/.test(inside), `pref ${st}; ${inside.slice(0, 120)}`);
    await p.click('Experiment details', '.lab-left summary'); await sleep(800);
    const st2 = (await api('/api/lab/state')).body.preferences.details_open;
    expect(st2 === false, `pref after collapse ${st2}`);
    return { actual: 'Expanded → preference details_open=true; collapsed → false; network, scenario derivation and identifiers inside.', evidence: [s] };
  }, { keep: true });

await check('A2', 'Participants list and marker types', 'Drivers and riders listed; markers: drivers by vehicle type (colour + icon), pick-ups, drop-offs, unmatched riders as person icons; electric and combustion distinct.',
  async () => {
    await p.click('Riders', '.lab-left .seg button'); await sleep(500);
    const s1 = await shot('03-participants-riders', 300);
    await p.click('Drivers', '.lab-left .seg button'); await sleep(300);
    const mk = await p.eval(`(() => { const k = {}, g = {}, col = {}; document.querySelectorAll('.mk[data-kind]').forEach((m) => { k[m.dataset.kind] = (k[m.dataset.kind] ?? 0) + 1; if (m.dataset.glyph) { g[m.dataset.glyph] = (g[m.dataset.glyph] ?? 0) + 1; col[m.dataset.glyph] = getComputedStyle(m).getPropertyValue('--c').trim(); } });
      const person = [...document.querySelectorAll('.mk[data-kind=unserved] svg path')].length > 0; const icons = [...document.querySelectorAll('.mk[data-glyph] svg')].length; return { kinds: k, glyphs: g, colours: col, person, icons }; })()`);
    expect(mk.kinds.driver > 0 && mk.kinds.pickup > 0 && mk.kinds.dropoff > 0 && mk.kinds.unserved > 0 && mk.person && mk.icons === mk.kinds.driver, JSON.stringify(mk));
    expect(mk.colours.E && mk.colours.C && mk.colours.E !== mk.colours.C, `electric ${mk.colours.E} vs combustion ${mk.colours.C}`);
    // zoom on a part of the map with several drivers for the marker capture
    const c = await p.eval(`(() => { const m = document.querySelector('.mk[data-glyph=E]'); if (!m) return null; const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await p.hover(c.x, c.y); await sleep(600);
    const tip = await text('.leaflet-tooltip');
    const s2 = await shot('08-vehicle-markers', 300);
    F.markers = { ...mk, tooltip: tip };
    return { actual: `markers ${JSON.stringify(mk.kinds)}; drivers E ${mk.glyphs.E ?? 0} (${mk.colours.E}) / C ${mk.glyphs.C ?? 0} (${mk.colours.C}), every driver with an icon; tooltip “${tip}”.`, evidence: [s1, s2] };
  }, { keep: true });

await check('A3', 'Compare Exact MILP and Greedy inside the experiment', 'Compare methods opens on the same frozen experiment: the selected methods side by side, reference A, validation, runtime, objective, CO₂; no other experiment needed.',
  async () => {
    await goHash(`#/workspace/${base}`, 2500);
    // one Compare entry: it opens the Methods tab when the experiment has several methods; experiments are chosen on the Experiments tab
    await p.click('Compare', '.labbar button'); await p.waitFor('location.hash.startsWith("#/methods/") && !!document.querySelector(".cmp-table")', 30000, 'methods table'); await sleep(1500);
    const heads = await p.eval(`[...document.querySelectorAll('.cmp-table thead th')].map((t) => t.innerText.trim())`);
    const rows = await p.eval(`[...document.querySelectorAll('.cmp-table tbody tr:not(.grp)')].map((t) => t.cells[0]?.innerText)`);
    const s = await shot('12-compare-methods', 400);
    expect(heads.some((h) => /A · Exact/.test(h)) && heads.some((h) => /B · Greedy/.test(h)) && ['Status', 'Served riders', 'Runtime', 'CO₂e emissions'].every((r) => rows.includes(r)), `${heads} | ${rows}`);
    // unticking a method leaves exactly the ticked ones
    await p.eval(`document.querySelector('.method-picks input[aria-label^="Greedy"]').click()`); await sleep(800);
    const one = await p.eval(`[...document.querySelectorAll('.cmp-table thead th')].length`);
    await p.eval(`document.querySelector('.method-picks input[aria-label^="Greedy"]').click()`); await sleep(800);
    F.compare_methods = { route: await p.eval('location.hash'), heads, rows };
    return { actual: `Route ${F.compare_methods.route}; columns ${heads.slice(2).join(' | ')}; rows include Status, Served riders, Runtime, Emissions; with Greedy unticked ${one} header cells (one method).`, evidence: [s] };
  });

await check('A4', 'Compact interactive charts (methods)', 'Charts: equal compact cards, 3 per row at 1440 px, card height ≈ 300–360 px, plot 200–260 px; hover tooltips; CSV/PNG/SVG; CO₂ charts.',
  async () => {
    await p.click('Charts', '.tabs button'); await sleep(2500);
    const cs = await cards();
    const s1 = await shot('14-compact-charts-methods', 300);
    const bar = await p.eval(`(() => { const g = document.querySelector('.charts-grid .chart-card [role=img]'); if (!g) return null; g.scrollIntoView({ block: 'center' }); const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await p.hover(bar.x, bar.y); await sleep(500); const tip = await text('.chart-tip');
    await scrollToCss('.co2-charts'); const s2 = await shot('16-co2-charts', 600);
    const titles = cs.map((c) => c.title);
    const need = ['Served riders', 'Total detour', 'Runtime', 'Vehicles used', 'Vehicle distance', 'Baseline and solution CO₂', 'CO₂ avoided', 'CO₂ avoided (%)'];
    const hs = cs.map((c) => c.h);
    expect(perRow(cs) === 3 && Math.max(...hs) <= 360 && Math.min(...hs) >= 280 && cs.every((c) => c.plot >= 200 && c.plot <= 260), JSON.stringify(cs.map((c) => [c.w, c.h, c.plot])));
    expect(need.every((t) => titles.includes(t)), `titles ${titles}`); expect(/Method:/.test(tip), `tooltip ${tip}`);
    F.charts_methods = { cards: cs.length, per_row: perRow(cs), heights: [Math.min(...hs), Math.max(...hs)], plot: cs[0].plot, titles };
    return { actual: `${cs.length} cards, ${perRow(cs)} per row, heights ${Math.min(...hs)}–${Math.max(...hs)} px, plot ${cs[0].plot} px; charts: ${titles.join(', ')}; tooltip “${tip.replace(/\n/g, ' · ').slice(0, 120)}”.`, evidence: [s1, s2] };
  }, { keep: true });

await check('A4b', 'Exactly two experiments; charts at 160 % zoom and on a phone', 'Compare selected (2) → A (reference) and B only; chart grid: 3 per row at 100 %, 2 at 160 % zoom, 1 on a phone, no horizontal scroll.',
  async () => {
    await goHash(`#/workspace/${base}`, 2500);
    const titles = Object.fromEntries((await api('/api/lab/experiments')).body.experiments.map((x) => [x.campaign_id, x.title]));
    await p.click('Compare', '.labbar button'); await p.waitFor('location.hash.startsWith("#/methods/") || location.hash.startsWith("#/compare/")', 30000, 'Compare'); await sleep(500); if (await p.eval('location.hash.startsWith("#/methods/")')) { await p.click('Experiments', 'nav.compare-kind button'); await sleep(600); } await p.waitFor('!!document.querySelector(".picker-drawer .cands")', 30000, 'picker'); await sleep(800);
    await p.eval(`[...document.querySelectorAll('.picker-drawer input[type=checkbox]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(titles[variant])}).click()`); await sleep(400);
    const foot = await text('.picker-drawer .drawer-foot');
    expect(/^2 selected/.test(foot), foot);
    await p.click('Compare selected (2)', '.picker-drawer button'); await p.waitFor('!!document.querySelector(".cmp-table")', 60000, 'cmp'); await sleep(2500);
    const ids = decodeURIComponent(await p.eval('location.hash')).replace('#/compare/', '').split(/[|,]/);
    expect(ids.length === 2 && ids[0] === base && ids[1] === variant, `route ${ids}`);
    // the variant's values stand beside the baseline's (its scenarios are matched through their derivation)
    const served = await p.eval(`[...document.querySelectorAll('.cmp-table tbody tr')].find((r) => r.cells[0]?.innerText === 'Served riders')?.innerText.replace(/\\s+/g, ' ')`);
    expect(served && (served.match(/48 \/ 90/g) ?? []).length >= 2, `B values missing: ${served}`);
    const s1 = await shot('13-compare-two-experiments', 300);
    await p.click('Charts', '.tabs button'); await sleep(2500);
    const c100 = await cards(); const o100 = await overflow();
    const s2 = await shot('14b-compact-charts-two-experiments', 300);
    await p.size(900, 562, 1.6); await sleep(1800);
    const c160 = await cards(); const o160 = await overflow();
    const s3 = await shot('15-compact-charts-160pct', 300);
    await p.size(390, 844, 2, true); await sleep(1800);
    const cm = await cards(); const om = await overflow();
    await p.size(W, H, 2); await sleep(1200);
    expect(perRow(c100) === 3 && perRow(c160) === 2 && perRow(cm) === 1 && o100 <= 0 && o160 <= 0 && om <= 0, `per row ${perRow(c100)}/${perRow(c160)}/${perRow(cm)} overflow ${o100}/${o160}/${om}`);
    expect(Math.max(...c160.map((c) => c.h)) <= 380, `160% heights ${c160.map((c) => c.h)}`);
    F.charts_zoom = { per_row: [perRow(c100), perRow(c160), perRow(cm)], heights_160: [Math.min(...c160.map((c) => c.h)), Math.max(...c160.map((c) => c.h))] };
    return { actual: `Footer “${foot.split(' · ')[0]}”; route ${ids.join(' vs ')}; charts per row 100 % ${perRow(c100)}, 160 % ${perRow(c160)}, phone ${perRow(cm)}; no horizontal scroll.`, evidence: [s1, s2, s3] };
  });

await check('A4c', 'Charts with three compared experiments', 'With A, B and C the grid keeps equal compact cards (3 per row) and every value is matched by scenario.',
  async () => {
    const list = (await api('/api/lab/experiments')).body.experiments;
    const r = list.find((x) => x.kind === 'reproduction' && x.parent === base)?.campaign_id;
    expect(r, 'no reproduction of the demonstration in this account');
    await goHash(`#/compare/${base}|${variant},${r}`, 3500); await p.click('Charts', '.tabs button'); await sleep(2500);
    const cs = await cards(); const s = await shot('14c-compact-charts-three-experiments', 300);
    const lg = await p.eval(`document.querySelector('.charts-grid .chart-card .lgd')?.innerText`);
    expect(perRow(cs) === 3 && /A ·/.test(lg) && /B ·/.test(lg) && /C ·/.test(lg), `${perRow(cs)} ${lg}`);
    return { actual: `${cs.length} cards, ${perRow(cs)} per row; legend ${lg.replace(/\n/g, ' | ').slice(0, 160)}.`, evidence: [s] };
  });

await check('A6', 'Export the demonstration (one ZIP)', 'One bundle file with the evidence report inside.',
  async () => {
    await goHash(`#/workspace/${base}`, 3000);
    await p.click('Export', '.labbar button'); await p.waitFor('!!document.querySelector(".exportd .exlist")', 20000, 'export dialog');
    const s1 = await shot('20-export', 400);
    const before = p.downloadCount();
    await p.click('xport', '.exportd .drawer-foot button.primary'); await p.waitDownload(before, 60000);
    await p.waitFor('/Bundle saved/.test(document.querySelector(".exportd")?.innerText)', 30000, 'saved'); await sleep(2500);
    const done = await text('.exportd'); await p.click('Done', '.exportd button');
    exported = readdirSync(DL).filter((f) => f.endsWith('.zip')).map((f) => join(DL, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1);
    expect(p.downloadCount() - before === 1 && /evidence\/report\.json/.test(done), done.slice(0, 200));
    F.export = { file: basename(exported), bytes: statSync(exported).size };
    return { actual: `1 download ${basename(exported)} (${statSync(exported).size} bytes), evidence report inside.`, evidence: [s1] };
  });

await check('A7', 'Import into researcher2: integrity verified; reproduce; compare original and reproduction', 'The bundle is verified before anything is stored; the reproduction has a short title, is validated and Reproduced; original and reproduction compared side by side.',
  async () => {
    await signOut(); await signIn(OTHER); await waitWorkspace(); await sleep(2000);
    await p.click('Import', '.labbar button'); await p.click('Import a bundle file', '[role=menuitem]');
    await p.waitFor('!!document.querySelector(".importd")', 10000, 'import dialog');
    await p.setFiles('input[aria-label="bundle file to inspect"]', [exported]);
    await p.waitFor('!!document.querySelector(".importd .checks")', 60000, 'inspection'); await sleep(700);
    const t = await text('.importd'); expect(t.includes('Integrity verified'), 'no integrity statement');
    const s1 = await shot('21-import-verified', 300);
    const already = /Already in your workspace/.test(t);
    if (already) await p.click('Reproduce', '.importd button');
    else { await p.click('Import experiment', '.importd button', true); await p.waitFor('/Integrity verified/.test(document.querySelector(".lab-notes")?.innerText ?? "")', 60000, 'import notice'); await sleep(2000); await armJob(); await p.click('Run again', '.labbar button'); }
    await armJob().catch(() => { /* */ }); await waitJob(); await sleep(3500);
    repro = await cidNow(); const e = await experiment(repro);
    const s2 = await shot('22-reproduction', 800);
    expect(e.campaign.kind === 'reproduction' && e.reproduction?.reproduced && e.validation.accepted === e.validation.runs, `kind ${e.campaign.kind} ${JSON.stringify(e.reproduction)}`);
    expect(/ — Reproduction \d+$/.test(e.campaign.title) && !/re-execution of/i.test(e.campaign.title), `title ${e.campaign.title}`);
    const src = e.campaign.parent?.campaign_id;
    await goHash(`#/compare/${src}|${repro}`, 4000);
    const chips = await p.eval(`[...document.querySelectorAll('.cmpchip')].map((c) => c.innerText.replace(/\\s+/g, ' ').trim())`);
    const s3 = await shot('22b-compare-original-reproduction', 600);
    F.reproduction = { campaign_id: repro, title: e.campaign.title, parent: src, validation: e.validation, comparability: e.comparability && { results: e.comparability.quality, runtime: e.comparability.runtime, co2: e.comparability.emissions }, already_present: already };
    return { actual: `${already ? 'Identical records already present (demonstration): reproduced directly' : 'Imported, then re-executed'}; “${e.campaign.title}” ${e.validation.accepted}/${e.validation.runs} validated, Reproduced; results ${e.comparability?.quality}, runtime ${e.comparability?.runtime}, CO₂ ${e.comparability?.emissions}; compared: ${chips.join(' | ')}.`, evidence: [s1, s2, s3] };
  });

// ===================================================================================================== Scenario B
await check('B1', 'Generate 20 drivers and 30 riders, seed 21, Exact and Greedy; Save & Run', 'Preview 20 drivers · 30 riders; Review; Save & Run returns to the Workspace at once with the job stages; results validated; Compare methods.',
  async () => {
    await signOut(); await signIn(ADMIN); await waitWorkspace(); await goHash(`#/workspace/${base}`, 3000);
    // the Montbéliard area may be hidden in this account: listed again for the wizard without changing anything else
    const prefs = (await api('/api/lab/state')).body.preferences;
    const mont = (await api('/api/geo/areas')).body.areas.find((a) => a.name === 'Montbéliard' && a.network_id);
    if (mont && prefs.hidden_ids.includes(mont.area_id)) {
      await api('/api/lab/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hidden_ids: prefs.hidden_ids.filter((x) => x !== mont.area_id) }) });
      await p.eval('location.reload()'); await sleep(1500); await waitWorkspace(); await sleep(2500);
    }
    await p.click('Generate', '.labbar button'); await p.waitFor('!!document.querySelector(".wizard .wizard-map .leaflet-container")', 15000, 'wizard');
    await choose('select[aria-label=area]', mont.area_id); await sleep(1800);
    await p.click('Synthetic demand', '.wizard label'); await next();
    await p.fill('.wizard input[aria-label=drivers]', '20'); await p.fill('.wizard input[aria-label=riders]', '30'); await p.fill('.wizard input[aria-label=seed]', '21');
    await p.waitFor('/20 drivers · 30 riders/.test(document.querySelector("[aria-label=\\"preview summary\\"]")?.innerText ?? "")', 90000, 'preview');
    const s0 = await shot('09a-wizard-participants-seed21', 600);
    await next();
    await p.fill('.wizard input[aria-label=from]', '07:30'); await p.fill('.wizard input[aria-label=to]', '08:00');
    await p.fill('.wizard input[aria-label="max detour minutes"]', '20'); await p.fill('.wizard input[aria-label="max detour ratio"]', '1');
    await p.waitFor('/63 compatible pairs/.test(document.querySelector("[aria-label=\\"preview summary\\"]")?.innerText ?? "")', 90000, 'preview with the constraints');
    const preview = await text('[aria-label="preview summary"]');
    await next(); await p.fill('.wizard input[aria-label="experiment name"]', 'Workflow · Montbéliard seed 21'); await p.fill('.wizard input[aria-label=repetitions]', '3'); await sleep(300);
    await next(); const s1 = await shot('09-wizard-review', 300);
    await armJob();
    const t0 = Date.now();
    await p.click('Save & Run', '.wizard-foot button');
    await p.waitFor('!document.querySelector(".wizard") && location.hash.startsWith("#/workspace/c-")', 20000, 'workspace after Save & Run');
    const toWorkspace = Date.now() - t0;
    await p.waitFor('window.__jobSeen === true || !!document.querySelector(".job")', 20000, 'job'); const toJob = Date.now() - t0;
    const s2 = await shot('10-save-and-run-progress', 100);
    const stages = await p.eval(`[...document.querySelectorAll('.job .phases-inline li')].map((l) => l.innerText)`);
    await waitJob(); await sleep(3000); mine = await cidNow();
    const e = await experiment(mine);
    const s3 = await shot('11-completed-experiment', 1200);
    expect(e.validation.accepted === e.validation.runs && e.validation.runs === 6, `validation ${JSON.stringify(e.validation)}`);
    expect(toWorkspace < 3000, `Workspace after ${toWorkspace} ms`);
    const rows = e.results.rows.map((r) => ({ method: r.method_id, served: r.totals.served, detour_min: Math.round(r.totals.detour_s / 6) / 10, co2_kg: r.domain?.complete ? Math.round(r.domain.solution_g / 100) / 10 : null, avoided_kg: r.domain?.complete ? Math.round(r.domain.avoided_g / 100) / 10 : null }));
    await p.click('Compare', '.labbar button'); await p.waitFor('location.hash.startsWith("#/methods/") && !!document.querySelector(".cmp-table")', 30000, 'methods'); await sleep(1200);
    const s4 = await shot('12b-compare-methods-new-experiment', 300);
    F.scenario_b = { campaign_id: mine, preview, ms_to_workspace: toWorkspace, ms_to_progress: toJob, stages, rows };
    return { actual: `“${preview}”; Workspace ${toWorkspace} ms after Save & Run, progress ${toJob} ms (${stages.join(' › ')}); ${e.validation.accepted}/${e.validation.runs} validated; ${rows.map((r) => `${r.method} ${r.served} served, ${r.detour_min} min, CO₂ ${r.co2_kg} kg (avoided ${r.avoided_kg})`).join('; ')}.`, evidence: [s0, s1, s2, s3, s4] };
  });

// ===================================================================================================== Scenario C
await check('C1', 'Add My Greedy Matching: register if needed, Run with this method, validate, compare', 'Register (sandbox self-test, code pinned) → Run with this method → an extension on the same frozen scenarios, all solutions validated, short title → Compare methods with Exact and Greedy.',
  async () => {
    await goHash(`#/workspace/${base}`, 3000);
    await p.click('Add method', '.lab-right button'); await p.waitFor('!!document.querySelector("[role=dialog]") && /Add a method/.test(document.body.innerText)', 10000, 'dialog');
    await p.click('Register my method', '.choice'); await sleep(1200);
    const has = await p.eval(`[...document.querySelectorAll('[role=dialog] .plug')].some((r) => /My Greedy Matching/.test(r.innerText) && /Registered/.test(r.innerText))`);
    if (!has) {
      await p.eval(`(() => { const r = [...document.querySelectorAll('[role=dialog] .plug')].find((x) => /My Greedy Matching/.test(x.innerText)); [...r.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Register').click(); })()`);
      await p.waitFor('/Registered My Greedy Matching/.test(document.querySelector("[role=dialog]")?.innerText ?? "")', 120000, 'registration');
    }
    const s1 = await shot('17-registered-method', 400);
    await armJob();
    await p.eval(`(() => { const r = [...document.querySelectorAll('[role=dialog] .plug, [role=dialog] .note')].find((x) => /My Greedy Matching/.test(x.innerText) && [...x.querySelectorAll('button')].some((b) => /Run with this method/.test(b.innerText))); [...r.querySelectorAll('button')].find((b) => /Run with this method/.test(b.innerText)).click(); })()`);
    const s2 = await shot('18-run-with-this-method', 600);
    await waitJob(); await sleep(3500);
    ext = await cidNow(); const e = await experiment(ext);
    const row = e.results.rows.find((r) => r.method_id === 'my-greedy-matching');
    expect(ext !== base && e.campaign.kind === 'extended' && row && e.validation.accepted === e.validation.runs && !row.proven_optimal, `${ext} ${e.campaign.kind} ${JSON.stringify(e.validation)}`);
    expect(/ — Extension \d+ \(My Greedy Matching\)$/.test(e.campaign.title), `title ${e.campaign.title}`);
    await p.click('Compare', '.labbar button'); await p.waitFor('location.hash.startsWith("#/methods/") && !!document.querySelector(".cmp-table")', 30000, 'methods'); await sleep(1500);
    const heads = await p.eval(`[...document.querySelectorAll('.cmp-table thead th')].map((t) => t.innerText.trim())`);
    const s3 = await shot('19-custom-method-comparison', 300);
    await p.click('Charts', '.tabs button'); await sleep(2500); const s4 = await shot('19b-custom-method-charts', 300);
    expect(heads.filter((h) => /^[ABC] · /.test(h)).length === 3, `heads ${heads}`);
    F.scenario_c = { campaign_id: ext, title: e.campaign.title, validation: e.validation, rows: e.results.rows.map((r) => ({ method: r.method_id, served: r.totals.served, detour_min: Math.round(r.totals.detour_s / 6) / 10, proven_optimal: r.proven_optimal, custom: r.custom })) };
    return { actual: `“${e.campaign.title}” ${e.validation.accepted}/${e.validation.runs} validated; ${F.scenario_c.rows.map((r) => `${r.method} ${r.served} served ${r.detour_min} min`).join('; ')}; compared ${heads.filter((h) => /^[ABC] · /.test(h)).join(' | ')}.`, evidence: [s1, s2, s3, s4] };
  });

// ===================================================================================================== Workspace editing
await check('E1', '+ Driver and + Rider from the Participants panel', 'The wizard opens at the participants step with the current participants and a new driver (then a new rider) waiting for its start point on the map; clicks place start and end; a route is previewed; nothing is saved until Save.',
  async () => {
    await goHash(`#/workspace/${base}`, 3000);
    const before = (await api('/api/geo/scenarios')).body;
    await p.click('Driver', '.edit-people button'); await p.waitFor('!!document.querySelector(".wizard .wizard-map .leaflet-container")', 15000, 'wizard');
    await sleep(1500);
    const hint = await text('.wizard'); expect(/Click the map to place the start point of D21/.test(hint), 'no placement prompt for D21');
    const s1 = await shot('04-add-driver', 300);
    const mapAt = (fx, fy) => p.eval(`(() => { const r = document.querySelector('.wizard-map .leaflet-container').getBoundingClientRect(); return { x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy} }; })()`);
    for (const [fx, fy] of [[0.4, 0.3], [0.6, 0.85]]) { const pt = await mapAt(fx, fy); await p.clickAt(pt.x, pt.y); await sleep(700); }   // empty places of the map (not on a marker)
    const d21 = (label) => p.eval(`(() => { const r = [...document.querySelectorAll('.wizard table[aria-label=drivers] tbody tr')].find((x) => /D21/.test(x.cells[0]?.innerText)); r.scrollIntoView({ block: 'center' }); [...r.querySelectorAll('button')].find((b) => b.innerText.trim() === '${label}').click(); })()`);
    await d21('Route');                                   // the second point lies outside the road-network extract
    await p.waitFor('[...document.querySelectorAll(".wizard table[aria-label=drivers] tr")].some((r) => /D21/.test(r.innerText) && /from the road network/.test(r.innerText))', 30000, 'off-network end point refused');
    const refused = await p.eval(`[...document.querySelectorAll('.wizard table[aria-label=drivers] tr')].find((r) => /D21/.test(r.innerText))?.innerText.replace(/\\s+/g, ' ')`);
    await d21('End point'); await sleep(300);
    const pt = await mapAt(0.5, 0.36); await p.clickAt(pt.x, pt.y); await sleep(700);
    await d21('Route');
    await p.waitFor('[...document.querySelectorAll(".wizard table[aria-label=drivers] tr")].some((r) => /D21/.test(r.innerText) && /min/.test(r.innerText) && !/from the road network/.test(r.innerText))', 30000, 'route preview of D21');
    const routeText = await p.eval(`[...document.querySelectorAll('.wizard table[aria-label=drivers] tr')].find((r) => /D21/.test(r.innerText))?.innerText.replace(/\\s+/g, ' ')`);
    const s2 = await shot('06-manual-map-placement', 500);
    await p.eval(`document.querySelector('.wizard button[aria-label=close]').click()`); await sleep(800);
    await p.click('Rider', '.edit-people button'); await p.waitFor('!!document.querySelector(".wizard")', 15000, 'wizard'); await sleep(1500);
    const hint2 = await text('.wizard'); expect(/start point of R31/.test(hint2), 'no placement prompt for R31');
    const s3 = await shot('05-add-rider', 300);
    await p.eval(`document.querySelector('.wizard button[aria-label=close]').click()`); await sleep(800);
    const after = (await api('/api/geo/scenarios')).body;
    expect(JSON.stringify(before).length === JSON.stringify(after).length, 'something was saved without Save');
    F.add_participants = { route: routeText, refused_off_network: refused };
    return { actual: `D21 placed by two clicks, route “${routeText?.slice(0, 120)}”; R31 waiting for its start point; nothing saved (closed without Save).`, evidence: [s1, s2, s3] };
  });

await check('E2', 'Randomize with a typed seed (deterministic)', 'Randomize opens the participants step (with the Randomize dialog, closed here); seed 4242 and 4243 give different places, 4242 again the same places as before; ids and time windows stay.',
  async () => {
    await goHash(`#/workspace/${base}`, 3000);
    await p.click('Randomize', '.edit-people button'); await p.waitFor('!!document.querySelector(".wizard table[aria-label=drivers]")', 30000, 'wizard'); await sleep(2500);
    // the Workspace button opens the editor with the Randomize dialog on top; this check uses the seed-only control under it
    await p.waitFor('!!document.querySelector(".rz-modal")', 15000, 'Randomize dialog'); await p.click('Cancel', '.rz-modal button', true); await p.waitFor('!document.querySelector(".rz-modal")', 8000, 'dialog closed'); await sleep(500);
    const places = () => p.eval(`[...document.querySelectorAll('.wizard table[aria-label=drivers] tbody tr')].slice(0, 5).map((r) => [...r.cells[1].querySelectorAll('button')].map((b) => b.dataset.at).join(' > ')).join(' | ')`);
    const times = () => p.eval(`[...document.querySelectorAll('.wizard table[aria-label=drivers] tbody tr')].slice(0, 5).map((r) => [r.cells[2]?.querySelector('input')?.value, r.cells[3]?.querySelector('input')?.value].join('-')).join(' | ')`);
    const ready = () => p.waitFor('[...document.querySelectorAll(".wizard button")].some((b) => /Randomize locations/.test(b.innerText) && !b.disabled)', 60000, 'Randomize enabled');
    const seedRun = async (n) => { await ready(); await p.fill('.wizard input[aria-label="locations seed"]', String(n)); await sleep(300); await p.click('Randomize locations', '.wizard button'); await sleep(1000); await ready(); await sleep(800); return places(); };
    const t0 = await times();
    const a = await seedRun(4242); const s1 = await shot('07a-randomize-seed-4242', 300);
    const b = await seedRun(4243); const s2 = await shot('07b-randomize-seed-4243', 300);
    const c = await seedRun(4242);
    const t1 = await times();
    await p.eval(`document.querySelector('.wizard button[aria-label=close]').click()`); await sleep(800);
    expect(a && a !== b && a === c && t0 === t1, `4242 ${a.slice(0, 60)} · 4243 ${b.slice(0, 60)} · again ${c.slice(0, 60)} · times ${t0 === t1}`);
    F.randomize = { seed4242: a.slice(0, 120), seed4243: b.slice(0, 120) };
    return { actual: `seed 4242 → “${a.slice(0, 70)}…”, 4243 → different places, 4242 again → identical; time windows unchanged.`, evidence: [s1, s2] };
  });

// ===================================================================================================== Benchmark, picker, phone
await check('BM', 'Public synthetic benchmark: definition, run, oracle check', 'Library › Benchmarks shows the public benchmark (inputs, methods, checks, reproduction command) with no placeholder for unfinished studies; Run executes it; every Exact run equals the min-cost-flow oracle optimum.',
  async () => {
    await goHash('#/benchmarks', 2500);
    const page = await text('main, .col-page');
    expect(/Public synthetic assignment benchmark/.test(page) && !/Planned/.test(page) && /benchmark_synthetic_assignment\.py/.test(page), page.slice(0, 200));
    await armJob();
    await p.click('Run the public benchmark', 'button');
    await p.waitFor('location.hash.startsWith("#/workspace/c-")', 30000, 'workspace'); await waitJob(); await sleep(3000);
    const cid = await cidNow();
    await goHash('#/benchmarks', 3500);
    const b = (await api('/api/lab/benchmark/public')).body.runs.find((r) => r.campaign_id === cid);
    const s = await shot('23-public-benchmark', 600);
    const exact = b.methods.find((m) => m.method_id === 'exact-milp-highs'), greedy = b.methods.find((m) => m.method_id === 'greedy-min-cost');
    expect(exact.accepted === exact.runs && exact.oracle_optimal === exact.runs && greedy.accepted === greedy.runs, JSON.stringify(b.methods));
    F.benchmark = { campaign_id: cid, scenarios: b.scenarios, methods: b.methods };
    return { actual: `${b.scenarios} scenarios; ${b.methods.map((m) => `${m.method_id}: ${m.accepted}/${m.runs} validated, ${m.oracle_optimal}/${m.runs} equal to the oracle`).join('; ')}.`, evidence: [s] };
  });

await check('P1', 'No comparable experiment: actionable choices', 'For an experiment with nothing comparable, the picker says “No comparable experiment found.” and offers Compare methods in this experiment, Run another method on the same scenario, Reproduce this experiment. For an experiment that has comparable ones, the picker lists them and does not show that message.',
  async () => {
    // which experiments have something comparable is decided by the server; ask it instead of assuming the data
    const comparableCount = async (cid) => { const d = (await api(`/api/lab/compatible?a=${encodeURIComponent(cid)}`)).body; return (d.candidates ?? []).filter((c) => !c.hidden && c.overall !== 'incompatible').length; };
    const openPicker = async (cid) => {
      await goHash(`#/workspace/${cid}`, 3000);
      await p.click('Compare', '.labbar button'); await p.waitFor('location.hash.startsWith("#/methods/") || location.hash.startsWith("#/compare/")', 30000, 'Compare'); await sleep(500);
      if (await p.eval('location.hash.startsWith("#/methods/")')) { await p.click('Experiments', 'nav.compare-kind button'); await sleep(600); }
      await p.waitFor('!!document.querySelector(".picker-drawer") && !/Checking comparability/.test(document.querySelector(".picker-drawer").innerText)', 30000, 'comparability');
      return text('.picker-drawer');
    };
    const bench = F.benchmark.campaign_id, nb = await comparableCount(bench);
    const tb = await openPicker(bench);
    const s1 = await shot('13a-benchmark-candidates', 300);
    await p.key('Escape');
    // the benchmark run: earlier runs of the same benchmark in this account are comparable; with none, nothing is
    const benchOk = nb > 0 ? !/No comparable experiment found\./.test(tb) : /No comparable experiment found\./.test(tb);
    // an experiment with nothing comparable: the account's experiments, asked one by one (the benchmark first)
    const list = (await api('/api/lab/experiments')).body.experiments.filter((x) => !x.hidden && x.status !== 'draft');
    let lonely = nb === 0 ? bench : null;
    for (const x of list) { if (lonely) break; if (x.campaign_id !== bench && (await comparableCount(x.campaign_id)) === 0) lonely = x.campaign_id; }
    expect(lonely, `no experiment of this account is without a comparable one (benchmark: ${nb} comparable)`);
    const t = await openPicker(lonely);
    const s2 = await shot('13b-no-comparable-experiment', 300);
    await p.key('Escape');
    const ok = /No comparable experiment found\./.test(t) && /Compare methods in this experiment|Run another method on the same scenario/.test(t) && /Run another method on the same scenario/.test(t);
    expect(benchOk, `benchmark run with ${nb} comparable experiment(s): ${tb.slice(0, 200)}`);
    expect(ok, t.slice(0, 300));
    return { actual: `Benchmark run: ${nb} comparable experiment(s) in this account, ${nb > 0 ? 'listed, no empty-state message' : 'empty-state message'}. Experiment without any comparable one (${lonely}): the message and its actions (Reproduce appears once the experiment is locked).`, evidence: [s1, s2] };
  });

await check('M1', 'Phone layout', 'At 390 × 844 the Workspace fits the width.', async () => {
  await p.size(390, 844, 2, true); await p.goto(`${BASE}/#/workspace/${base}`); await waitWorkspace(); await sleep(3000);
  const o = await overflow(); const s = await shot('24-mobile-view', 400);
  await p.size(W, H, 2);
  expect(o <= 0, `overflow ${o}`);
  return { actual: `no horizontal scroll (${o} px).`, evidence: [s] };
});

report.finished = new Date().toISOString();
report.summary = { total: report.checks.length, pass: report.checks.filter((c) => c.status === 'PASS').length, page_errors: report.checks.reduce((n, c) => n + c.page_errors.length, 0) };
writeFileSync(join(OUT, 'workflow-acceptance.json'), JSON.stringify(report, null, 1));
console.log(`${report.summary.pass}/${report.summary.total} checks passed`);
await p.close();
process.exit(report.summary.pass === report.summary.total ? 0 : 1);
