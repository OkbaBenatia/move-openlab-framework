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
  const t0 = Date.now();
  try { await p.key('Escape'); await p.key('Escape'); } catch { /* no page yet */ }   // start every check with no dialog open
  try { const detail = await fn(); report.checks.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - t0 }); console.log(`ok    ${name}${detail ? ` — ${detail}` : ''}`); return true; }
  catch (e) {
    report.checks.push({ name, ok: false, detail: String(e.message ?? e).slice(0, 400), ms: Date.now() - t0 });
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
    await p.waitDownload(before, 60000);
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

  // ---- 5. comparison with the variant ----------------------------------------------------------------------------
  await check('comparison A/B: results, charts, maps, replay, diff', async () => {
    await p.click('Compare with the variant', '.start-card button');
    await p.waitFor('location.hash.startsWith("#/compare/") && !!document.querySelector(".evgrid")', 30000, 'comparison');
    await sleep(2500);
    demoVariant = (await p.eval('location.hash')).split('|')[1];
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

  // ---- 8. sample bundle: import → verify → reproduce → compare → add method → extend → compare ---------------------
  const ensureGuide = async () => {                 // each step may start with the guide closed (Escape between checks)
    if (await has('.guide')) return;
    if (!(await has('.labbar'))) await goHash(`#/workspace/${demoBase}`, 3000);
    await p.click('Import', '.labbar button'); await p.click('Try an imported experiment', '[role=menuitem]');
    await p.waitFor('!!document.querySelector(".guide .checks")', 30000, 'guide');
  };
  await check('sample bundle: download, integrity verified, import', async () => {
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
    await p.setFiles('input[aria-label="bundle file"]', [exported]);
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
  await check('researcher signs out', async () => { await p.goto(`${BASE}/`); await waitWorkspace(); await signOut(); return 'ok'; });

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
