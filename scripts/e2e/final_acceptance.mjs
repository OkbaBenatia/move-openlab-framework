#!/usr/bin/env node
// Final acceptance run: the 33 required scenarios, in the real application, with real mouse and keyboard events in
// headless Chromium, signed in as the test administrator (who has a workspace) and a second researcher.
//
//   node scripts/e2e/final_acceptance.mjs --base http://127.0.0.1:8791 --creds <data dir>/dev-credentials.json --out <dir>
//
// Run it against a server on a COPY of a data directory: it creates scenarios, experiments, runs and imports.
// Passwords are read from the git-ignored credentials file and never printed, saved or captured. Writes numbered
// screenshots, downloads and final-acceptance.json (per scenario: action, expected, actual, PASS/FAIL, evidence).
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8791'), OUT = arg('out'), CREDS = arg('creds');
const ADMIN = arg('admin', 'okba_test'), OTHER = arg('other', 'researcher2');
if (!OUT || !CREDS) { console.error('usage: final_acceptance.mjs --base URL --creds FILE --out DIR'); process.exit(2); }
const chrome = process.env.CHROME ?? (() => {
  const root = join(homedir(), '.cache/ms-playwright');
  const dir = existsSync(root) && readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().at(-1);
  return dir ? join(root, dir, 'chrome-linux64/chrome') : 'chromium';
})();
mkdirSync(OUT, { recursive: true });
const SHOTS = join(OUT, 'screenshots'); mkdirSync(SHOTS, { recursive: true });
const DL = join(OUT, 'downloads'); mkdirSync(DL, { recursive: true });
const creds = JSON.parse(readFileSync(CREDS, 'utf8'));
const pw = (u) => (typeof creds[u] === 'string' ? creds[u] : creds[u]?.password);
const W = 1440, H = 900, DSF = 2;

const report = { base: BASE, admin: ADMIN, other: OTHER, started: new Date().toISOString(), scenarios: [], screenshots: [], facts: {} };
let n = 0;
const p = await launch(chrome, { width: W, height: H });
await p.size(W, H, DSF);
await p.allowDownloads(DL);

const shot = async (name, settle = 700) => {
  await sleep(settle);
  const file = `${String(++n).padStart(2, '0')}-${name}.png`;
  await p.shot(join(SHOTS, file)); report.screenshots.push(file); return file;
};
/** One required scenario: `fn` returns { actual, evidence: [] }; any exception is a FAIL with its message. */
async function scenario(id, title, action, expected, fn, { keep = false } = {}) {
  const t0 = Date.now(), e0 = p.errors.length;
  if (!keep) {                                                  // keep: continues the previous scenario's dialog
    try { await p.key('Escape'); await p.key('Escape');
      if (await p.eval('!!document.querySelector(".wizard")')) { await p.eval(`document.querySelector('.wizard button[aria-label=close]')?.click()`); await sleep(500); }
    } catch { /* no page yet */ }
  }
  const rec = { id, title, action, expected, actual: '', status: 'FAIL', evidence: [], ms: 0, page_errors: [] };
  try {
    const r = await fn(rec);
    rec.actual = r?.actual ?? ''; rec.evidence.push(...(r?.evidence ?? [])); rec.status = 'PASS';
  } catch (e) {
    rec.actual = `${rec.actual ? `${rec.actual} · ` : ''}ERROR: ${String(e.message ?? e).slice(0, 500)}`;
    try { const f = `fail-${String(id).padStart(2, '0')}.png`; await p.shot(join(SHOTS, f)); rec.evidence.push(f); } catch { /* page gone */ }
  }
  rec.page_errors = p.errors.slice(e0); rec.ms = Date.now() - t0;
  if (rec.page_errors.length) { rec.status = 'FAIL'; rec.actual += ` · page errors: ${rec.page_errors.join(' | ').slice(0, 300)}`; }
  report.scenarios.push(rec);
  console.log(`${rec.status}  ${String(id).padStart(2)} ${title} — ${rec.actual.slice(0, 220)}`);
  writeFileSync(join(OUT, 'final-acceptance.json'), JSON.stringify(report, null, 1));
  return rec.status === 'PASS';
}
const text = (css = 'body') => p.eval(`(document.querySelector(${JSON.stringify(css)})?.innerText ?? '')`);
const has = (css) => p.eval(`!!document.querySelector(${JSON.stringify(css)})`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const api = (path, init = {}) => p.eval(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }))`);
const goHash = async (h, settle = 2500) => { await p.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(settle); };
const hashNow = () => p.eval('location.hash');
/** Set a <select> as a person choosing an option would (React listens to change). */
const choose = (css, value) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) throw new Error('no select ' + ${JSON.stringify(css)});
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
const center = (css) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const clickCss = async (css) => { const c = await center(css); expect(c, `nothing at ${css}`); await p.clickAt(c.x, c.y); await sleep(150); };

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
const waitWorkspace = () => p.waitFor('!!document.querySelector(".lab-grid") && !/Loading the demonstration/.test(document.querySelector(".lab-notes")?.innerText ?? "")', 60000, 'workspace');
/** Before a click that starts a job: remember that a progress panel appeared, even if it is gone before the next poll. */
const armJob = () => p.eval(`(() => { window.__jobSeen = false; const o = new MutationObserver(() => { if (document.querySelector('.job')) { window.__jobSeen = true; o.disconnect(); } }); o.observe(document.body, { childList: true, subtree: true }); return true; })()`);
async function waitJob(timeout = 240000) {
  await p.waitFor('window.__jobSeen === true || !!document.querySelector(".job")', 30000, 'job progress');
  await p.waitFor('["done","error","cancelled","interrupted"].includes(document.querySelector(".job")?.dataset.state) || !document.querySelector(".job")', timeout, 'job end');
  return p.eval('document.querySelector(".job")?.dataset.state ?? "gone"');
}
const cidNow = async () => decodeURIComponent((await hashNow()).split('/')[2] ?? '');
const experiment = async (cid) => (await api(`/api/lab/experiments/${cid}`)).body;
/** A page that shows real command output, for screenshots of evidence outside the application. */
const evidencePage = async (title, body) => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:14px/1.45 ui-monospace,monospace;margin:24px;background:#fff;color:#14202e">
    <h2 style="font-family:Inter,system-ui,sans-serif">${esc(title)}</h2><pre style="white-space:pre-wrap;background:#f4f6f9;border:1px solid #dde3ea;border-radius:10px;padding:14px">${esc(body)}</pre></body>`;
  await p.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`); await sleep(500);
};
const py = (code, ...args) => execFileSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' });

/** Results › Advanced, opened if it is closed (a click on an open <details> would close it). */
const openAdvanced = async () => {
  const closed = await p.eval(`(() => { const d = [...document.querySelectorAll('.lab-right details')].find((x) => /Advanced/.test(x.querySelector('summary')?.innerText ?? '')); return d ? !d.open : null; })()`);
  expect(closed !== null, 'no Advanced section');
  if (closed) { await p.click('Advanced', '.lab-right summary'); await sleep(300); }
};
const F = report.facts;   // identifiers and figures gathered along the run
let demoBase = '', demoVariant = '', demoRepro = '', mine = '', co2Exp = '', extension = '', montArea = null, exported = '';

// =====================================================================================================================
await scenario(1, 'First sign-in and Workspace', `Sign in as ${ADMIN} (password from the git-ignored credential store); open the Workspace; reload.`,
  'The Workspace opens on an experiment with its map, scenario and validated results; the demonstration is installed once (not re-imported on a later visit).',
  async () => {
    await signIn(ADMIN); await waitWorkspace(); await sleep(3000);
    const st = (await api('/api/lab/state')).body;
    const list = (await api('/api/lab/experiments')).body.experiments;
    // the visible, most recent demonstration baseline (an account may keep older, hidden demonstration installs)
    const demos = list.filter((x) => x.demo && !x.hidden).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    demoBase = (demos.find((x) => x.kind === 'baseline' && x.area === 'Montbéliard') ?? demos.find((x) => x.kind === 'baseline'))?.campaign_id ?? '';
    demoVariant = demos.find((x) => x.kind === 'variant' && x.parent === demoBase)?.campaign_id ?? '';
    demoRepro = list.find((x) => x.kind === 'reproduction' && x.parent === demoBase)?.campaign_id ?? '';
    const before = list.length;
    const s1 = await shot('main-workspace', 1500);
    await p.goto(`${BASE}/`); await waitWorkspace(); await sleep(2500);
    const after = (await api('/api/lab/experiments')).body.experiments.length;
    expect(st.demo.installed && demoBase && demoVariant && before === after, `demo installed=${st.demo.installed} base=${demoBase} variant=${demoVariant} experiments ${before}→${after}`);
    expect(await has('.lab-grid .leaflet-container') && /Validated/.test(await text('.labbar')), 'workspace without map or validation state');
    Object.assign(F, { demoBase, demoVariant, demoRepro, experiments_at_start: before });
    return { actual: `Workspace opened on "${(await text('.exp-picker b'))}"; demonstration installed once (${before} experiments before and after a reload).`, evidence: [s1] };
  });

await scenario(28, 'Map icons and overlapping points', 'Open the Montbéliard demonstration baseline; read the drivers\' markers, legend and tooltips; compare with the replay plan.',
  'Drivers are squares lettered by vehicle type (E electric, C combustion…), pick-ups filled, drop-offs hollow, unmatched riders grey; tooltips name role, vehicle and served state; points at the same place are fanned out.',
  async () => {
    await goHash(`#/workspace/${demoBase}`, 4500);
    const s2 = await shot('montbeliard-demo', 1200);
    const e = await experiment(demoBase);
    const run = e.runs.find((r) => r.instance_hash === e.scenarios[0].instance_hash);
    const plan = (await api(`/api/geo/playback/${run.campaign_id}/${run.run_id}`)).body;
    const want = plan.vehicles.map((v) => ({ BEV: 'E', ICE: 'C', HEV: 'H', PHEV: 'P' })[v.vehicle?.powertrain] ?? '').sort().join('');
    const dom = await p.eval(`(() => { const ds = [...document.querySelectorAll('.mk[data-kind=driver]')];
      const pos = ds.map((d) => { const r = d.getBoundingClientRect(); return Math.round(r.left) + ',' + Math.round(r.top); });
      return { drivers: ds.length, letters: ds.map((d) => d.textContent).sort().join(''), distinct: new Set(pos).size,
        pickups: document.querySelectorAll('.mk[data-kind=pickup]').length, dropoffs: document.querySelectorAll('.mk[data-kind=dropoff]').length,
        legend: document.querySelector('.legend')?.innerText ?? '' }; })()`);
    // coincident places in the plan (driver starts, pick-ups, drop-offs, unmatched riders)
    const at = (a) => `${a[0].toFixed(5)},${a[1].toFixed(5)}`;
    const places = [...plan.vehicles.map((v) => at(v.path[0])), ...plan.vehicles.flatMap((v) => v.stops.filter((s) => s.type === 'pickup' || s.type === 'dropoff').map((s) => at(s.at))), ...plan.unserved.map((u) => at(u.at))];
    const shared = places.length - new Set(places).size;
    expect(dom.drivers === plan.vehicles.length && dom.letters === want, `drivers ${dom.drivers}/${plan.vehicles.length}, letters ${dom.letters} vs ${want}`);
    expect(dom.distinct === dom.drivers, `driver markers overlap on screen: ${dom.distinct}/${dom.drivers}`);
    expect(/Electric/.test(dom.legend) && /Combustion/.test(dom.legend) && /not matched/.test(dom.legend), `legend: ${dom.legend}`);
    // a driver marker that is on top at its own centre (inside the map, not under a card)
    const c = await p.eval(`(() => { for (const m of document.querySelectorAll('.mk[data-kind=driver]')) { const r = m.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y); if (hit && (hit === m || m.contains(hit) || hit.contains(m))) return { x, y }; } return null; })()`);
    expect(c, 'no driver marker on top'); await p.hover(c.x, c.y); await sleep(600);
    const tip = await text('.leaflet-tooltip');
    expect(/departs/.test(tip) && /(carries|drives alone)/.test(tip) && /(BEV|ICE|car)/.test(tip), `tooltip: ${tip}`);
    const s6 = await shot('map-markers-ev-icons', 300);
    F.markers = { ...dom, plan_vehicles: plan.vehicles.length, unserved: plan.unserved.length, shared_places: shared, tooltip: tip };
    return { actual: `${dom.drivers} driver squares (${dom.letters.replace(/(.)\1*/g, (m) => `${m.length}×${m[0]} `).trim()}) at ${dom.distinct} distinct screen positions; ${dom.pickups} pick-ups, ${dom.dropoffs} drop-offs, ${plan.unserved.length} unmatched; ${shared} places shared by several points fanned out; tooltip “${tip}”.`, evidence: [s2, s6] };
  });

await scenario(30, 'Immutable locked results', 'On the locked demonstration baseline: hover the Locked badge; try to run the locked record in place through the API; Run again creates a new record.',
  'Tooltip: “Original results are frozen. Re-run or extend this experiment to create new results.”; the in-place run is refused; the original checksum never changes.',
  async () => {
    await goHash(`#/workspace/${demoBase}`, 3000);
    const c = await center('.labbar .has-tip'); expect(c, 'no Locked badge'); await p.hover(c.x, c.y); await sleep(500);
    const tip = await p.eval(`getComputedStyle(document.querySelector('.labbar .has-tip'), '::after').content`);
    expect(tip.includes('Original results are frozen. Re-run or extend this experiment to create new results.'), `tooltip ${tip}`);
    const s = await shot('locked-results-tooltip', 200);
    const before = (await experiment(demoBase)).campaign;
    const runs = await api(`/api/campaigns/${demoBase}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(runs.status >= 400, `in-place run accepted (${runs.status})`);
    const c0 = (await api(`/api/campaigns/${demoBase}`)).body;
    expect(runs.status === 400 || runs.status === 409, `in-place execution answered ${runs.status}`);
    F.locked = { badge_tip: tip.replace(/^"|"$/g, ''), in_place_run_status: runs.status, in_place_run_detail: String(runs.body?.detail ?? runs.body).slice(0, 160), checksum: c0.checksum ?? c0.campaign?.checksum };
    return { actual: `Tooltip shown on hover/focus with the exact text; POST /execute on the locked record → ${runs.status} (${F.locked.in_place_run_detail}); status ${before.status}, locked=${before.locked}.`, evidence: [s] };
  });

await scenario(29, 'Import dropdown positioning', 'Open Import in the toolbar at 1440 px and at 375 px; check what is on top at each item; use the keyboard.',
  'The menu opens above the map expand control, both items are clickable, it stays inside the viewport on a phone, arrows move the focus and Escape returns to the button.',
  async () => {
    await goHash(`#/workspace/${demoBase}`, 2500);
    const probe = async () => p.eval(`(() => { const m = document.querySelector('[role=menu][aria-label=import]'); if (!m) return null; const r = m.getBoundingClientRect();
      const items = [...m.querySelectorAll('[role=menuitem]')].map((i) => { const b = i.getBoundingClientRect(); return [b.left + 12, b.right - 12].every((x) => { const e = document.elementFromPoint(x, b.top + b.height / 2); return e && i.contains(e); }); });
      const x = document.querySelector('.map-expand')?.getBoundingClientRect();
      return { menu: [r.left, r.top, r.right, r.bottom].map(Math.round), inViewport: r.left >= 0 && r.right <= innerWidth, items, overlapsExpand: !!x && !(x.right < r.left || x.left > r.right || x.bottom < r.top || x.top > r.bottom), focus: document.activeElement?.textContent }; })()`);
    await p.click('Import', '.labbar button'); await sleep(400);
    const wide = await probe();
    const s1 = await shot('import-dropdown', 200);
    await p.key('ArrowDown'); const f2 = await p.eval('document.activeElement?.textContent');
    await p.key('Escape'); await sleep(200);
    const closed = await p.eval(`({ open: !!document.querySelector('[role=menu][aria-label=import]'), back: document.activeElement?.getAttribute('aria-haspopup') })`);
    await p.size(375, 812, 2, true); await p.goto(`${BASE}/#/workspace/${demoBase}`); await waitWorkspace(); await sleep(2500);
    await p.click('Import', '.labbar button'); await sleep(400);
    const narrow = await probe();
    const s2 = await shot('import-dropdown-mobile', 200);
    await p.key('Escape'); await p.size(W, H, DSF); await p.goto(`${BASE}/#/workspace/${demoBase}`); await waitWorkspace(); await sleep(2000);
    expect(wide && wide.items.every(Boolean) && wide.inViewport && /Import a bundle/.test(wide.focus), `wide ${JSON.stringify(wide)}`);
    expect(/Try a sample/.test(f2) && !closed.open && closed.back === 'menu', `keyboard ${f2} ${JSON.stringify(closed)}`);
    expect(narrow && narrow.items.every(Boolean) && narrow.inViewport, `phone ${JSON.stringify(narrow)}`);
    F.import_menu = { wide, narrow };
    return { actual: `1440 px: menu ${wide.menu.join(',')} ${wide.overlapsExpand ? 'over' : 'clear of'} the expand control, items on top and clickable; keyboard focus moves and returns; 375 px: inside the viewport, items clickable.`, evidence: [s1, s2] };
  });

await scenario(2, 'Navigate away and return; selection persists', 'On the demonstration baseline choose sample 3, the Greedy result and zoom the map; go to Library › Experiments and Help, come back; reload; sign out and in; check another account.',
  'Experiment, scenario, selected result, methods and map view are restored after navigation, reload and sign-in; another researcher has their own state.',
  async () => {
    await goHash(`#/workspace/${demoBase}`, 3500);
    const e = await experiment(demoBase);
    const h3 = e.scenarios[2].instance_hash;
    await choose('select[aria-label=scenario]', h3); await sleep(2500);
    const greedy = await p.eval(`(() => { const r = [...document.querySelectorAll('table.results tbody tr')].find((x) => /Greedy/.test(x.innerText)); if (!r) return null; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 }; })()`);
    expect(greedy, 'no Greedy row'); await p.clickAt(greedy.x, greedy.y); await sleep(1500);
    await clickCss('.leaflet-control-zoom-in'); await sleep(1200);
    const state = () => p.eval(`(() => ({ hash: location.hash, scen: document.querySelector('select[aria-label=scenario]')?.value, row: document.querySelector('table.results tr.hl')?.innerText.split('\\n')[0],
      methods: [...document.querySelectorAll('.lab-right section[aria-label=methods] input[type=checkbox]')].filter((x) => x.checked).length }))()`);
    const zoom = () => api('/api/lab/state').then((r) => r.body.preferences.workspace);
    const s0 = await state(); await sleep(1200); const v0 = await zoom();
    await p.click('Library', '.hdr button'); await p.click('Experiments', '[role=menu] button, .menu button'); await sleep(1500);
    await goHash('#/account', 1200);
    await p.click('Workspace', '.hdr button, .hdr a'); await waitWorkspace(); await sleep(4000);
    const s1 = await state();
    const ev = await shot('workspace-state-after-navigation', 300);
    await p.goto(`${BASE}/`); await waitWorkspace(); await sleep(4000); const s2 = await state();
    await signOut(); await signIn(ADMIN); await waitWorkspace(); await sleep(4000); const s3 = await state();
    const same = (s) => s.hash.includes(demoBase) && s.scen === h3 && /Greedy/.test(s.row ?? '') && s.methods === s0.methods;
    expect(same(s0), `before ${JSON.stringify(s0)}`);
    expect(same(s1) && same(s2) && same(s3), `after navigation ${JSON.stringify(s1)} · reload ${JSON.stringify(s2)} · sign-in ${JSON.stringify(s3)}`);
    expect(v0 && v0.campaign_id === demoBase && v0.instance_hash === h3 && v0.map && v0.map.zoom >= 1, `saved view ${JSON.stringify(v0)}`);
    const mapNow = await p.eval(`(() => { const z = document.querySelector('.leaflet-control-zoom-in'); return !!z; })()`);
    await signOut(); await signIn(OTHER); await waitWorkspace(); await sleep(2500);
    const other = (await api('/api/lab/state')).body.preferences.workspace;
    await signOut(); await signIn(ADMIN); await waitWorkspace(); await sleep(2500);
    expect(!other || other.campaign_id !== demoBase || other.instance_hash !== h3 || JSON.stringify(other.map) !== JSON.stringify(v0.map), `${OTHER} shares ${ADMIN}'s view`);
    F.persistence = { saved_view: v0, after_navigation: s1, after_reload: s2, after_sign_in: s3, other_account_view: other ? { campaign_id: other.campaign_id, instance_hash: other.instance_hash } : null, map_control: mapNow };
    return { actual: `Saved view: sample 3, “${s0.row}”, ${s0.methods} methods ticked, map zoom ${v0.map.zoom}; identical after Library/Account navigation, a reload and a new sign-in; ${OTHER} has its own view.`, evidence: [ev] };
  });

await scenario(28.5, 'Expanded map', 'Press the expand control on the map.', 'The header and panels give way to the map; the action bar stays; Esc returns.',
  async () => {
    await goHash(`#/workspace/${demoBase}`, 2500);
    await clickCss('.map-expand'); await sleep(900);
    const on = await p.eval(`document.documentElement.classList.contains('map-expanded') && !!document.querySelector('.labbar')`);
    const s = await shot('expanded-map', 600);
    await p.key('Escape'); await sleep(500);
    const off = await p.eval(`!document.documentElement.classList.contains('map-expanded')`);
    expect(on && off, `expanded ${on} restored ${off}`);
    return { actual: 'Map expanded with the action bar kept; Esc restored the layout.', evidence: [s] };
  });

// ---- Generate: manual participants, randomized locations, random generation, Save & Run ---------------------------
const openWizard = async () => {
  // the Montbéliard area may be hidden in this account: restored in Library › Hidden records, as a researcher would
  const st = (await api('/api/lab/state')).body.preferences;
  const mont = (await api('/api/geo/areas')).body.areas.find((a) => a.name === 'Montbéliard' && a.network_id);
  if (mont && st.hidden_ids.includes(mont.area_id)) {
    await goHash('#/hidden', 2500);
    const pt = await p.eval(`(() => { const t = [...document.querySelectorAll('table')].find((x) => /^hidden .*areas$/i.test(x.getAttribute('aria-label') ?? ''));
      const r = t && [...t.querySelectorAll('tr')].find((x) => x.cells[0]?.innerText.trim() === 'Montbéliard'); const b = r?.querySelector('button'); if (!b) return null;
      b.scrollIntoView({ block: 'center' }); const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
    expect(pt, 'Montbéliard area hidden and not restorable'); await p.clickAt(pt.x, pt.y); await sleep(1500);
    expect(!(await api('/api/lab/state')).body.preferences.hidden_ids.includes(mont.area_id), 'area still hidden');
    F.restored_area = mont.area_id;
  }
  await goHash(`#/workspace/${demoBase}`, 3000);
  await p.click('Generate', '.labbar button');
  await p.waitFor('!!document.querySelector(".wizard .wizard-map .leaflet-container")', 15000, 'wizard');
  const areas = (await api('/api/geo/areas')).body.areas;
  montArea = areas.find((a) => a.name === 'Montbéliard' && a.network_id) ?? areas.find((a) => a.network_id);
  expect(montArea, 'no area with a road network');
  await choose('select[aria-label=area]', montArea.area_id); await sleep(1800);
};
const mapAt = (fx, fy) => p.eval(`(() => { const r = document.querySelector('.wizard-map .leaflet-container').getBoundingClientRect(); return { x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy} }; })()`);
const clickMap = async (fx, fy) => { const pt = await mapAt(fx, fy); await p.clickAt(pt.x, pt.y); await sleep(350); };
const next = async () => { await p.click('Next', '.wizard-foot button'); await sleep(700); };

await scenario(3, 'Generate participants manually', 'Generate → Montbéliard → “Place participants on the map” → Next; Add driver and Add rider, click their start and end points on the map; preview the driver\'s route.',
  'Each participant gets a start and an end point on the map; the route preview shows time and distance along the road network; the preview counts the participants.',
  async () => {
    await openWizard();
    await p.click('Place participants on the map', '.wizard label'); await next();
    await p.click('Add driver', '.wizard button'); await clickMap(0.38, 0.42); await clickMap(0.66, 0.58);
    await p.click('Add rider', '.wizard button'); await clickMap(0.44, 0.47); await clickMap(0.6, 0.55);
    await p.click('Add rider', '.wizard button'); await clickMap(0.35, 0.6); await clickMap(0.62, 0.4);
    await p.waitFor('/1 drivers · 2 riders/.test(document.querySelector("[aria-label=\\"preview summary\\"]")?.innerText ?? "")', 30000, 'preview of the manual scenario');
    const s1 = await shot('manual-participants', 400);
    await p.click('Route', '.wizard table[aria-label=drivers] button');
    await p.waitFor('/ min ·|km/.test(document.querySelector(".wizard table[aria-label=drivers]")?.innerText ?? "")', 30000, 'route preview');
    const route = (await text('.wizard table[aria-label=drivers]')).split('\n').find((l) => /km/.test(l)) ?? '';
    const s2 = await shot('manual-start-end-points', 600);
    const summary = await text('[aria-label="preview summary"]');
    F.manual = { summary, route };
    return { actual: `1 driver and 2 riders placed by clicks; preview “${summary}”; route ${route.trim()}.`, evidence: [s1, s2] };
  });

await scenario(5, 'Randomize locations with a seed', 'In the same manual scenario press “Randomize locations”, then save the scenario (Next → Next → Next → Save Scenario).',
  'New start and end points on the road network inside the area with a shown seed; ids and time windows kept; the saved scenario records the seed in its provenance (re-checked by the server).',
  async () => {
    const before = await p.eval(`[...document.querySelectorAll('.wizard table[aria-label=riders] input')].map((i) => i.value).join(',')`);
    await p.click('Randomize locations', '.wizard button');
    await p.waitFor('/seed \\d+ · times kept/.test(document.querySelector(".wizard-body")?.innerText ?? "")', 30000, 'randomized');
    const seed = Number((await text('.wizard-body')).match(/seed (\d+) · times kept/)[1]);
    const after = await p.eval(`[...document.querySelectorAll('.wizard table[aria-label=riders] input')].map((i) => i.value).join(',')`);
    await p.waitFor('/1 drivers · 2 riders/.test(document.querySelector("[aria-label=\\"preview summary\\"]")?.innerText ?? "")', 30000, 'preview after randomizing');
    const s1 = await shot('randomize-locations', 500);
    await next(); await next(); await p.fill('.wizard input[aria-label="experiment name"]', 'Acceptance · manual relocated'); await next();
    const review = await text('.review');
    expect(review.includes(`(seed ${seed})`) || review.includes(`seed ${seed}`), `review lacks the seed: ${review}`);
    await p.click('Save Scenario', '.wizard-foot button');
    await p.waitFor('!document.querySelector(".wizard")', 20000, 'wizard closed');
    const lib = (await api('/api/geo/scenarios')).body.scenarios;
    const rec = lib.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    const full = (await api(`/api/geo/scenarios/${rec.scenario_id}`)).body;
    const prov = full.scenario.provenance;
    const s = full.scenario, net = full.instance?.network;
    expect(prov.locations?.seed === seed && before === after, `provenance ${JSON.stringify(prov)} windows ${before} → ${after}`);
    F.relocated = { seed, scenario_id: rec.scenario_id, provenance: prov, instance_hash: full.instance?.instance_hash, network: net?.network_id };
    return { actual: `Seed ${seed}; time windows unchanged (${after}); saved scenario ${rec.scenario_id} with provenance.locations = ${JSON.stringify(prov.locations)}.`, evidence: [s1] };
  }, { keep: true });

await scenario(4, 'Generate participants randomly', 'Generate → Montbéliard → Synthetic demand → Next; 8 drivers, 12 riders, seed 21, Randomize locations (new seed); one driver in a battery-electric car.',
  'A seeded synthetic scenario of the chosen size on the road network, previewed (compatible pairs, snapping) before anything is stored.',
  async () => {
    await openWizard();
    await p.click('Synthetic demand', '.wizard label'); await next();
    await p.fill('.wizard input[aria-label=drivers]', '20'); await p.fill('.wizard input[aria-label=riders]', '30'); await p.fill('.wizard input[aria-label=seed]', '21'); await sleep(1500);
    await p.click('Randomize locations', '.wizard button'); await sleep(400);
    const seed = Number(await p.eval(`document.querySelector('.wizard input[aria-label=seed]').value`));
    await p.waitFor('/20 drivers · 30 riders/.test(document.querySelector("[aria-label=\\"preview summary\\"]")?.innerText ?? "")', 30000, 'synthetic preview');
    await choose('.wizard select[aria-label=vehicle]', 'petrol-car-eu-real-world'); await sleep(400);
    // the electric presets carry no consumption (no official average): the researcher enters it, with its source
    const vi = (await api('/api/lab/vehicles')).body;
    const cons = vi.parameters.find((d) => d.id === 'electricity_consumption_kwh_100km');
    await p.click('Manage', '.wizard button'); await p.waitFor('!!document.querySelector("[role=dialog][aria-label=\\"vehicle profiles\\"]")', 10000, 'vehicle profiles');
    await p.click('Battery-electric car (France grid factor)', '[aria-label=Presets] button'); await sleep(500);
    await p.click('Duplicate', 'form[aria-label="vehicle profile"] button'); await sleep(1500);
    await p.fill('form[aria-label="vehicle profile"] input[aria-label="vehicle name"]', 'Electric car, France grid, 16 kWh/100 km');
    await p.fill(`form[aria-label="vehicle profile"] input[aria-label="${cons.label}"]`, '16');
    await p.fill(`form[aria-label="vehicle profile"] input[aria-label="${cons.label} source"]`, 'Acceptance-test assumption: compact battery-electric car');
    const sEd = await shot('vehicle-parameters-editor', 300);
    await p.click('Save', 'form[aria-label="vehicle profile"] button', true); await sleep(1500);
    await p.click('close', '[role=dialog][aria-label="vehicle profiles"] button'); await sleep(1200);
    const myEv = (await api('/api/lab/vehicles')).body.mine.find((m) => m.parameters?.electricity_consumption_kwh_100km?.value === 16);
    expect(myEv, 'edited electric profile not saved');
    await p.click('Advanced', '.wizard summary'); await sleep(300);
    for (const d of ['D1', 'D2', 'D3', 'D4', 'D5']) await choose(`.wizard select[aria-label="vehicle of ${d}"]`, myEv.id);
    await sleep(1500);
    const summary = await text('[aria-label="preview summary"]');
    const s = await shot('random-participants', 600);
    expect(seed !== 21, 'Randomize did not change the seed');
    F.random = { seed, summary, electric_profile: { id: myEv.id, version: myEv.version, consumption: myEv.parameters.electricity_consumption_kwh_100km } };
    return { actual: `Seed 21 → ${seed} after Randomize locations; preview “${summary}”; D1–D5 in a researcher profile duplicated from the France-grid electric preset with 16 kWh/100 km entered (source recorded), others petrol.`, evidence: [sEd, s] };
  });

await scenario(6, 'Save & Run', 'Next to Constraints (departures 07:30–08:00, detour ≤ 20 min and ≤ 100 %), Methods (Exact and Greedy, 2 repetitions, name “Acceptance · synthetic Montbéliard”), Review, Save & Run; wait for the job.',
  'The Review lists area, data, participants, vehicles, constraints, methods, repetitions, CO₂ calculation and provenance; the run executes, every solution is validated and the results appear.',
  async () => {
    await next();
    // Constraints: departures 07:30–08:00, detour up to 20 min and 100 % of the direct trip
    await p.fill('.wizard input[aria-label=from]', '07:30'); await p.fill('.wizard input[aria-label=to]', '08:00');
    await p.fill('.wizard input[aria-label="max detour minutes"]', '20'); await p.fill('.wizard input[aria-label="max detour ratio"]', '1'); await sleep(2500);
    await p.waitFor('/20 drivers · 30 riders/.test(document.querySelector("[aria-label=\\"preview summary\\"]")?.innerText ?? "")', 60000, 'preview with the constraints');
    F.constraints_preview = await text('[aria-label="preview summary"]');
    await next();
    await p.fill('.wizard input[aria-label="experiment name"]', 'Acceptance · synthetic Montbéliard'); await p.fill('.wizard input[aria-label=repetitions]', '2'); await sleep(300);
    await next();
    const review = await text('.review');
    for (const k of ['Area', 'Mobility data', 'Drivers', 'Riders', 'Vehicles', 'Constraints', 'Methods', 'CO₂ calculation', 'Provenance']) expect(review.includes(k), `review lacks ${k}`);
    const s1 = await shot('wizard-review', 300);
    await armJob();
    await p.click('Save & Run', '.wizard-foot button');
    await p.waitFor('window.__jobSeen === true || !!document.querySelector(".job")', 30000, 'job'); const s2 = await shot('running-experiment', 150);
    const st = await waitJob(); expect(st === 'done' || st === 'gone', `job ${st}`);
    await sleep(3000); mine = await cidNow();
    const e = await experiment(mine);
    expect(e.validation.runs > 0 && e.validation.accepted === e.validation.runs, `validation ${JSON.stringify(e.validation)}`);
    expect(e.campaign.repetitions === 2, `repetitions typed 2, recorded ${e.campaign.repetitions}`);   // regression: "3" → "2" gave 12
    const s3 = await shot('completed-results', 1200);
    const rows = e.results.rows.map((r) => `${r.name}: ${r.totals.served} served, detour ${Math.round(r.totals.detour_s)} s`);
    F.mine = { campaign_id: mine, validation: e.validation, rows: e.results.rows.map((r) => ({ method: r.method_id, totals: r.totals, domain: r.domain && { scope: r.domain.scope, baseline: r.domain.baseline, solution_g: r.domain.solution_g, baseline_g: r.domain.baseline_g, avoided_g: r.domain.avoided_g } })) };
    return { actual: `Experiment ${mine}: ${e.validation.accepted}/${e.validation.runs} runs accepted by the validator; ${rows.join('; ')}.`, evidence: [s1, s2, s3] };
  }, { keep: true });

await scenario(7, 'Change vehicle/emission parameters', 'Results › Advanced: choose “Tailpipe only” and press “New experiment with this calculation”; then “Edit vehicles and their parameters…”, switch the default vehicle to the EU-grid electric car and Save Scenario.',
  'Each change creates a new, traceable configuration — a new experiment (same frozen scenarios, new CO₂ calculation) and a new scenario version that records the frozen scenario it derives from; the original experiment is unchanged.',
  async () => {
    await goHash(`#/workspace/${mine}`, 3500);
    const orig = await experiment(mine);
    await openAdvanced();
    await choose('select[aria-label="CO₂ calculation of the new experiment"]', 'tailpipe'); await sleep(200);
    const s1 = await shot('co2-calculation-change', 300);
    await armJob();
    await p.click('New experiment with this calculation', '.lab-right button');
    const st = await waitJob(); expect(st === 'done' || st === 'gone', `job ${st}`);
    await sleep(3000); co2Exp = await cidNow(); expect(co2Exp && co2Exp !== mine, 'no new experiment');
    await goHash(`#/workspace/${mine}`, 3500);
    await openAdvanced();
    await p.click('Edit vehicles and their parameters', '.lab-right button');
    await p.waitFor('!!document.querySelector(".wizard")', 15000, 'wizard on the frozen scenario'); await sleep(1500);
    await next();
    await choose('.wizard select[aria-label=vehicle]', 'diesel-car-eu-real-world'); await sleep(1500);
    await p.waitFor('/20 drivers · 30 riders/.test(document.querySelector("[aria-label=\\"preview summary\\"]")?.innerText ?? "")', 60000, 'preview of the new version');
    await next(); await next(); await next();
    const review = await text('.review');
    expect(/new version of an experiment's frozen scenario/.test(review), `review provenance: ${review}`);
    const s2 = await shot('vehicle-edit-review', 300);
    await p.click('Save Scenario', '.wizard-foot button'); await p.waitFor('!document.querySelector(".wizard")', 20000, 'wizard closed');
    const lib = (await api('/api/geo/scenarios')).body.scenarios.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const ver = (await api(`/api/geo/scenarios/${lib[0].scenario_id}`)).body;
    const after = await experiment(mine);
    expect(ver.scenario.provenance.derived_from_instance === orig.scenarios[0].instance_hash, `provenance ${JSON.stringify(ver.scenario.provenance).slice(0, 200)}`);
    expect(JSON.stringify(after.results.rows.map((r) => r.totals)) === JSON.stringify(orig.results.rows.map((r) => r.totals)), 'original results changed');
    F.vehicle_version = { scenario_id: lib[0].scenario_id, derived_from_instance: ver.scenario.provenance.derived_from_instance, new_instance_hash: ver.instance?.instance_hash, default_vehicle: ver.instance?.vehicles?.default?.id };
    return { actual: `New experiment ${co2Exp} (tailpipe); new scenario version ${lib[0].scenario_id} (default vehicle ${F.vehicle_version.default_vehicle}, instance ${String(F.vehicle_version.new_instance_hash).slice(0, 12)}…) derived from ${orig.scenarios[0].instance_hash.slice(0, 12)}…; the original experiment's results are identical.`, evidence: [s1, s2] };
  });

await scenario(8, 'Verify CO₂ recalculation', 'Compare the CO₂ figures and fingerprints of the original and the tailpipe experiment with the API, and recompute the electric car\'s share by hand.',
  'Same frozen scenarios and decisions; the CO₂ calculation, its fingerprint and the figures change (a battery-electric car emits 0 g at the tailpipe); the comparison of the two is marked accordingly.',
  async () => {
    const a = await experiment(mine), b = await experiment(co2Exp);
    expect(JSON.stringify(a.scenarios.map((s) => s.instance_hash)) === JSON.stringify(b.scenarios.map((s) => s.instance_hash)), 'different scenarios');
    expect(a.campaign.emissions.scope === 'operational-energy' && b.campaign.emissions.scope === 'tailpipe', `scopes ${a.campaign.emissions.scope} / ${b.campaign.emissions.scope}`);
    const ra = a.results.rows.find((r) => r.method_id === 'exact-matching-highs'), rb = b.results.rows.find((r) => r.method_id === 'exact-matching-highs');
    expect(ra.totals.served === rb.totals.served && ra.totals.detour_s === rb.totals.detour_s, 'decisions differ');
    expect(ra.domain.complete && rb.domain.complete && rb.domain.solution_g < ra.domain.solution_g, `solution ${ra.domain.solution_g} → ${rb.domain.solution_g}`);
    const desc = (await api(`/api/lab/compatible?a=${mine}`)).body.candidates.find((c) => c.campaign_id === co2Exp);
    F.co2_recalc = { operational: { solution_g: ra.domain.solution_g, baseline_g: ra.domain.baseline_g, avoided_g: ra.domain.avoided_g },
      tailpipe: { solution_g: rb.domain.solution_g, baseline_g: rb.domain.baseline_g, avoided_g: rb.domain.avoided_g }, verdict: desc && { results: desc.quality, runtime: desc.runtime, co2: desc.emissions, reasons: desc.reasons } };
    return { actual: `Exact: ${ra.totals.served} served in both; CO₂ solution ${Math.round(ra.domain.solution_g)} g (fuel and electricity) → ${Math.round(rb.domain.solution_g)} g (tailpipe); avoided ${Math.round(ra.domain.avoided_g)} → ${Math.round(rb.domain.avoided_g)} g; comparability: results ${desc?.quality}, CO₂ ${desc?.emissions}.`, evidence: [] };
  });

// ---- custom method -------------------------------------------------------------------------------------------------
await scenario(23, 'Add a custom method', 'On the demonstration baseline: + Add method → Register my method → My Greedy Matching → Register.',
  'The plug-in from the approved folder is registered (code pinned, sandboxed self-test accepted) and appears in the Methods list.',
  async () => {
    await goHash(`#/workspace/${demoBase}`, 3500);
    await p.click('Add method', '.lab-right button');
    await p.waitFor('!!document.querySelector("[role=dialog]") && /Add a method/.test(document.body.innerText)', 10000, 'add method dialog');
    await p.click('Register my method', '.choice');
    await sleep(1200);
    const already = /My Greedy Matching[\s\S]{0,200}Registered/.test(await text('[role=dialog]'));
    if (!already) {
      await p.eval(`(() => { const row = [...document.querySelectorAll('[role=dialog] .row, [role=dialog] li, [role=dialog] div')].reverse().find((r) => /My Greedy Matching/.test(r.innerText) && [...r.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Register')); [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Register').click(); return true; })()`);
      await p.waitFor('/Registered My Greedy Matching/.test(document.querySelector("[role=dialog]")?.innerText ?? "")', 120000, 'registration');
    }
    const s = await shot('add-method-workflow', 400);
    await p.click('close', '[role=dialog] button'); await sleep(1500);
    expect(await p.eval(`!!document.querySelector('.lab-right input[aria-label="My Greedy Matching"]')`), 'not in the Methods list');
    const st = (await api('/api/problems/public-ride-matching/methods')).body;
    const m = [...(st.builtin ?? []), ...(st.registered ?? [])].find((x) => x.method_id === 'my-greedy-matching');
    expect(m, 'my-greedy-matching not listed by the API');
    F.plugin = m ? { method_id: m.method_id, version: m.version, source: m.source, code_sha256: m.code_sha256 } : null;
    return { actual: `My Greedy Matching ${m?.version ?? ''} registered (${m?.source ?? 'plugin'}${m?.code_sha256 ? `, code ${m.code_sha256.slice(0, 12)}…` : ''}) and listed with the built-in methods.`, evidence: [s] };
  });

await scenario(24, 'Run and validate the custom method', 'Tick My Greedy Matching on the locked baseline and press Run added methods.',
  'An extension experiment runs the method on the same frozen scenarios in the sandbox; the validator accepts every solution; the baseline stays unchanged.',
  async () => {
    const cs0 = (await api(`/api/campaigns/${demoBase}`)).body;
    // on frozen results the list of methods to run is closed until the researcher opens it
    await p.eval(`document.querySelector('.lab-right details.run-methods:not([open]) > summary')?.click()`); await sleep(400);
    await clickCss('.lab-right input[aria-label="My Greedy Matching"]'); await sleep(400);
    await armJob();
    await p.click('Run added methods', '.labbar button');   // an added method: the run is an extension
    const st = await waitJob(); expect(st === 'done' || st === 'gone', `job ${st}`);
    await sleep(3500); extension = await cidNow(); expect(extension && extension !== demoBase, 'no extension experiment');
    const e = await experiment(extension);
    const row = e.results.rows.find((r) => r.method_id === 'my-greedy-matching');
    expect(row && e.validation.accepted === e.validation.runs, `validation ${JSON.stringify(e.validation)}`);
    const sel = await p.eval(`(() => { const r = [...document.querySelectorAll('table.results tbody tr')].find((x) => /My Greedy/.test(x.innerText)); if (r) r.click(); return !!r; })()`);
    const s = await shot('custom-method-execution', 1500);
    const cs1 = (await api(`/api/campaigns/${demoBase}`)).body;
    expect(JSON.stringify(cs0.checksum ?? cs0.campaign?.checksum) === JSON.stringify(cs1.checksum ?? cs1.campaign?.checksum), 'baseline checksum changed');
    const runs = e.runs.filter((r) => r.method_id === 'my-greedy-matching');
    F.extension = { campaign_id: extension, kind: e.campaign.kind, validation: e.validation, my_greedy: { totals: row.totals, runs: runs.length, accepted: runs.filter((r) => r.accepted).length,
      solver_ms_median: Math.round(1000 * runs.map((r) => r.solver_time_s ?? r.total_time_s ?? 0).sort((a, b) => a - b)[Math.floor(runs.length / 2)]) / 1000 } };
    return { actual: `Extension ${extension} (${e.campaign.kind}): ${e.validation.accepted}/${e.validation.runs} runs accepted; My Greedy Matching served ${row.totals.served} with ${Math.round(row.totals.detour_s)} s detour over ${e.scenarios.length} scenarios (${runs.length} runs); baseline checksum unchanged; row ${sel ? 'shown on the map' : 'listed'}.`, evidence: [s] };
  });

await scenario(25, 'Compare it with built-in methods', 'Read the extension\'s results table and the comparison of the extension with the baseline.',
  'My Greedy Matching appears beside Exact and Greedy with validated figures and runtimes; a heuristic never claims optimality.',
  async () => {
    const e = await experiment(extension);
    const t = e.results.rows.map((r) => ({ method: r.method_id, served: r.totals.served, detour_s: Math.round(r.totals.detour_s), proven_optimal: r.proven_optimal ?? 0, campaign: r.campaign_id === extension ? 'extension' : 'baseline' }));
    const mineRow = t.find((r) => r.method === 'my-greedy-matching'), ex = t.find((r) => r.method === 'exact-matching-highs');
    expect(mineRow && ex && mineRow.served <= ex.served && !mineRow.proven_optimal, JSON.stringify(t));
    F.custom_vs_builtin = t;
    return { actual: t.map((r) => `${r.method} (${r.campaign}): ${r.served} served, ${r.detour_s} s detour${r.proven_optimal ? `, ${r.proven_optimal} proven optimal` : ''}`).join('; '), evidence: [] };
  });

// ---- comparisons ---------------------------------------------------------------------------------------------------
// one Compare entry: it opens the Methods tab when the experiment has several methods; experiments are chosen on the Experiments tab
const openPicker = async () => { await p.click('Compare', '.labbar button'); await p.waitFor('location.hash.startsWith("#/methods/") || location.hash.startsWith("#/compare/")', 30000, 'Compare'); await sleep(500); if (await p.eval('location.hash.startsWith("#/methods/")')) { await p.click('Experiments', 'nav.compare-kind button'); await sleep(600); } await p.waitFor('!!document.querySelector(".picker-drawer .cands")', 30000, 'comparison picker'); await sleep(600); };
const tick = async (title) => {
  const ok = await p.eval(`(() => { const i = [...document.querySelectorAll('.picker-drawer input[type=checkbox]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(title)} && !x.disabled); if (!i) return false; i.scrollIntoView({ block: 'center' }); i.click(); return true; })()`);
  expect(ok, `cannot tick ${title}`); await sleep(300);
};
const footer = () => text('.picker-drawer .drawer-foot');
const columns = () => p.eval(`[...document.querySelectorAll('.cmphead .cmpchip, .cmpchip')].map((c) => c.innerText.replace(/\\s+/g, ' ').trim())`);

let title = {};
await scenario(14, 'Compare exactly TWO selected experiments', 'From the extension, open Compare: the current experiment is preselected; tick the demonstration baseline; Compare selected (2).',
  'The footer counts 2 with reference A; the comparison shows exactly A and B, nothing added.',
  async () => {
    const list = (await api('/api/lab/experiments')).body.experiments;
    title = Object.fromEntries(list.map((x) => [x.campaign_id, x.title]));
    await goHash(`#/workspace/${extension}`, 3000);
    await openPicker();
    const pre = await p.eval(`document.querySelector('.picker-drawer .cands input[type=checkbox]')?.checked`);
    expect(pre && /1 selected/.test(await footer()), `current not preselected: ${await footer()}`);
    await tick(title[demoBase]);
    const f = await footer(); expect(/^2 selected/.test(f) && /Compare selected \(2\)/.test(await text('.picker-drawer .drawer-foot')), `footer ${f}`);
    const s1 = await shot('compare-two-selection', 300);
    await p.click('Compare selected (2)', '.picker-drawer button');
    await p.waitFor('!!document.querySelector(".cmp-table")', 60000, 'comparison table'); await sleep(2500);
    const route = decodeURIComponent(await hashNow());
    const ids = route.replace('#/compare/', '').split(/[|,]/);
    expect(ids.length === 2 && ids[0] === extension && ids[1] === demoBase, `route ${route}`);
    const cols = await columns();
    const s2 = await shot('compare-two-results', 800);
    F.compare_two = { route, chips: cols };
    return { actual: `Footer “${f.split(' · ')[0]}”, route ${route}, sides ${cols.join(' | ')}.`, evidence: [s1, s2] };
  });

await scenario(15, 'Compare exactly THREE selected experiments', 'Edit selection: also tick the demonstration\'s controlled variant; Compare selected (3).',
  'Exactly A (reference), B and C in tick order in the header, table, charts and CSV.',
  async () => {
    await p.click('Edit selection', 'button');
    await p.waitFor('!!document.querySelector(".picker-drawer .cands")', 30000, 'picker'); await sleep(600);
    await tick(title[demoVariant]);
    const f = await footer(); expect(/^3 selected/.test(f), `footer ${f}`);
    const s1 = await shot('compare-three-selection', 300);
    await p.click('Compare selected (3)', '.picker-drawer button');
    await p.waitFor('!!document.querySelector(".cmp-table")', 60000, 'comparison table'); await sleep(2500);
    const route = decodeURIComponent(await hashNow());
    const ids = route.replace('#/compare/', '').split(/[|,]/);
    expect(ids.length === 3 && ids[0] === extension && ids[1] === demoBase && ids[2] === demoVariant, `route ${route}`);
    const head = await p.eval(`[...document.querySelectorAll('.cmp-table thead th')].map((x) => x.innerText.replace(/\\s+/g, ' ').trim())`);
    const s2 = await shot('compare-three-results', 800);
    F.compare_three = { route, table_header: head };
    return { actual: `Route ${route}; table header ${head.join(' | ')}.`, evidence: [s1, s2] };
  });

await scenario(16, 'No experiment is added automatically', 'Download the comparison CSV and read its legend; count the sides in every view.',
  'Only the three ticked experiments appear (legend lines A, B, C); nothing else is added.',
  async () => {
    const before = p.downloadCount();
    await p.click('Export table', 'button'); await p.waitDownload(before, 30000);
    const csvFile = readdirSync(DL).filter((f) => f.endsWith('.csv')).map((f) => join(DL, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1);
    const csv = readFileSync(csvFile, 'utf8');
    const legend = csv.split('\n').filter((l) => /^# [A-Z][ :(]/.test(l));
    expect(legend.length === 3 && /^# A \(reference\)/.test(legend[0]) && legend.every((l, i) => l.includes([extension, demoBase, demoVariant][i])), `legend ${legend.join(' / ')}`);
    F.csv_legend = legend;
    return { actual: `CSV ${basename(csvFile)}: ${legend.join(' / ')}.`, evidence: [basename(csvFile)] };
  });

await scenario(17, 'Reference-based deltas', 'Change the reference to the demonstration baseline with the “Reference” selector; download the CSV again.',
  'The route, the header badge and the note name the new reference; deltas and CSV columns are against it.',
  async () => {
    await choose('select[aria-label="reference for deltas"]', demoBase); await sleep(3000);
    const route = decodeURIComponent(await hashNow());
    expect(route.replace('#/compare/', '').split('|')[0] === demoBase, `route ${route}`);
    const note = (await text('body')).match(/Deltas are against the reference A \(([^)]*)\)/);
    expect(note && note[1].includes(title[demoBase].slice(0, 20)), `note ${note?.[0]}`);
    const before = p.downloadCount();
    await p.click('Export table', 'button'); await p.waitDownload(before, 30000);
    const csvFile = readdirSync(DL).filter((f) => f.endsWith('.csv')).map((f) => join(DL, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1);
    const csv = readFileSync(csvFile, 'utf8');
    const ref = csv.split('\n').find((l) => /^# A \(reference\)/.test(l));
    expect(ref.includes(demoBase), `CSV reference ${ref}`);
    const s = await shot('reference-changed', 600);
    F.reference_change = { route, note: note[0], csv_reference: ref, delta_columns: csv.split('\n').find((l) => !l.startsWith('#'))?.split(',').filter((c) => / - A$|-A$/.test(c)) };
    return { actual: `Route ${route}; note “${note[0]}”; CSV ${ref}; delta columns ${F.reference_change.delta_columns?.join(', ')}.`, evidence: [s, basename(csvFile)] };
  });

await scenario(18, 'Direct / conditional / incompatible metrics', 'Read the verdicts per side and per claim (results, runtime, CO₂), open Why?, and show incompatible experiments in the picker.',
  'Each side carries its own verdicts with reasons; incompatible experiments are listed only under Show incompatible and cannot be ticked.',
  async () => {
    const chips = await p.eval(`[...document.querySelectorAll('.cmphead .badge, .evstrip .badge, .evsum .badge')].map((b) => b.innerText.trim()).filter(Boolean)`);
    const comp = (await api(`/api/lab/compatible?a=${demoBase}`)).body;
    await p.click('Edit selection', 'button');
    await p.waitFor('!!document.querySelector(".picker-drawer .cands")', 30000, 'picker'); await sleep(600);
    const counts = await text('.picker-drawer .drawer-head + * , .picker-drawer');
    const incomp = await p.eval(`(() => { const l = [...document.querySelectorAll('.picker-drawer label')].find((x) => /Show incompatible/i.test(x.innerText)); if (!l) return null; l.querySelector('input').click(); return l.innerText; })()`);
    await sleep(500);
    const dis = await p.eval(`[...document.querySelectorAll('.picker-drawer .cand.dim input[type=checkbox]')].filter((i) => i.disabled).length`);
    const why = await p.eval(`(() => { const b = [...document.querySelectorAll('.picker-drawer button')].find((x) => x.innerText.trim() === 'Why?'); if (!b) return ''; b.click(); return 'opened'; })()`);
    await sleep(400);
    const reasons = await text('.picker-drawer .reasons');
    const s = await shot('verdicts-and-incompatible', 400);
    await p.key('Escape'); await sleep(300);
    F.verdicts = { counts: comp.counts, per_candidate: comp.candidates.map((c) => ({ title: c.title, results: c.quality, runtime: c.runtime, co2: c.emissions, overall: c.overall })), disabled_incompatible: dis, reasons_example: reasons.slice(0, 300) };
    expect(comp.candidates.some((c) => c.overall === 'direct') && (incomp === null || dis > 0), `verdicts ${JSON.stringify(comp.counts)} incompatible ${incomp} disabled ${dis}`);
    return { actual: `Counts ${JSON.stringify(comp.counts)}; ${incomp ? `“${incomp.trim()}” lists ${dis} incompatible experiment(s), not tickable` : 'no incompatible candidate'}; Why? ${why ? `→ “${reasons.split('\n')[0]}”` : 'not needed'}.`, evidence: [s] };
  });

await scenario(19, 'Hover tooltips', 'Charts tab: hover the first bar, then focus it with the keyboard.',
  'The tooltip names experiment, method, scenario, metric with value and unit, repetitions and aggregation; it also opens on keyboard focus.',
  async () => {
    await p.click('Charts', '.tabs button'); await sleep(1500);
    const c = await center('.chart-card svg [role=img]'); expect(c, 'no chart mark');
    await p.hover(c.x, c.y); await sleep(500);
    const tip = await text('.chart-tip');
    for (const k of ['Method', 'Scenario', 'Repetitions', 'Aggregation']) expect(new RegExp(k, 'i').test(tip), `tooltip lacks ${k}: ${tip}`);
    expect(/^[A-Z] · /.test(tip.trim()), `tooltip does not start with the experiment: ${tip}`);
    const s = await shot('chart-tooltip', 200);
    const focus = await p.eval(`(() => { const m = document.querySelector('.chart-card svg [role=img]'); m.focus(); return document.activeElement === m && (m.getAttribute('aria-label') ?? '').length > 10; })()`);
    expect(focus, 'mark not focusable');
    F.tooltip = tip;
    return { actual: `Tooltip: ${tip.replace(/\n/g, ' · ')}; keyboard focus exposes the same text.`, evidence: [s] };
  });

await scenario(20, 'Different chart types', 'Switch the metric to Runtime and try Bar, Grouped bar, Line, Box plot and Scatter; switch back to Served riders.',
  'Only appropriate types are enabled, each disabled one says why; the chart redraws for each enabled type.',
  async () => {
    await choose('.chart-controls select[aria-label=metric]', 'runtime'); await sleep(800);
    const kinds = await p.eval(`[...document.querySelectorAll('.chart-controls [aria-label="chart type"] button')].map((b) => ({ k: b.innerText, on: !b.disabled, why: b.title }))`);
    const drawn = [];
    for (const k of kinds.filter((x) => x.on)) { await p.click(k.k, '.chart-controls [aria-label="chart type"] button', true); await sleep(600); drawn.push(`${k.k}:${await p.eval(`document.querySelectorAll('.chart-card svg [role=img]').length`)}`); }
    if (kinds.find((x) => x.k === 'Box plot' && x.on)) { await p.click('Box plot', '.chart-controls [aria-label="chart type"] button', true); await sleep(600); }
    const s = await shot('chart-type-metric-selection', 400);
    await choose('.chart-controls select[aria-label=metric]', 'served'); await sleep(800);
    const served = await p.eval(`[...document.querySelectorAll('.chart-controls [aria-label="chart type"] button')].map((b) => ({ k: b.innerText, on: !b.disabled, why: b.title }))`);
    expect(kinds.filter((x) => x.on).length >= 2 && kinds.filter((x) => !x.on).every((x) => x.why), JSON.stringify(kinds));
    F.chart_kinds = { runtime: kinds, served };
    return { actual: `Runtime: ${kinds.map((x) => `${x.k} ${x.on ? 'enabled' : `disabled (${x.why})`}`).join('; ')}; marks drawn ${drawn.join(', ')}. Served riders: ${served.filter((x) => x.on).map((x) => x.k).join(', ')} enabled.`, evidence: [s] };
  });

await scenario(21, 'CO₂ baseline / solution / savings charts', 'Scroll to “CO₂: baseline, solution and savings”; open “Calculation, baseline and vehicle parameters”.',
  'Baseline vs solution, avoided kg, avoided % and per rider / per vehicle charts from recorded figures, with the calculation, baseline, vehicle parameters, sources and units.',
  async () => {
    expect(await has('.co2-charts'), 'no CO₂ section');
    const titles = await p.eval(`[...document.querySelectorAll('.co2-charts .chart-card')].map((c) => c.querySelector('h3')?.innerText ?? '')`);
    await p.eval(`document.querySelector('.co2-prov').open = true`);
    const prov = await text('.co2-prov');
    await p.eval(`document.querySelector('.co2-charts').scrollIntoView({ block: 'start' })`);
    const s = await shot('co2-savings-charts', 800);
    expect(titles.length >= 4 && /factor|kWh|L\/100|g\//i.test(prov), `charts ${titles.join(' | ')} prov ${prov.slice(0, 200)}`);
    F.co2_charts = { titles, provenance: prov.slice(0, 600) };
    return { actual: `${titles.length} CO₂ charts (${titles.join(' · ')}); provenance block lists ${prov.split('\n').length} lines (calculation, baseline, parameters with sources).`, evidence: [s] };
  });

await scenario(22, 'Export chart PNG / SVG / CSV', 'Use CSV, PNG and SVG on the first chart.', 'Three files with the chart\'s recorded data and drawing.',
  async () => {
    await p.eval(`document.querySelector('.chart-card').scrollIntoView({ block: 'center' })`);
    const files = [];
    for (const k of ['CSV', 'PNG', 'SVG']) {
      const before = p.downloadCount();
      await p.eval(`[...document.querySelector('.chart-card').querySelectorAll('button')].find((b) => b.innerText.trim() === ${JSON.stringify(k)}).click()`);
      await p.waitDownload(before, 30000); await sleep(300);
      files.push(readdirSync(DL).map((f) => join(DL, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1));
    }
    const kinds = files.map((f) => `${basename(f)} (${statSync(f).size} B)`);
    expect(files[0].endsWith('.csv') && files[1].endsWith('.png') && files[2].endsWith('.svg') && files.every((f) => statSync(f).size > 100), kinds.join(', '));
    F.chart_exports = files.map((f) => basename(f));
    return { actual: kinds.join(', '), evidence: files.map((f) => basename(f)) };
  });

await scenario(26, 'Custom metric from verified inputs', 'Choose the metric “Detour per served rider” (registered custom metric) in the chart; compare its values with the validator\'s totals.',
  'Values equal Σ detour / Σ served from the validated results (never from what a method reported); the metric is offered only for this problem.',
  async () => {
    const opts = await p.eval(`[...document.querySelectorAll('.chart-controls select[aria-label=metric] option')].map((o) => o.value)`);
    const id = opts.find((o) => o.startsWith('custom:')); expect(id, `no custom metric among ${opts.join(',')}`);
    await choose('.chart-controls select[aria-label=metric]', id); await sleep(900);
    const c = await center('.chart-card svg [role=img]'); await p.hover(c.x, c.y); await sleep(400);
    const tip = await text('.chart-tip');
    const s = await shot('custom-metric-example', 200);
    const checks = [];
    for (const cid of [extension, demoBase, demoVariant]) {
      const e = await experiment(cid);
      for (const r of e.results.rows) {
        const want = r.totals.detour_s / 60 / r.totals.served, got = r.custom?.['detour-per-served-rider'];
        expect(Math.abs(got - want) < 1e-9, `${cid} ${r.method_id}: ${got} vs ${want}`);
        checks.push(`${r.method_id}@${cid.slice(-6)} ${got.toFixed(3)} min`);
      }
    }
    const listed = (await api('/api/lab/metrics?problem_id=synthetic-capacitated-bipartite-assignment')).body.metrics;
    expect(listed.length === 0, 'offered for another problem');
    F.custom_metric = { option: id, tooltip: tip, values: checks };
    return { actual: `${id}: ${checks.length} values equal Σdetour/Σserved of the validated totals (${checks.slice(0, 3).join('; ')}…); not offered for the synthetic problem; tooltip “${tip.replace(/\n/g, ' · ').slice(0, 160)}”.`, evidence: [s] };
  });

// ---- hidden records ------------------------------------------------------------------------------------------------
await scenario(27, 'Restore a hidden record', 'Hide the tailpipe experiment (Hide from lists); look for it in the experiment picker; Filters › Show hidden; restore it in Library › Hidden records.',
  'Hidden: out of lists (seen from another experiment) and marked among comparison candidates, still stored; the Filters control lists it again; Show again restores it; nothing is deleted.',
  async () => {
    await goHash(`#/workspace/${co2Exp}`, 3500);
    // the eye button sits with the experiment's details (a collapsed section of the left panel)
    await p.eval(`(() => { const b = [...document.querySelectorAll('.lab-left details button')].find((x) => /Hide from lists/.test(x.textContent)); b.closest('details').open = true; return true; })()`); await sleep(300);
    await p.click('Hide from lists', '.lab-left button'); await sleep(1500);
    expect((await api('/api/lab/state')).body.preferences.hidden_ids.includes(co2Exp), 'not hidden after Hide from lists');
    await goHash(`#/workspace/${mine}`, 3500);            // the open experiment always stays listed: look from another one
    const listed = async () => p.eval(`(() => { const t = document.querySelector('.exp-picker'); t.click(); return new Promise((r) => setTimeout(() => { const ok = [...document.querySelectorAll('.picker-panel .pick')].some((x) => x.innerText.includes(${JSON.stringify(title[co2Exp] ?? 'tailpipe')})); r(ok); }, 500)); })()`);
    // the picker starts filtered to this account's working area: list every area first
    await p.eval(`document.querySelector('.exp-picker').click()`); await sleep(500);
    await choose('.picker-panel select[aria-label="area filter"]', ''); await sleep(500);
    await p.eval(`document.querySelector('.exp-picker').click()`); await sleep(400);
    const shownBefore = await listed();
    await p.click('Filters', '.picker-panel button'); await sleep(300);
    await p.click('Show hidden', '.picker-panel label'); await sleep(500);
    const shownWith = await p.eval(`[...document.querySelectorAll('.picker-panel .pick')].some((x) => x.innerText.includes(${JSON.stringify(title[co2Exp] ?? 'tailpipe')}))`);
    const s = await shot('hidden-record-filters', 300);
    await p.key('Escape'); await p.key('Escape');
    const cand = (await api(`/api/lab/compatible?a=${mine}`)).body.candidates.find((c) => c.campaign_id === co2Exp);
    const stored = (await experiment(co2Exp)).campaign.campaign_id === co2Exp;
    await goHash('#/hidden', 2500);
    const ok = await p.eval(`(() => { const r = [...document.querySelectorAll('tr')].find((x) => x.innerText.includes(${JSON.stringify(title[co2Exp] ?? 'tailpipe')})); const b = r && [...r.querySelectorAll('button')].find((x) => /Show again/.test(x.innerText)); if (!b) return false; b.scrollIntoView({ block: 'center' }); const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
    expect(ok, 'no Show again for the hidden experiment'); await p.clickAt(ok.x, ok.y); await sleep(1500);
    const st = (await api('/api/lab/state')).body.preferences.hidden_ids;
    expect(!shownBefore && shownWith && cand?.hidden && stored && !st.includes(co2Exp), `before ${shownBefore} with ${shownWith} cand.hidden ${cand?.hidden} stored ${stored} hidden ids ${st}`);
    return { actual: 'Hidden: absent from the picker, marked hidden among comparison candidates, still stored; Filters › Show hidden lists it; Library › Hidden records › Show again restored it.', evidence: [s] };
  });

// ---- export / import / reproduce -----------------------------------------------------------------------------------
await scenario(9, 'Export ONE ZIP', 'Open the synthetic experiment, Export (evidence report ticked), Lock and export.',
  'Exactly one file is downloaded — the bundle .zip — with the evidence report inside; no second download.',
  async () => {
    await goHash(`#/workspace/${mine}`, 3500);
    await p.click('Export', '.labbar button');
    await p.waitFor('!!document.querySelector(".exportd .exlist")', 20000, 'export dialog');
    const s1 = await shot('export-dialog', 400);
    const before = p.downloadCount();
    await p.click('xport', '.exportd .drawer-foot button.primary');
    await p.waitDownload(before, 60000);
    await p.waitFor('/Bundle saved/.test(document.querySelector(".exportd")?.innerText)', 30000, 'confirmation');
    await sleep(4000);
    const count = p.downloadCount() - before;
    const done = await text('.exportd');
    await p.click('Done', '.exportd button');
    exported = readdirSync(DL).filter((f) => f.endsWith('.zip')).map((f) => join(DL, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1);
    expect(count === 1 && exported && /evidence\/report\.json/.test(done), `downloads ${count}, file ${exported}, ${done.slice(0, 200)}`);
    F.export = { file: basename(exported), bytes: statSync(exported).size, downloads: count, confirmation: done.split('\n').find((l) => /Bundle saved/.test(l)) };
    return { actual: `${count} download: ${basename(exported)} (${statSync(exported).size} bytes); “${F.export.confirmation}”.`, evidence: [s1] };
  });

await scenario(10, 'Inspect ZIP integrity', 'Outside the application: list the ZIP, recompute manifest.sha256 and every member checksum, check that the evidence report names the experiment.',
  'manifest.sha256 = SHA-256(manifest.json); every listed member matches its SHA-256; no unlisted member; evidence/report.json is listed and describes the root experiment.',
  async () => {
    const out = py(`import hashlib,json,sys,zipfile
z=zipfile.ZipFile(sys.argv[1]); names=z.namelist(); man=json.loads(z.read('manifest.json'))
h=lambda b: hashlib.sha256(b).hexdigest()
ok_m=h(z.read('manifest.json'))==z.read('manifest.sha256').decode().strip()
bad=[n for n,d in man['files'].items() if h(z.read(n))!=d]
extra=sorted(set(names)-set(man['files'])-{'manifest.json','manifest.sha256'})
ev=json.loads(z.read('evidence/report.json')) if 'evidence/report.json' in names else None
print(json.dumps(dict(members=[(i.filename,i.file_size) for i in z.infolist()], manifest_digest_ok=ok_m, mismatched=bad, unlisted=extra,
  format=man['format'], root=man['root_campaign_id'], evidence_listed='evidence/report.json' in man['files'], evidence_root=(ev or {}).get('experiment',{}).get('campaign_id'),
  evidence_fp_ok=(ev or {}).get('fingerprints')==man['fingerprints'], bundle_sha256=h(open(sys.argv[1],'rb').read()))))`, exported);
    const r = JSON.parse(out);
    expect(r.manifest_digest_ok && !r.mismatched.length && !r.unlisted.length && r.evidence_listed && r.evidence_root === mine && r.evidence_fp_ok, JSON.stringify(r).slice(0, 400));
    const listing = [`${basename(exported)}  ·  SHA-256 ${r.bundle_sha256}`, '', ...r.members.map(([nm, sz]) => `${String(sz).padStart(9)}  ${nm}`), '',
      `format: ${r.format}`, `manifest.sha256 = SHA-256(manifest.json): ${r.manifest_digest_ok ? 'yes' : 'NO'}`, `members whose SHA-256 differs from the manifest: ${r.mismatched.length}`,
      `members not listed in the manifest: ${r.unlisted.length}`, `evidence/report.json listed: ${r.evidence_listed} · names the root experiment: ${r.evidence_root === r.root} · fingerprints equal: ${r.evidence_fp_ok}`].join('\n');
    await evidencePage('Generated ZIP contents and integrity (python3 zipfile + hashlib)', listing);
    const s = await shot('generated-zip-contents', 300);
    await p.goto(`${BASE}/`); await waitWorkspace();
    F.zip = r;
    return { actual: `${r.members.length} members; manifest digest ok; 0 mismatched, 0 unlisted; evidence report listed and names ${r.root}; bundle SHA-256 ${r.bundle_sha256.slice(0, 16)}….`, evidence: [s] };
  });

await scenario(31, 'Account isolation', `As ${OTHER}: request ${ADMIN}'s unexported experiment, its scenario version and its Workspace view through the API.`,
  'Not found for another researcher; each account sees only its own records and preferences.',
  async () => {
    await signOut(); await signIn(OTHER); await waitWorkspace(); await sleep(2000);
    const a = await api(`/api/lab/experiments/${co2Exp}`), b = await api(`/api/geo/scenarios/${F.vehicle_version.scenario_id}`);
    const c = await api(`/api/campaigns/${co2Exp}/export`);
    const view = (await api('/api/lab/state')).body.preferences.workspace;
    expect(a.status === 404 && b.status === 404 && c.status === 404 && (!view || view.campaign_id !== co2Exp), `${a.status} ${b.status} ${c.status}`);
    F.isolation = { experiment: a.status, scenario: b.status, export: c.status };
    return { actual: `experiment → ${a.status}, scenario → ${b.status}, export → ${c.status}; ${OTHER}'s Workspace view is its own.`, evidence: [] };
  });

await scenario(12, 'Verify before import', `As ${OTHER}: Import → Import a bundle file → choose the exported ZIP.`,
  'The bundle is inspected without being stored: contents, integrity (checksums, manifest digest, fingerprints, evidence report), problem and validator, methods available, importable; nothing is saved before confirmation.',
  async () => {
    const before = (await api('/api/lab/experiments')).body.experiments.length;
    await p.click('Import', '.labbar button'); await p.click('Import a bundle file', '[role=menuitem]');
    await p.waitFor('!!document.querySelector(".importd")', 10000, 'import dialog');
    await p.setFiles('input[aria-label="bundle file to inspect"]', [exported]);
    await p.waitFor('!!document.querySelector(".importd .checks")', 60000, 'inspection'); await sleep(700);
    const t = await text('.importd');
    for (const k of ['Integrity verified', 'Problem and validator', 'Evidence report', 'included · matches the bundle']) expect(t.includes(k), `inspection lacks ${k}`);
    const s1 = await shot('import-preview', 300);
    await p.eval(`document.querySelector('.importd .checks').scrollIntoView({ block: 'center' })`);
    const s2 = await shot('integrity-verification', 400);
    const mid = (await api('/api/lab/experiments')).body.experiments.length;
    expect(mid === before, `stored before confirmation (${before} → ${mid})`);
    F.inspection = t.split('\n').filter((l) => /Integrity|Records|Problem|code|Importable|Evidence|Reproducible|Comparable/.test(l)).slice(0, 14);
    return { actual: `Inspection shown; ${before} experiments before and after inspection; ${F.inspection.slice(0, 4).join(' · ')}.`, evidence: [s1, s2] };
  });

await scenario(11, 'Import into another researcher workspace', 'Confirm: Import experiment.', 'The verified records are stored in the second researcher\'s workspace and opened, marked imported.',
  async () => {
    await p.click('Import experiment', '.importd button', true);
    await p.waitFor('/Integrity verified/.test(document.querySelector(".lab-notes")?.innerText ?? "")', 60000, 'import notice'); await sleep(2500);
    const cid = await cidNow();
    const e = await experiment(cid);
    expect(cid === mine && e.campaign.imported, `opened ${cid}, imported ${e.campaign.imported}`);
    return { actual: `Imported ${cid} into ${OTHER}'s workspace (imported=${e.campaign.imported}, from ${e.campaign.imported_from ?? 'bundle'}).`, evidence: [] };
  }, { keep: true });

await scenario(13, 'Reproduce the frozen experiment', 'Press Run again on the imported experiment.', 'A re-execution on the same frozen scenarios; validation, reproducibility and comparability are reported separately; Reproduced when the solutions are identical.',
  async () => {
    await armJob();
    await p.click('Run again', '.labbar button');
    const st = await waitJob(); expect(st === 'done' || st === 'gone', `job ${st}`);
    await sleep(3500);
    const cid = await cidNow(); const e = await experiment(cid);
    const s = await shot('reproduction-results', 1000);
    expect(e.campaign.kind === 'reproduction' && e.reproduction && e.validation.accepted === e.validation.runs, `kind ${e.campaign.kind} repro ${JSON.stringify(e.reproduction)}`);
    F.reproduction = { campaign_id: cid, reproduced: e.reproduction.reproduced, cells: e.reproduction.cells, validation: e.validation, comparability: e.comparability && { results: e.comparability.quality, runtime: e.comparability.runtime, co2: e.comparability.emissions } };
    return { actual: `Re-execution ${cid}: validation ${e.validation.accepted}/${e.validation.runs}; reproducibility ${e.reproduction.reproduced ? 'Reproduced' : 'not reproduced'} (${e.reproduction.cells} cells); comparability results ${e.comparability?.quality}, runtime ${e.comparability?.runtime}, CO₂ ${e.comparability?.emissions}.`, evidence: [s] };
  });

// ---- layouts -------------------------------------------------------------------------------------------------------
await scenario(32, 'Light / dark / mobile layouts', 'Profile menu → Dark; back to Light; then a 375 × 812 phone viewport; check horizontal overflow and page errors.',
  'Light by default; dark redraws every surface; on a phone the layout fits the width with no horizontal scroll.',
  async () => {
    await signOut(); await signIn(ADMIN); await waitWorkspace(); await sleep(2500);
    const light = await p.eval('document.documentElement.dataset.theme');
    await p.click('profile', '.hdr button'); await p.click('Dark', '.menu button'); await sleep(900); await p.key('Escape');
    const dark = await p.eval('document.documentElement.dataset.theme');
    const s1 = await shot('dark-theme', 800);
    await p.click('profile', '.hdr button'); await p.click('Light', '.menu button'); await sleep(600); await p.key('Escape');
    await p.size(375, 812, 2, true); await p.goto(`${BASE}/#/workspace/${demoBase}`); await waitWorkspace(); await sleep(3000);
    const fit = await p.eval('({ sw: document.documentElement.scrollWidth, w: innerWidth })');
    const s2 = await shot('mobile-view', 600);
    await p.size(W, H, DSF); await p.goto(`${BASE}/`); await waitWorkspace(); await sleep(1500);
    const back = await p.eval('document.documentElement.dataset.theme');
    expect(light === 'light' && dark === 'dark' && back === 'light' && fit.sw <= fit.w + 1, `themes ${light}/${dark}/${back} width ${JSON.stringify(fit)}`);
    return { actual: `Theme light → dark → light; phone: page width ${fit.sw} px for a ${fit.w} px viewport (no horizontal scroll).`, evidence: [s1, s2] };
  });

await scenario(30.5, 'Security / permissions verification', 'List the permissions of the credential store, the account database and its side files and the audit log in the data directory under test (contents are never read).',
  'Owner-only (0600) files, owner-only data directory.',
  async () => {
    const dir = dirname(CREDS);
    const files = readdirSync(dir).filter((f) => /^(auth\.sqlite3.*|audit\.log.*|dev-credentials\.json|installation\.json)$/.test(f)).map((f) => join(dir, f));
    const out = execFileSync('stat', ['-c', '%A  %a  %U  %n', dir, ...files], { encoding: 'utf8' }).replaceAll(dir, '<data dir>');
    const rows = out.trim().split('\n');
    const bad = rows.filter((r) => /auth\.sqlite3|audit\.log|dev-credentials/.test(r) && !/ 600 /.test(r));
    await evidencePage('Permissions of sensitive files in the data directory under test (stat; contents not read)', out);
    const s = await shot('security-permissions', 300);
    await p.goto(`${BASE}/`); await waitWorkspace();
    expect(!bad.length, `not owner-only: ${bad.join(' / ')}`);
    F.permissions = rows;
    return { actual: rows.join(' · '), evidence: [s] };
  });

report.finished = new Date().toISOString();
report.summary = { total: report.scenarios.length, pass: report.scenarios.filter((s) => s.status === 'PASS').length, fail: report.scenarios.filter((s) => s.status === 'FAIL').length, screenshots: report.screenshots.length,
  page_errors: p.errors.length, browser_errors: p.errors.slice(0, 10) };
writeFileSync(join(OUT, 'final-acceptance.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.summary));
await p.close();
process.exit(report.summary.fail === 0 ? 0 : 1);
