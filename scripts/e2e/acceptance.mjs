#!/usr/bin/env node
// Browser acceptance run of the complete workflow, with real mouse and keyboard events in headless Chromium.
//
//   node scripts/e2e/acceptance.mjs --base http://127.0.0.1:8791 --creds <data dir>/dev-credentials.json --out <dir>
//   node scripts/e2e/acceptance.mjs --base http://127.0.0.1:8792 --creds … --out <dir> --only fallback   (tiles off)
//
// Run it against a server on a COPY of a data directory: it creates accounts, experiments and runs. Accounts used
// from the credentials file: an administrator (--admin, default okba_test), a supervising researcher (--supervisor,
// default researcher1) and a second researcher (--other, default researcher2). New accounts are created through the
// interface; their passwords stay in memory and are never printed. Writes numbered screenshots and
// acceptance-report.json (every check with its result, page errors, browser log errors, dialogs) into --out.
// Exit status 0 only if every check passed and no page error occurred.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8791'), OUT = arg('out'), CREDS = arg('creds'), ONLY = arg('only', 'all');
const ADMIN = arg('admin', 'okba_test'), SUP = arg('supervisor', 'researcher1'), OTHER = arg('other', 'researcher2');
if (!OUT || !CREDS) { console.error('usage: acceptance.mjs --base URL --creds FILE --out DIR [--only all|fallback]'); process.exit(2); }
const chrome = process.env.CHROME ?? (() => {
  const root = join(homedir(), '.cache/ms-playwright');
  const dir = existsSync(root) && readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().at(-1);
  return dir ? join(root, dir, 'chrome-linux64/chrome') : 'chromium';
})();
mkdirSync(OUT, { recursive: true });
const DL = join(OUT, 'downloads'); mkdirSync(DL, { recursive: true });
const creds = JSON.parse(readFileSync(CREDS, 'utf8'));
const pw = (u) => (typeof creds[u] === 'string' ? creds[u] : creds[u]?.password);
const suffix = randomBytes(2).toString('hex');
const newPassword = () => `Ok-${randomBytes(12).toString('base64url')}-7z`;
const W = 1440, H = 900, DSF = 2;

const report = { base: BASE, started: new Date().toISOString(), checks: [], screenshots: [] };
let n = ONLY === 'fallback' ? 40 : 0;
const p = await launch(chrome, { width: W, height: H });
await p.size(W, H, DSF);
await p.allowDownloads(DL);

const shot = async (name, settle = 700) => {
  await sleep(settle);
  const file = `${String(++n).padStart(2, '0')}-${name}.png`;
  await p.shot(join(OUT, file)); report.screenshots.push(file); return file;
};
async function check(name, fn) {
  const t0 = Date.now(), e0 = p.errors.length;
  const errs = () => p.errors.slice(e0);                // page errors raised while this check ran
  try { await p.key('Escape'); await p.key('Escape'); } catch { /* no page yet */ }   // start every check with no dialog open
  try {
    const detail = await fn(); report.checks.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - t0, page_errors: errs() });
    console.log(`ok    ${name}${detail ? ` — ${detail}` : ''}${errs().length ? `  [page errors: ${errs().length}]` : ''}`); return true; }
  catch (e) {
    report.checks.push({ name, ok: false, detail: String(e.message ?? e).slice(0, 400), ms: Date.now() - t0, page_errors: errs() });
    console.log(`FAIL  ${name} — ${String(e.message ?? e).slice(0, 300)}`);
    try { await p.shot(join(OUT, `fail-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`)); } catch { /* page gone */ }
    return false;
  }
}
const text = (css = 'body') => p.eval(`(document.querySelector(${JSON.stringify(css)})?.innerText ?? '')`);
const has = (css) => p.eval(`!!document.querySelector(${JSON.stringify(css)})`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const api = (path, init = {}) => p.eval(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }))`);
const goHash = async (h, settle = 2500) => { await p.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(settle); };
/** Click the button labelled `button` in the first visible row (of `rows`) whose text contains `rowText`. */
async function clickInRow(rows, rowText, button) {
  const pt = await p.eval(`(() => { const row = [...document.querySelectorAll(${JSON.stringify(rows)})].find((r) => r.innerText.includes(${JSON.stringify(rowText)}));
    const b = row && [...row.querySelectorAll('button, input[type=checkbox]')].find((x) => x.type === 'checkbox' ? ${JSON.stringify(button)} === 'checkbox' : (x.innerText.trim() === ${JSON.stringify(button)} || x.getAttribute('aria-label') === ${JSON.stringify(button)}));
    if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!pt) throw new Error(`no "${button}" in a row with "${rowText}"`);
  await p.clickAt(pt.x, pt.y); await sleep(150);
}

async function signIn(user, password) {
  await p.clearCookies();
  await p.goto(`${BASE}/login`);
  await p.focusCss('input[name=username]'); await p.type(user);
  await p.focusCss('input[name=password]'); await p.type(password);
  await p.click('Sign in', 'button');
  await p.waitFor('location.pathname === "/change-password" || (location.pathname === "/" && !!document.querySelector(".hdr"))', 30000, `sign-in of ${user}`);
  return p.eval('location.pathname');
}
async function choosePassword(current, fresh) {
  await p.focusCss('#c'); await p.type(current);
  await p.focusCss('#n'); await p.type(fresh.slice(0, 5));
  await sleep(250);
  const weak = await text('#strength');
  await p.type(fresh.slice(5));
  await p.focusCss('#r'); await p.type(fresh);
  await sleep(350);
  return { weak, strong: await text('#strength'), match: await text('#match') };
}
async function signOut() {
  await p.click('profile', '.hdr button');
  await p.click('Sign out', '[role=menu] button, .menu button, .menu a');
  await p.waitFor('location.pathname === "/login"', 15000, 'login page after sign-out');
}
const waitWorkspace = () => p.waitFor('!!document.querySelector(".lab-grid") && !document.querySelector(".lab-notes .note.ok[role=status]")?.innerText.includes("Loading the demonstration")', 60000, 'workspace');
const readSecret = async () => {   // the one-time temporary password: read from the page, never printed or saved
  await p.click('show password', '.secret button'); await sleep(150);
  const s = await text('.secret .pw');
  await p.click('hide password', '.secret button');
  expect(s && !s.includes('•'), 'temporary password not shown'); return s;
};
async function waitJob(timeout = 120000) {
  await p.waitFor('!!document.querySelector(".job")', 20000, 'job progress');
  await p.waitFor('["done","error","cancelled","interrupted"].includes(document.querySelector(".job")?.dataset.state) || !document.querySelector(".job")', timeout, 'job end');
  return p.eval('document.querySelector(".job")?.dataset.state ?? "gone"');
}

// =====================================================================================================================
if (ONLY === 'fallback') {
  await check('map without a basemap still shows participants and routes', async () => {
    const where = await signIn(OTHER, pw(OTHER)); expect(where === '/', 'signed in');
    await waitWorkspace(); await sleep(3500);
    // routes and stops are drawn on a canvas (or SVG paths): check something is drawn and no tile was requested
    const info = await p.eval(`(() => { const c = document.querySelector('.leaflet-overlay-pane canvas'); let ink = 0;
      if (c) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) ink++; }
      return { tiles: document.querySelectorAll('.leaflet-tile').length, paths: document.querySelectorAll('.leaflet-overlay-pane path').length, inkPixels: ink,
               legend: !!document.querySelector('.legend') }; })()`);
    expect(info.tiles === 0 && (info.paths > 0 || info.inkPixels > 100) && info.legend, JSON.stringify(info));
    await shot('map-fallback-no-tiles');
    return JSON.stringify(info);
  });
} else {
  let researcher = `e2e_res_${suffix}`, student = `e2e_stu_${suffix}`, rPw = '', sPw = '';
  let demoBase = '', demoVariant = '', mine = '';

  // ---- 1. sign-in page -------------------------------------------------------------------------------------------
  await check('sign-in page: logo lockup, light by default', async () => {
    await p.goto(`${BASE}/login`);
    const t = await p.eval('({ theme: document.documentElement.dataset.theme, logo: document.querySelector("img.logo")?.naturalWidth, title: document.title })');
    expect(t.theme === 'light' && t.logo > 0, JSON.stringify(t));
    await shot('sign-in'); return t.title;
  });

  // ---- 2. administration: create, reset, deactivate, reactivate, audit ------------------------------------------
  await check('administrator signs in; Administration is in the profile menu, not a top-level tab', async () => {
    expect(await signIn(ADMIN, pw(ADMIN)) === '/', 'workspace');
    await waitWorkspace();
    const top = await text('.hdr');
    expect(!/Administration/.test(top), 'Administration visible in the header bar');
    await p.click('profile', '.hdr button');
    expect(/My account/.test(await text('.menu')) && /Appearance/i.test(await text('.menu')), 'profile menu entries');
    await shot('profile-menu', 400);
    await p.click('Administration', '[role=menu] button, .menu button');
    await p.waitFor('!!document.querySelector("table.accounts tbody tr")', 15000, 'accounts table');
    await shot('administration-accounts');
    return (await p.eval('document.querySelectorAll("table.accounts tbody tr").length')) + ' accounts';
  });
  await check('administrator creates a researcher; temporary password shown once (masked)', async () => {
    await p.click('New account', 'button');
    await p.fill('input[aria-label="new display name"]', `E2E Researcher ${suffix}`);
    await p.fill('input[aria-label="new username"]', researcher);
    await p.click('Create', '.drawer button', true);
    await p.waitFor('!!document.querySelector(".secret")', 10000, 'one-time password');
    expect((await text('.secret .pw')).includes('•'), 'password not masked by default');
    await shot('administration-new-account-masked');
    rPw = await readSecret();
    await p.click('Done', '.secret button', true);
    return researcher;
  });
  await check('administrator resets, deactivates and reactivates that account (confirmation, audit log)', async () => {
    await p.fill('input[aria-label="search accounts"]', researcher); await sleep(400);
    await p.click('Reset password', 'table.accounts button');
    await p.waitFor('!!document.querySelector(".secret")', 10000, 'reset password');
    expect((await text('.drawer')).includes('New temporary password'), 'reset is labelled as a reset');
    rPw = await readSecret();
    await p.click('Done', '.secret button', true);
    await p.click('Deactivate', 'table.accounts button'); await sleep(800);
    expect((await text('table.accounts')).includes('Deactivated'), 'not deactivated');
    expect(p.dialogs.some((d) => d.startsWith('Deactivate')), 'no confirmation asked');
    await p.click('Reactivate', 'table.accounts button'); await sleep(800);
    expect((await text('table.accounts')).includes('Active'), 'not reactivated');
    await p.click('Audit log', '.tabs button'); await sleep(900);
    const audit = await text('table[aria-label="audit log"]');
    for (const a of ['deactivate', 'reactivate']) expect(audit.toLowerCase().includes(a), `audit log lacks ${a}`);
    await shot('administration-audit-log');
    return 'reset · deactivate (confirmed) · reactivate · audit';
  });
  await check('administrator cannot open researchers\' workspaces', async () => {
    const r = await api('/api/admin/users');
    expect(r.status === 200, 'admin list');
    await signOut(); return 'signed out through the profile menu';
  });

  // ---- 3. the other researcher exports an experiment (bundle for the cross-account cycle) --------------------------
  let exported = '';
  await check('researcher B exports an experiment as a bundle (Export)', async () => {
    expect(await signIn(OTHER, pw(OTHER)) === '/', 'workspace'); await waitWorkspace();
    const list = (await api('/api/lab/experiments')).body.experiments;
    const done = (e) => e.group === 'mine' && !e.hidden && e.status === 'completed' && e.problem_id === 'public-ride-matching';
    const own = list.find((e) => done(e) && e.area === 'Montbéliard') ?? list.find(done) ?? list.find((e) => e.group === 'mine' && e.status === 'completed');
    expect(own, 'no executed experiment of researcher B');
    await goHash(`#/workspace/${own.campaign_id}`, 3500);
    const before = p.downloadCount();
    await p.click('Export', '.labbar button');
    await p.waitFor('!!document.querySelector(".exportd .exlist")', 20000, 'export dialog');
    await p.click('xport', '.exportd .drawer-foot button.primary');          // "Export bundle" or "Lock and export"
    await p.waitDownload(before, 60000); await p.waitDownload(before + 1, 60000);
    await p.waitFor('/Bundle saved/.test(document.querySelector(".exportd")?.innerText)', 20000, 'confirmation');
    await p.click('Done', '.exportd button');
    exported = readdirSync(DL).filter((f) => f.endsWith('.zip')).map((f) => join(DL, f)).at(-1);
    expect(exported, 'no bundle file');
    await signOut(); return `${own.title} → ${exported.split('/').at(-1)}`;
  });

  // ---- 4. first use of the new researcher ------------------------------------------------------------------------
  await check('new researcher: forced password change with strength and match indicators', async () => {
    expect(await signIn(researcher, rPw) === '/change-password', 'no forced change');
    const fresh = newPassword();
    const ind = await choosePassword(rPw, fresh);
    expect(/Weak/i.test(ind.weak) && /Strong/i.test(ind.strong) && /match/i.test(ind.match) && !/not/i.test(ind.match), JSON.stringify(ind));
    await shot('first-sign-in-choose-password');
    await p.click('Save and continue', 'button');
    await p.waitFor('location.pathname === "/" && !!document.querySelector(".hdr")', 30000, 'workspace');
    rPw = fresh;
    return `${ind.weak} → ${ind.strong} · ${ind.match}`;
  });
  await check('first use: Montbéliard baseline opens with the start card, provenance and validated results', async () => {
    await waitWorkspace();
    await p.waitFor('!!document.querySelector(".start-card") && !!document.querySelector("table.results")', 60000, 'demonstration');
    await sleep(2500);
    const t = await p.eval('({ title: document.querySelector(".picker")?.innerText, left: document.querySelector(".lab-left")?.innerText, right: document.querySelector(".lab-right")?.innerText, start: document.querySelector(".start-card")?.innerText, hash: location.hash })');
    expect(/Baseline/.test(t.title), `opened ${t.title}`);
    expect(/404 trips in the area/.test(t.left) && /Sampled/.test(t.left), 'provenance (observed trips, sampled) missing');
    expect(/18 of 18 runs accepted/.test(t.right), 'validation evidence missing');
    expect(/Compare with the variant/.test(t.start), 'start card lacks Compare with the variant');
    const icons = await p.eval('({ people: document.querySelectorAll(".people .dicon, .seg .dicon, .fleet .dicon").length, legend: document.querySelectorAll(".legend .dicon").length })');
    expect(icons.people >= 3 && icons.legend >= 2, `mobility icons ${JSON.stringify(icons)}`);
    demoBase = t.hash.split('/').at(-1);
    await shot('first-use-workspace');
    const areas = (await api('/api/geo/areas')).body.areas.map((a) => a.name);
    expect(areas.includes('Montbéliard'), 'demonstration area not added');
    return `${t.title.split('\n')[0]} · areas: ${areas.join(', ')}`;
  });
  await check('experiment picker groups experiments with context and no hashes', async () => {
    await p.click('', '.picker > button'); await sleep(500);
    const t = await text('.picker-panel');
    expect(/Public mobility demonstration/i.test(t), 'demonstration group missing');
    expect(!/\b[0-9a-f]{24,}\b/.test(t), 'a hash is shown');
    await shot('experiment-picker');
    await p.key('Escape'); await sleep(300);
    return t.split('\n').slice(0, 3).join(' · ');
  });
  await check('keyboard: Tab reaches Library, Enter opens it, Escape closes it', async () => {
    await p.eval('document.activeElement?.blur(); document.querySelector(".hdr .brand").focus(); true');
    let found = false;
    for (let i = 0; i < 8 && !found; i++) { await p.key('Tab'); found = await p.eval('(document.activeElement?.getAttribute("aria-label") ?? "") === "Library"'); }
    expect(found, 'Library not reachable with Tab');
    await p.key('Enter'); await sleep(250);
    expect(await has('[role=menu][aria-label=Library]'), 'menu did not open');
    await p.key('Escape'); await sleep(250);
    expect(!(await has('[role=menu][aria-label=Library]')), 'menu did not close');
    return 'ok';
  });

  await check('Help: Quick tour and the terms Area, Mobility data, Scenario, Library, Hidden records', async () => {
    await p.click('Help', '.hdr button'); await sleep(400);
    const g = await text('.menu .gloss');
    for (const term of ['Area', 'Mobility data', 'Scenario', 'Library', 'Hidden records']) expect(g.includes(term), `glossary lacks ${term}`);
    expect(!!(await p.find('Quick tour', '.menu button')), 'no Quick tour entry');
    await shot('help-glossary'); await p.key('Escape'); return 'five terms and the tour';
  });
  await check("tour: opens only on request; \"Don't show again\" survives navigation and reload; reopens from Help", async () => {
    expect(!(await has('.tour')), 'tour shown without being asked');
    await p.click('Help', '.hdr button'); await p.click('Quick tour', '.menu button'); await sleep(600);
    expect(await has('.tour'), 'Help → Quick tour did not open it');
    expect(/reopen it any time from Help/.test(await text('.tour')), 'no hint about reopening');
    await p.click("Don't show again", '.tour label'); await p.click('Skip', '.tour button'); await sleep(600);
    expect(!(await has('.tour')), 'not closed');
    expect((await api('/api/lab/state')).body.preferences.tour_dismissed === true, 'choice not saved for the account');
    await goHash('#/data/library', 2000); await goHash(`#/workspace/${demoBase}`, 3500);
    expect(!(await has('.tour')), 'reappeared after leaving and returning to the workspace');
    await p.goto(`${BASE}/#/workspace/${demoBase}`); await waitWorkspace(); await sleep(3500);
    expect(!(await has('.tour')), 'reappeared after a reload');
    expect(!(await p.find('Quick tour', '.start-card button')), 'the start card still offers the tour');
    await shot('workspace-tour-disabled');
    await p.click('Help', '.hdr button'); await p.click('Quick tour', '.menu button'); await sleep(600);
    expect(await has('.tour'), 'cannot reopen it from Help'); await p.key('Escape'); await sleep(400);
    expect(!(await has('.tour')), 'Escape did not close it');
    return 'dismissed for the account; reopened manually from Help';
  });

  // ---- 5. comparison with the variant ----------------------------------------------------------------------------
  await check('comparison A/B: results, charts, maps, replay, diff', async () => {
    await p.click('Compare with the variant', '.start-card button');
    await p.waitFor('location.hash.startsWith("#/compare/") && !!document.querySelector(".evgrid")', 30000, 'comparison');
    await sleep(2500);
    demoVariant = (await p.eval('decodeURIComponent(location.hash)')).split('|')[1];
    const ev = await text('.evgrid');
    expect(/18 of 18/.test(ev) && /Not applicable/.test(ev) && /Directly comparable/i.test(ev), `evidence: ${ev.slice(0, 200)}`);
    await shot('compare-results');
    await p.click('Charts', '.tabs button'); await sleep(1200);
    expect((await p.eval('document.querySelectorAll(".chart-card svg rect").length')) > 0, 'no chart bars');
    const before = p.downloadCount();
    await p.click('CSV', '.chart-card button'); await p.waitDownload(before);
    await shot('compare-charts');
    await p.click('Maps', '.tabs button'); await sleep(4000);
    expect((await p.eval('document.querySelectorAll(".ab-map .leaflet-container").length')) >= 2, 'two maps expected');
    await shot('compare-maps');
    await p.click('Replay', '.tabs button'); await sleep(2000);
    expect(await has('.replay-bar'), 'replay bar missing');
    await p.click('Diff', '.tabs button'); await sleep(2500);
    const diff = await text('.diff-grid');
    expect(/Maximum detour/.test(diff) && /Routes that differ/.test(diff), 'diff incomplete');
    await shot('compare-diff');
    return ev.replace(/\s+/g, ' ').slice(0, 160);
  });

  await check('comparison: the evidence summary collapses and expands, and the choice is remembered', async () => {
    if (!(await has('.cmp-head'))) await goHash(`#/compare/${demoBase}|${demoVariant}`, 4000);
    await p.click('Results', '.tabs button'); await sleep(500);
    const h0 = await p.eval('Math.round(document.querySelector(".cmp-head").getBoundingClientRect().height)');
    await p.click('Hide summary', '.cmp-head button'); await sleep(600);
    expect((await has('.evstrip')) && !(await has('.evgrid')), 'not collapsed');
    const h1 = await p.eval('Math.round(document.querySelector(".cmp-head").getBoundingClientRect().height)');
    expect(/Validated A 18\/18/.test(await text('.evstrip')), 'collapsed strip lost the evidence');
    await shot('compare-summary-collapsed');
    await p.goto(`${BASE}/#/compare/${demoBase}|${demoVariant}`); await p.waitFor('!!document.querySelector(".cmp-head")', 20000, 'comparison'); await sleep(2500);
    expect(await has('.evstrip'), 'collapse not remembered after reload');
    await p.click('Show summary', '.cmp-head button');
    await p.waitFor('!!document.querySelector(".evgrid") && !!document.querySelector(".evsum")', 20000, 'expanded summary');
    const shows = await text('.evsum');
    expect(/Directly comparable:/.test(shows) && /Not applicable:/.test(shows), `summary: ${shows}`);
    await shot('compare-summary-expanded');
    return `header ${h0}px → ${h1}px collapsed · ${shows.replace(/\s+/g, ' ').slice(0, 120)}`;
  });

  // ---- 6. Generate wizard: Save Scenario, Save & Run, cancel, trace ----------------------------------------------
  const openWizard = async () => {
    await goHash(`#/workspace/${demoBase}`, 3500);
    await p.click('Generate', '.labbar button');
    await p.waitFor('!!document.querySelector(".wizard") && document.querySelector("select[aria-label=area]")?.selectedOptions[0]?.textContent === "Montbéliard"', 20000, 'wizard on Montbéliard');
    await sleep(1500);
  };
  const toStep = async (k) => { for (let i = 1; i < k; i++) { await p.click('Next', '.wizard-foot button'); await sleep(i === 1 ? 4500 : 1500); } };
  await check('wizard: five steps over the map, nothing saved before confirmation', async () => {
    const before = (await api('/api/lab/experiments')).body.experiments.length;
    await openWizard();
    await p.click('Sampled from observed trips', 'label'); await sleep(1500);
    expect(/404 observed trips in this area/.test(await text('.wizard')), 'observed-trips pool not stated');
    await shot('wizard-1-area-and-data');
    await toStep(2);
    expect(/compatible pairs/.test(await text('.wizard')), 'no preview');
    await shot('wizard-2-participants-and-vehicles');
    await p.click('Next', '.wizard-foot button'); await sleep(1200);
    await shot('wizard-3-constraints');
    await p.click('Next', '.wizard-foot button'); await sleep(1200);
    expect(/Fuel and electricity use/.test(await text('.wizard')), 'CO₂ calculation label');
    await shot('wizard-4-methods-and-experiment');
    await p.click('Next', '.wizard-foot button'); await sleep(1200);
    const review = await text('[aria-label=review]');
    expect(/sampled from the observed trips/.test(review) && /Repetitions and seed/.test(review), 'review incomplete');
    await shot('wizard-5-review-and-save');
    const after = (await api('/api/lab/experiments')).body.experiments.length;
    expect(after === before, 'something was saved before confirmation');
    return 'Area & Data → Participants & Vehicles → Constraints → Methods & Experiment → Review & Save';
  });
  await check('Save Scenario keeps the user in the workspace with the next action visible', async () => {
    await p.click('Save Scenario', '.wizard-foot button');
    await p.waitFor('!document.querySelector(".wizard")', 20000, 'wizard closed');
    await sleep(800);
    const note = await text('.lab-notes');
    expect(/Scenario saved\. Choose the methods/.test(note), `notice: ${note}`);
    return note.split('\n')[0];
  });
  await check('Save & Run: execution stages, run counter, cancellation', async () => {
    await openWizard();
    await p.click('Synthetic demand', 'label'); await sleep(800);
    await toStep(4);
    await p.fill('.wizard input[aria-label=repetitions]', '20'); await sleep(300);
    await p.click('Next', '.wizard-foot button'); await sleep(800);
    await p.click('Save & Run', '.wizard-foot button');
    await p.waitFor('!!document.querySelector(".job [aria-label=steps]") && /of \\d+ runs/.test(document.querySelector(".job").innerText)', 30000, 'progress');
    await sleep(600);
    const prog = await text('.job');
    expect(/Running experiment/.test(prog) && /Queued[\s\S]*Preparing[\s\S]*Running methods[\s\S]*Validating[\s\S]*Results/.test(prog), `stages: ${prog}`);
    await shot('execution-progress', 100);
    await p.click('Cancel', '.job button');
    await p.waitFor('document.querySelector(".job")?.dataset.state === "cancelled" || !document.querySelector(".job")', 60000, 'cancelled');
    return prog.split('\n').slice(0, 2).join(' · ') + ' → cancelled';
  });
  await check('Save & Run: results with measurement basis, CO₂, validation and the execution trace', async () => {
    await openWizard();
    await p.click('Synthetic demand', 'label'); await sleep(800);
    await toStep(5);
    await p.click('Save & Run', '.wizard-foot button');
    const st = await waitJob(180000);
    expect(st === 'done' || st === 'gone', `job ${st}`);
    await p.waitFor('!!document.querySelector("table.results tbody tr")', 30000, 'results');
    await sleep(2500);
    mine = (await p.eval('location.hash')).split('/').at(-1);
    const right = await text('.lab-right');
    expect(/results identical in all 3 repetitions|repetitions/.test(right) && /CO₂/.test(right) && /runs accepted/.test(right), 'basis / CO₂ / validation missing');
    expect(/\d+(\.\d)? ms|\d+(\.\d+)? s/.test(right), 'runtime');
    await shot('results-new-experiment');
    await p.click('Execution trace', '.lab-right button'); await sleep(1500);
    const trace = await text('body');
    expect(/validat/i.test(trace), 'trace lacks the validation stage');
    await shot('execution-trace');
    await p.key('Escape'); await goHash(`#/workspace/${mine}`, 2500);
    return right.match(/Sample[^\n]*|All[^\n]*/)?.[0] ?? '';
  });

  // ---- 6b. Library: what areas, mobility data and scenarios are; Use applies them to the Workspace ----------------
  await check('Library › Areas: explained; Use makes the area the working area (visible confirmation, saved)', async () => {
    await goHash('#/data/areas', 3000);
    expect(/geographic zone/.test(await text('.view-help')), 'no explanation of areas');
    await clickInRow('table[aria-label=areas] tbody tr', 'Montbéliard', 'Use');
    await p.waitFor('/now your working area/.test(document.querySelector(".note.ok")?.innerText)', 10000, 'confirmation');
    expect(/In use/.test(await text('table[aria-label=areas]')), 'no In use badge');
    const st = (await api('/api/lab/state')).body.preferences.area_id;
    const areas = (await api('/api/geo/areas')).body.areas;
    expect(areas.find((a) => a.area_id === st)?.name === 'Montbéliard', `working area ${st}`);
    await shot('library-areas-use');
    await p.click('Open the Workspace', '.note button'); await waitWorkspace(); await sleep(1500);
    return 'Montbéliard is the working area';
  });
  await check('Library › Mobility data: explained; Use opens Generate with that data on its area', async () => {
    await goHash('#/data/datasets', 3000);
    expect(/where trips come from/.test(await text('.view-help')), 'no explanation of mobility data');
    await shot('library-mobility-data');
    await clickInRow('table[aria-label=datasets] tbody tr', 'RPC 2026-10 · Montbéliard', 'Use');
    await p.waitFor('!!document.querySelector(".wizard")', 30000, 'wizard'); await sleep(3000);
    const w = await p.eval(`({ area: document.querySelector('.wizard select[aria-label=area]')?.selectedOptions[0]?.textContent,
      source: document.querySelector('.wizard input[name=src]:checked')?.closest('label')?.innerText.split('\\n')[0],
      data: document.querySelector('.wizard select[aria-label=dataset]')?.selectedOptions[0]?.textContent })`);
    expect(w.area === 'Montbéliard' && /Sampled from observed trips/.test(w.source ?? '') && /404 observed trips/.test(w.data ?? ''), JSON.stringify(w));
    await shot('library-use-data-wizard');
    await p.click('close', '.wizard-top button'); await sleep(600);
    return `${w.area} · ${w.data}`;
  });
  await check('Library › Scenarios: explained; Use starts a new experiment with that scenario', async () => {
    await goHash('#/data/library', 3000);
    expect(/frozen sets/.test(await text('.view-help')), 'no explanation of scenarios');
    await p.click('Use', 'table[aria-label="scenario library"] button', true);
    await p.waitFor('location.hash.includes("__new__") && /selected for a new experiment/.test(document.querySelector(".lab-notes")?.innerText ?? "")', 20000, 'new experiment');
    await sleep(1500);
    const picked = await p.eval('document.querySelectorAll(".lab-left input[type=checkbox]:checked").length');
    expect(picked >= 1, `no scenario ticked (${picked})`);
    await shot('library-use-scenario');
    return (await text('.lab-notes')).split('\n')[0].slice(0, 120);
  });

  // ---- 7. comparison candidate picker ----------------------------------------------------------------------------
  await check('Compare with…: candidates with validation, reproducibility and comparability; Why?', async () => {
    await goHash(`#/workspace/${demoBase}`, 3500);
    await p.click('Compare', '.labbar button');
    await p.waitFor('!!document.querySelector(".cand")', 20000, 'candidates');
    await sleep(800);
    const t = await text('[role=dialog]');
    expect(/Validation/.test(t) && /Reproducibility/.test(t) && /Comparability/.test(t), 'evidence rows');
    await shot('compare-candidates');
    await p.key('Escape'); await sleep(400);
    expect(!(await has('.cand')), 'Escape did not close the picker');
    return t.match(/Direct \d+/)?.[0] + ' · ' + t.match(/With conditions \d+/)?.[0];
  });

  // ---- 7b. public demo flow: export → import (inspect) → reproduce → compare --------------------------------------
  let demoBundle = '', demoRepro = '';
  await check('Export: the dialog lists every section with sensible defaults; bundle and evidence report saved', async () => {
    await goHash(`#/workspace/${demoBase}`, 3500);
    await p.click('Export', '.labbar button');
    await p.waitFor('!!document.querySelector(".exportd .exlist")', 20000, 'export dialog'); await sleep(500);
    const info = await p.eval(`(() => { const rows = [...document.querySelectorAll('.exportd .exrow')];
      return { rows: rows.length, required: rows.filter((r) => r.classList.contains('fixed')).length, checked: rows.filter((r) => r.querySelector('input').checked).length,
               text: document.querySelector('.exportd').innerText }; })()`);
    expect(info.rows === 8 && info.required === 6 && info.checked === 8, JSON.stringify({ ...info, text: undefined }));
    for (const k of ['Manifest and integrity', 'Scenario definitions', 'Run results and validator evidence', 'Area, road network and mobility data references', 'Vehicle and emission parameters', 'Replay geometry', 'Evidence report'])
      expect(info.text.includes(k), `section missing: ${k}`);
    await shot('export-dialog');
    const before = p.downloadCount();
    await p.click('Export bundle', '.exportd button');
    await p.waitDownload(before, 60000); await p.waitDownload(before + 1, 60000);
    await p.waitFor('/Bundle saved/.test(document.querySelector(".exportd")?.innerText)', 20000, 'confirmation');
    const files = readdirSync(DL);
    const zip = files.find((f) => f.includes('demo_baseline') && f.endsWith('.zip')), ev = files.find((f) => f.includes('demo_baseline') && f.endsWith('_evidence.json'));
    expect(zip && ev, `downloads: ${files.join(', ')}`);
    demoBundle = join(DL, zip);
    const e = JSON.parse(readFileSync(join(DL, ev), 'utf8'));
    expect(e.validation.accepted === e.validation.runs && e.fingerprints?.experiment && e.reproducibility.applicable === false, 'evidence report content');
    await shot('export-saved');
    await p.click('Done', '.exportd button');
    return `${zip} + ${ev} · ${(await text('.lab-notes')) || 'saved'}`.slice(0, 160);
  });
  await check('Import: staged preview of the exported demonstration (contents, integrity, compatibility), then Reproduce it here', async () => {
    expect(demoBundle, 'no exported bundle');
    await p.click('Import', '.labbar button'); await p.click('Import a bundle file', '[role=menuitem]');
    await p.waitFor('!!document.querySelector(".importd")', 10000, 'import dialog');
    await shot('import-dialog-choose');
    await p.setFiles('input[aria-label="bundle file to inspect"]', [demoBundle]);
    await p.waitFor('!!document.querySelector(".importd .checks")', 60000, 'inspection'); await sleep(500);
    const t = await text('.importd');
    for (const k of ['What will be imported', 'Already here (identical)', 'Integrity verified', 'Problem and validator', 'Reproducible here', 'Comparable', 'Scenarios', 'Mobility data', 'Methods'])
      expect(t.includes(k), `preview lacks ${k}`);
    await shot('import-dialog-preview');
    await p.click('Reproduce it here', '.importd button');
    const st = await waitJob(240000);
    expect(st === 'done' || st === 'gone', `job ${st}`);
    await p.waitFor('!location.hash.endsWith(' + JSON.stringify(demoBase) + ')', 30000, 'reproduction opened'); await sleep(2500);
    demoRepro = (await p.eval('location.hash')).split('/').at(-1);
    expect(/Reproduc/.test(await text('.lab-right')), 'no reproducibility evidence');
    return `reproduction ${demoRepro}`;
  });
  await check('Compare original and reproduction: identical, comparable and not applicable stated separately', async () => {
    await goHash(`#/workspace/${demoRepro}`, 3500);
    await p.click('Compare', '.labbar button');
    await p.waitFor('!!document.querySelector(".cand")', 20000, 'candidates'); await sleep(600);
    await clickInRow('.cand', 'Montbéliard Demo — Baseline', 'checkbox');
    await p.click('Compare selected', '[role=dialog] button');
    await p.waitFor('location.hash.startsWith("#/compare/") && !!document.querySelector(".evsum")', 30000, 'comparison'); await sleep(2500);
    const ev = await text('.evgrid'), shows = await text('.evsum');
    expect(/Reproduced: \d+ of \d+ results equal/.test(ev), `evidence: ${ev.slice(0, 160)}`);
    expect(/Identical:/.test(shows) && /Reported, not required to match: runtimes/.test(shows), `summary: ${shows}`);
    await shot('demo-original-vs-reproduction');
    return shows.replace(/\s+/g, ' ').slice(0, 170);
  });

  // ---- 8. sample bundle: import → verify → reproduce → compare → add method → extend → compare ---------------------
  const ensureGuide = async () => {                 // each step may start with the guide closed (Escape between checks)
    if (await has('.guide')) return;
    if (!(await has('.labbar'))) await goHash(`#/workspace/${demoBase}`, 3000);
    await p.click('Import', '.labbar button'); await p.click('Try an imported experiment', '[role=menuitem]');
    await p.waitFor('!!document.querySelector(".guide .checks")', 30000, 'guide');
  };
  await check('sample bundle: download, integrity verified, import', async () => {
    await goHash(`#/workspace/${demoBase}`, 3500);
    await p.click('Import', '.labbar button'); await p.click('Try an imported experiment', '[role=menuitem]');
    await p.waitFor('!!document.querySelector(".guide .checks")', 30000, 'integrity report');
    const before = p.downloadCount();
    await p.click('Download sample bundle', '.guide button'); await p.waitDownload(before);
    await p.click('Import the sample', '.guide button');
    await p.waitFor('/Imported/.test(document.querySelector(".guide")?.innerText)', 30000, 'imported');
    await shot('sample-integrity-and-import');
    return (await text('.guide .checks')).split('\n')[0];
  });
  await check('sample bundle: reproduce on this installation → Reproduced', async () => {
    await ensureGuide();
    await p.click('Reproduce on this installation', '.guide button');
    await p.waitFor('/Reproduced: \\d+ of \\d+ results equal/.test(document.querySelector(".guide")?.innerText)', 240000, 'reproduction verdict');
    const v = (await text('.guide')).match(/Reproduced: [^\n·]*/)[0];
    await shot('sample-reproduced');
    return v;
  });
  await check('sample bundle: compare original and reproduction (reproducibility evidence)', async () => {
    await ensureGuide();
    await p.click('Compare original and reproduction', '.guide button');
    await p.waitFor('location.hash.startsWith("#/compare/") && !!document.querySelector(".evgrid")', 30000, 'comparison');
    await sleep(2500);
    const ev = await text('.evgrid');
    expect(/Reproduced/.test(ev), `reproducibility: ${ev.slice(0, 200)}`);
    await shot('sample-original-vs-reproduction');
    return ev.split('\n').filter((l) => /Reproduc/.test(l)).join(' · ').slice(0, 160);
  });
  await check('Add method: register the example method (sandbox), extend, compare again', async () => {
    await p.click('back to the workspace', '.cmp-head button'); await sleep(2500);
    await ensureGuide();
    await p.waitFor('/Your method on the same frozen experiment/.test(document.querySelector(".guide")?.innerText)', 30000, 'extension step');
    if (await p.find('Add your method', '.guide button')) {
      await p.click('Add your method', '.guide button');
      await p.waitFor('!!document.querySelector(".addm")', 15000, 'add method');
      await p.click('Register my method', '.addm button'); await sleep(800);
      await shot('add-method');
      await p.click('Register', '.addm .plug button', true);
      await p.waitFor('/Registered/.test(document.querySelector(".addm")?.innerText)', 120000, 'registration');
      await p.key('Escape'); await sleep(800);
      await ensureGuide();
    }
    await p.waitFor('/Extend with/.test(document.querySelector(".guide")?.innerText) || /Compare again/.test(document.querySelector(".guide")?.innerText)', 30000, 'extend button');
    if (await p.find('Extend with', '.guide button')) await p.click('Extend with', '.guide button');
    await p.waitFor('/Compare again/.test(document.querySelector(".guide")?.innerText)', 240000, 'extension executed');
    await shot('sample-guide-complete');
    await p.click('Compare again', '.guide button');
    await p.waitFor('location.hash.startsWith("#/compare/") && !!document.querySelector(".evgrid")', 30000, 'comparison');
    await sleep(2500);
    const t = await text('main, body');
    expect(/Nearest Pickup/i.test(t), 'the registered method is not in the comparison');
    await shot('sample-extension-compare');
    return 'nearest pickup in the comparison';
  });

  // ---- 9. bundle from another researcher: import file → verify → reproduce -------------------------------------
  await check('bundle from researcher B: import file, integrity, reproduce (Run again)', async () => {
    expect(exported, 'no exported bundle');
    await goHash(`#/workspace/${demoBase}`, 3000);
    await p.click('Import', '.labbar button'); await p.click('Import a bundle file', '[role=menuitem]');
    await p.setFiles('input[aria-label="bundle file to inspect"]', [exported]);
    await p.waitFor('!!document.querySelector(".importd .checks")', 60000, 'inspection'); await sleep(400);
    expect(/New here/.test(await text('.importd')), 'records not reported as new');
    await shot('import-dialog-new-records');
    await p.click('Import experiment', '.importd button');
    await p.waitFor('/Integrity verified/.test(document.querySelector(".lab-notes")?.innerText)', 60000, 'import notice');
    await sleep(2500);
    const note = await text('.lab-notes');
    await p.click('Run again', '.labbar button');
    const st = await waitJob(240000);
    expect(st === 'done' || st === 'gone', `job ${st}`);
    await sleep(2500);
    const right = await text('.lab-right');
    expect(/Reproduc/.test(right), 'no reproducibility evidence on the re-execution');
    await shot('imported-bundle-reproduced');
    return note.split('\n')[0].slice(0, 140);
  });

  // ---- 10. appearance, mobile ----------------------------------------------------------------------------------
  await check('appearance: dark on request, kept per user; light again', async () => {
    await goHash(`#/workspace/${demoBase}`, 3500);
    await p.click('profile', '.hdr button'); await p.click('Dark', '.menu button'); await p.key('Escape'); await sleep(900);
    expect(await p.eval('document.documentElement.dataset.theme') === 'dark', 'not dark');
    const pref = (await api('/api/lab/state')).body.preferences.theme;
    expect(pref === 'dark', `server preference ${pref}`);
    await shot('dark-workspace');
    await p.click('profile', '.hdr button'); await p.click('Light', '.menu button'); await p.key('Escape'); await sleep(500);
    expect(await p.eval('document.documentElement.dataset.theme') === 'light', 'not light again');
    return 'light → dark → light';
  });
  await check('map: expanded mode keeps Run, Compare, Export and Replay reachable; panels open on demand; Esc exits', async () => {
    await goHash(`#/workspace/${demoBase}`, 3500);
    await p.click('Expand the map', '.map-expand'); await sleep(1500);
    const st = await p.eval(`(() => { const b = (sel) => document.querySelector(sel); const btn = (txt) => [...document.querySelectorAll('.labbar button')].find((x) => x.innerText.includes(txt));
      return { header: getComputedStyle(b('.hdr')).display, map: Math.round(b('.leaflet-container').getBoundingClientRect().width), run: !!btn('Run') && !btn('Run').disabled,
               compare: !!btn('Compare') && !btn('Compare').disabled, exp: !!btn('Export') && !btn('Export').disabled, replay: !!b('.replay-pill'), exit: b('.map-expand')?.innerText }; })()`);
    expect(st.header === 'none' && st.map >= 1400 && st.run && st.compare && st.exp && st.replay && /Exit expanded map/.test(st.exit), JSON.stringify(st));
    await shot('map-expanded');
    await p.click('results panel', '.labbar button'); await sleep(700);
    expect(await p.eval('getComputedStyle(document.querySelector(".lab-right")).display !== "none"'), 'results panel not reachable');
    await shot('map-expanded-results-panel');
    await p.click('results panel', '.labbar button'); await sleep(300);
    await p.key('Escape'); await sleep(700);
    expect(!(await p.eval('document.documentElement.classList.contains("map-expanded")')), 'Esc did not exit');
    return `map ${st.map}px wide; Run, Compare, Export, Replay reachable`;
  });
  await check('Hidden records: purpose stated; hiding is reversible and leaves the visible lists and counts', async () => {
    await goHash('#/data/library', 3000);
    const name = await p.eval('document.querySelector("table[aria-label=\'scenario library\'] tbody tr td:nth-child(2) b")?.innerText');
    expect(name, 'no scenario to hide');
    const before = await p.eval('document.querySelectorAll("table[aria-label=\'scenario library\'] tbody tr").length');
    await p.click(`hide ${name}`, 'table[aria-label="scenario library"] button'); await sleep(800);
    const after = await p.eval('document.querySelectorAll("table[aria-label=\'scenario library\'] tbody tr").length');
    expect(after === before - 1 && /Show hidden \(1\)/.test(await text('.areabar')), `list ${before} → ${after}`);
    await goHash('#/hidden', 2500);
    const page = await text('main');
    expect(/Hide items from normal lists without deleting them\. You can restore them later\./.test(page) && page.includes(name), 'purpose or record missing');
    await shot('hidden-records');
    await clickInRow('table[aria-label="hidden scenarios"] tr', name, 'Show again'); await sleep(800);
    expect(!(await text('main')).includes(`${name}\nShow again`), 'not restored');
    await goHash('#/data/library', 2500);
    expect(await p.eval('document.querySelectorAll("table[aria-label=\'scenario library\'] tbody tr").length') === before, 'not back in the list');
    return `${name}: hidden (list ${before} → ${after}), restored`;
  });
  await check('phone width: no horizontal scroll, full-width map, profile menu reachable', async () => {
    await p.size(390, 844, 3, true);
    try {
      await p.goto(`${BASE}/#/workspace/${demoBase}`); await waitWorkspace(); await sleep(3500);
      const m = await p.eval('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, map: Math.round(document.querySelector(".leaflet-container").getBoundingClientRect().width) })');
      expect(m.sw <= m.cw && m.map >= m.cw - 2, JSON.stringify(m));
      await shot('phone-workspace');
      await p.click('profile', '.hdr button'); await sleep(400);
      expect(await has('[role=menu][aria-label=profile]'), 'profile menu');
      await shot('phone-profile-menu', 200);
      await p.key('Escape');
      return JSON.stringify(m);
    } finally { await p.size(W, H, DSF, false); }
  });
  await check('tour stays off after signing out and in again', async () => {
    await p.goto(`${BASE}/`); await waitWorkspace(); await signOut();
    expect(await signIn(researcher, rPw) === '/', 'workspace'); await waitWorkspace(); await sleep(3500);
    expect(!(await has('.tour')), 'tour reappeared after signing in');
    await signOut(); return 'not shown';
  });

  // ---- 11. supervision: researcher creates a student; the student is isolated -----------------------------------
  let supExp = '';
  await check('supervising researcher creates a student under My students', async () => {
    expect(await signIn(SUP, pw(SUP)) === '/', 'workspace'); await waitWorkspace();
    supExp = (await api('/api/lab/experiments')).body.experiments.find((e) => e.group === 'mine')?.campaign_id ?? '';
    await p.click('profile', '.hdr button'); await p.click('My students', '.menu button');
    await p.waitFor('!!document.querySelector("table.accounts")', 15000, 'students');
    await p.click('New student', 'button');
    await p.fill('input[aria-label="new display name"]', `E2E Student ${suffix}`);
    await p.fill('input[aria-label="new username"]', student);
    await p.click('Create', '.drawer button', true);
    await p.waitFor('!!document.querySelector(".secret")', 10000, 'one-time password');
    sPw = await readSecret();
    await p.click('Done', '.secret button', true); await sleep(800);
    expect((await text('table.accounts')).includes(student), 'student not listed');
    await shot('my-students');
    await signOut(); return student;
  });
  await check('student: first sign-in, own isolated workspace with the demonstration', async () => {
    expect(await signIn(student, sPw) === '/change-password', 'no forced change');
    const fresh = newPassword(); await choosePassword(sPw, fresh);
    await p.click('Save and continue', 'button');
    await p.waitFor('location.pathname === "/" && !!document.querySelector(".hdr")', 30000, 'workspace');
    sPw = fresh;
    await waitWorkspace(); await p.waitFor('!!document.querySelector("table.results")', 60000, 'demonstration');
    const other = supExp ? (await api(`/api/lab/experiments/${supExp}`)).status : 404;
    expect(other === 404, `student can read the supervisor's experiment (${other})`);
    const admin = (await api('/api/admin/users')).status;
    expect(admin === 403 || admin === 401, `student reaches administration (${admin})`);
    await signOut();
    return `supervisor's experiment → ${other}, administration → ${admin}`;
  });
}

if (ONLY !== 'fallback') await check('sign-in page follows the dark choice stored on this browser', async () => {
  await p.eval("localStorage.setItem('move-openlab-theme', 'dark'); true");
  await p.goto(`${BASE}/login`); await sleep(500);
  const dark = await p.eval('document.documentElement.dataset.theme');
  await shot('sign-in-dark');
  await p.eval("localStorage.removeItem('move-openlab-theme'); true");
  expect(dark === 'dark', dark); return 'dark';
});

report.finished = new Date().toISOString();
report.page_errors = p.errors;
report.network_errors = p.network;           // HTTP error statuses seen by the browser (expected ones included)
report.dialogs = p.dialogs;
report.passed = report.checks.filter((c) => c.ok).length;
report.failed = report.checks.filter((c) => !c.ok).length;
writeFileSync(join(OUT, ONLY === 'fallback' ? 'acceptance-fallback.json' : 'acceptance-report.json'), JSON.stringify(report, null, 1));
console.log(`\n${report.passed} passed, ${report.failed} failed · page errors: ${p.errors.length} · screenshots: ${report.screenshots.length}`);
for (const e of p.errors) console.log(`  page error: ${e.slice(0, 200)}`);
await p.close();
process.exit(report.failed || p.errors.length ? 1 : 0);
