#!/usr/bin/env node
// "+ Add method" in a real browser, on synthetic accounts and the public Montbéliard demonstration only:
//
//   MOVE_OPENLAB_DATA_DIR=<empty dir> python scripts/e2e/seed_ci.py
//   MOVE_OPENLAB_DATA_DIR=<same dir> MOVE_OPENLAB_FRONTEND_DIST=<built dist> MOVE_OPENLAB_TILE_URL=none \
//     MOVE_OPENLAB_PLUGIN_MODE=sandbox MOVE_OPENLAB_PLUGIN_DIR=<repository>/plugins move-openlab serve --port 8803
//   node scripts/e2e/plugins.mjs --base http://127.0.0.1:8803 --creds <dir>/dev-credentials.json --out <out dir>
//
// A) Built-in methods are listed with kind and version. B) A ready-made example from the catalogue is inspected,
// checked (nothing executed), registered (sandboxed self-test), run on the demonstration, validated and compared;
// registering it again is disabled with the reason and refused by the server. C) Create from template: the form is
// filled, the template ZIP is generated and downloaded, its members and METADATA are checked, solve() is completed by
// this script (a small greedy), the ZIP is uploaded, the checks pass step by step (archive, metadata, sandboxed
// self-test), the method is registered, run, validated and compared; a malicious ZIP (../evil.py) is refused with the
// reason. D) Dark theme and a 375 px phone. Passwords come from the credentials file and are never printed.
// Writes plugins.json (expected, actual, PASS/FAIL), screenshots, the generated and the completed ZIP. Exit 1 on failure.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8803'), OUT = arg('out'), CREDS = arg('creds');
if (!OUT || !CREDS) { console.error('usage: plugins.mjs --base URL --creds FILE --out DIR'); process.exit(2); }
const chrome = process.env.CHROME ?? (() => {
  const root = join(homedir(), '.cache/ms-playwright');
  const dir = existsSync(root) && readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().at(-1);
  return dir ? join(root, dir, 'chrome-linux64/chrome') : 'chromium';
})();
const SHOTS = join(OUT, 'screenshots'), DL = join(OUT, 'downloads');
mkdirSync(SHOTS, { recursive: true }); mkdirSync(DL, { recursive: true });
const creds = JSON.parse(readFileSync(CREDS, 'utf8'));
const pw = (u) => (typeof creds[u] === 'string' ? creds[u] : creds[u]?.password);
const USER = 'researcher1', PID = 'public-ride-matching', NAME = 'gui_greedy', DISPLAY = 'GUI Greedy';

// ---------------------------------------------------------------- a minimal ZIP reader / writer (no dependency)
function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  const n = buf.readUInt16LE(e + 10); let o = buf.readUInt32LE(e + 16); const out = {};
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20), nl = buf.readUInt16LE(o + 28), xl = buf.readUInt16LE(o + 30), cl = buf.readUInt16LE(o + 32);
    const name = buf.subarray(o + 46, o + 46 + nl).toString(), lh = buf.readUInt32LE(o + 42);
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28), raw = buf.subarray(start, start + csize);
    out[name] = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    o += 46 + nl + xl + cl;
  }
  return out;
}
function zip(entries) {
  const locals = [], central = []; let off = 0;
  for (const [name, data] of entries) {
    const nb = Buffer.from(name), comp = deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); central.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const GREEDY = `def solve(instance, config) -> dict:
    """Nearest pickup first: each free driver takes the not yet served rider it reaches soonest."""
    used, served, out = set(), set(), []
    for p in sorted(instance["pairs"], key=lambda p: (p["to_pickup_s"], p["driver"], p["rider"])):
        if p["driver"] not in used and p["rider"] not in served:
            used.add(p["driver"]); served.add(p["rider"]); out.append([p["driver"], p["rider"]])
    return dict(decisions=out, status="HEURISTIC", declared=dict(served=len(out)))
`;

// ---------------------------------------------------------------- browser helpers
const report = { base: BASE, started: new Date().toISOString(), checks: [], facts: {} };
const F = report.facts;
let n = 0;
const W = 1440, H = 900;
const p = await launch(chrome, { width: W, height: H });
await p.size(W, H, 1);
await p.allowDownloads(DL);
const shot = async (name, settle = 500) => { await sleep(settle); const f = `${String(++n).padStart(2, '0')}-${name}.png`; await p.shot(join(SHOTS, f)); return f; };
const expect = (c, m) => { if (!c) throw new Error(m); };
const text = (css = 'body') => p.eval(`(document.querySelector(${JSON.stringify(css)})?.innerText ?? '')`);
const api = (path, init = {}) => p.eval(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }))`);
const goHash = async (h, settle = 2500) => { await p.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(settle); };
const cidNow = async () => decodeURIComponent((await p.eval('location.hash')).split('/')[2] ?? '');
const experiment = async (cid) => (await api(`/api/lab/experiments/${cid}`)).body;
const dialog = () => text('[role=dialog]');
const armJob = () => p.eval(`(() => { window.__jobSeen = false; const o = new MutationObserver(() => { if (document.querySelector('.job')) { window.__jobSeen = true; o.disconnect(); } }); o.observe(document.body, { childList: true, subtree: true }); return true; })()`);
async function waitJob(timeout = 300000) {
  await p.waitFor('window.__jobSeen === true || !!document.querySelector(".job")', 30000, 'job progress');
  await p.waitFor('["done","error","cancelled","interrupted"].includes(document.querySelector(".job")?.dataset.state) || !document.querySelector(".job")', timeout, 'job end');
  return p.eval('document.querySelector(".job")?.dataset.state ?? "gone"');
}
const waitWorkspace = () => p.waitFor('!!document.querySelector(".lab-grid") && !/Loading the demonstration/.test(document.querySelector(".lab-notes")?.innerText ?? "")', 90000, 'workspace');
/** Click a button (by exact text or aria-label) inside the first element matching `scope` whose text contains `contains`. */
const clickIn = (scope, contains, button) => p.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.innerText.includes(${JSON.stringify(contains)}));
  if (!el) throw new Error('no ' + ${JSON.stringify(scope)} + ' with ' + ${JSON.stringify(contains)}); const b = [...el.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(button)} || x.getAttribute('aria-label') === ${JSON.stringify(button)});
  if (!b) throw new Error('no button ' + ${JSON.stringify(button)}); if (b.disabled) return 'disabled'; b.click(); return 'clicked'; })()`);
const openAddMethod = async (tab) => {
  await p.click('Add method', '.lab-right button');
  await p.waitFor('!!document.querySelector(".drawer.addm") && !/Loading…/.test(document.querySelector(".drawer.addm").innerText)', 15000, 'Add method dialog');
  await p.click(tab, '.choice'); await sleep(700);
};
async function check(id, title, expected, fn) {
  const t0 = Date.now(), e0 = p.errors.length;
  const rec = { id, title, expected, actual: '', status: 'FAIL', evidence: [], ms: 0, page_errors: [] };
  try { const r = await fn(); rec.actual = r?.actual ?? ''; rec.evidence = r?.evidence ?? []; rec.status = 'PASS'; }
  catch (e) { rec.actual = `ERROR: ${String(e.message ?? e).slice(0, 600)}`; try { const f = `fail-${id}.png`; await p.shot(join(SHOTS, f)); rec.evidence.push(f); } catch { /* page gone */ } }
  // an HTTP 4xx answer the check provokes on purpose (refused re-registration, refused ZIP) is logged by Chromium as a console error
  rec.page_errors = p.errors.slice(e0).filter((x) => !/status of 4\d\d/.test(x)); rec.ms = Date.now() - t0;
  if (rec.page_errors.length) { rec.status = 'FAIL'; rec.actual += ` · page errors: ${rec.page_errors.join(' | ').slice(0, 300)}`; }
  report.checks.push(rec);
  console.log(`${rec.status}  ${id} ${title} — ${rec.actual.slice(0, 220)}`);
  writeFileSync(join(OUT, 'plugins.json'), JSON.stringify(report, null, 1));
}
async function runAndCompare(methodId, name, cardScope, cardText) {
  await armJob();
  expect(await clickIn(cardScope, cardText, 'Run with this method') === 'clicked', 'Run with this method is not offered');
  const st = await waitJob(); expect(st === 'done' || st === 'gone', `job ${st}`);
  await sleep(3000);
  const ext = await cidNow(), e = await experiment(ext);
  const row = e.results.rows.find((r) => r.method_id === methodId);
  expect(e.campaign.kind === 'extended' && row && e.validation.accepted === e.validation.runs && e.validation.runs > 0 && !row.proven_optimal,
    `${ext} ${e.campaign.kind} ${JSON.stringify(e.validation)}`);
  const s1 = await shot(`${methodId}-validated`, 600);
  await p.click('Compare', '.labbar button');
  await p.waitFor('location.hash.startsWith("#/methods/") && !!document.querySelector(".cmp-table")', 60000, 'Compare methods'); await sleep(1500);
  const cmp = await text('.cmp-table');
  expect(cmp.includes(name), `Compare does not show ${name}`);
  const s2 = await shot(`${methodId}-compare`, 600);
  return { ext, validation: e.validation, served: row.totals.served, shots: [s1, s2] };
}

let base = '';
await check('A', 'Built-in methods', 'Sign in; the demonstration opens; + Add method → Built-in methods lists every built-in method of the open problem with kind and version and Run with this method.', async () => {
  await p.goto(`${BASE}/login`);
  await p.focusCss('input[name=username]'); await p.type(USER);
  await p.focusCss('input[name=password]'); await p.type(pw(USER));
  await p.click('Sign in', 'button');
  await p.waitFor('location.pathname === "/" && !!document.querySelector(".hdr")', 30000, 'sign-in');
  await waitWorkspace(); await sleep(2500);
  base = (await api('/api/lab/experiments')).body.experiments.find((x) => x.demo && x.kind === 'baseline')?.campaign_id;
  expect(base, 'no demonstration baseline');
  await goHash(`#/workspace/${base}`, 3000);
  await openAddMethod('Built-in methods');
  const m = (await api(`/api/problems/${PID}/methods`)).body;
  const t = await dialog();
  const missing = m.builtin.filter((b) => !b.archived && !(t.includes(b.name) && t.includes(b.version)));
  expect(!missing.length, `not listed: ${missing.map((b) => b.name)}`);
  expect(/Run with this method|Run\b/.test(t), 'no Run with this method');
  const s = await shot('builtin-methods');
  F.builtin = m.builtin.filter((b) => !b.archived).map((b) => `${b.name} ${b.kind} ${b.version}`);
  return { actual: `Listed: ${F.builtin.join('; ')}.`, evidence: [s] };
});

await check('B', 'Register a ready-made example, run, validate, compare; registering again is refused', 'Catalogue groups with states → Details → Check compatibility (static) → Register (sandboxed self-test) → Run with this method → all validated → Compare shows it; then Register is disabled with the reason and the server refuses a second registration.', async () => {
  await p.click('Register my method', '.choice'); await sleep(1000);
  const t = await dialog();
  for (const k of ['Ready-made examples', 'Nearest Pickup First', 'My Greedy Matching', 'Available, not registered']) expect(t.includes(k), `catalogue lacks ${k}`);
  const cat = (await api(`/api/problems/${PID}/methods`)).body.plugins;
  F.catalogue = cat.map((i) => `${i.plugin} [${i.catalog}, ${i.state}]`);
  expect(cat.find((i) => i.plugin === 'nearest_pickup')?.catalog === 'example', 'nearest_pickup is not marked as an example');
  const s0 = await shot('catalogue');
  await p.click('details of Nearest Pickup First', '.addm .plug button'); await sleep(500);
  await p.click('Check compatibility', '.aminspect button');
  await p.waitFor('/Static check/.test(document.querySelector(".aminspect")?.innerText ?? "")', 20000, 'compatibility check');
  const insp = await text('.aminspect');
  expect(/Metadata \(read without running the code\) — ok/.test(insp) && /Not registered yet — ok/.test(insp), `check: ${insp.slice(0, 300)}`);
  for (const k of ['nearest-pickup', 'lex-max-served-riders-then-min-detour/1.0.0', 'Ready-made examples']) expect(insp.includes(k), `inspector lacks ${k}`);
  const s1 = await shot('inspect-and-check');
  expect(await clickIn('.aminspect', 'Check compatibility', 'Register') === 'clicked', 'Register not clickable');
  await p.waitFor('/Registered Nearest Pickup First/.test(document.querySelector("[role=dialog]")?.innerText ?? "")', 120000, 'registration');
  const s2 = await shot('registered-example');
  // registering again: disabled with the reason in the interface, refused by the server
  await p.waitFor('[...document.querySelectorAll(".addm .plug")].some((r) => /Nearest Pickup First/.test(r.innerText) && /Registered · code pinned/.test(r.innerText))', 15000, 'registered state');
  if (!(await p.eval('!!document.querySelector(".aminspect")'))) await p.click('details of Nearest Pickup First', '.addm .plug button');
  await sleep(500);
  const again = await clickIn('.aminspect', 'Check compatibility', 'Register');
  const why = await text('.aminspect');
  expect(again === 'disabled' && /Already registered: nearest-pickup@1\.0\.0/.test(why), `again=${again} ${why.slice(0, 200)}`);
  const srv = await api(`/api/problems/${PID}/methods/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin: 'nearest_pickup' }) });
  expect(srv.status === 400 && /already registered/.test(srv.body.detail), `server ${srv.status} ${JSON.stringify(srv.body)}`);
  const s3 = await shot('register-again-refused');
  const r = await runAndCompare('nearest-pickup', 'Nearest Pickup First', '[role=dialog] .note, [role=dialog] .plug', 'Nearest Pickup First');
  F.example = { extension: r.ext, validation: r.validation, served: r.served, refused_again: srv.body.detail };
  return { actual: `Registered from the catalogue; extension ${r.ext}: ${r.validation.accepted}/${r.validation.runs} validated, ${r.served} served, no optimality claimed; Compare shows it. Again: button disabled (“Already registered…”), server ${srv.status} “${srv.body.detail}”.`, evidence: [s0, s1, s2, s3, ...r.shots] };
});

await check('C', 'Create from template: generate, complete, upload, check, register, run, validate, compare; malicious ZIP refused', 'Form → Generate (ZIP downloaded: plugin.py, test_plugin.py, README.md; METADATA has the typed name) → solve() completed → upload → ZIP checked, metadata ok, self-test in the sandbox ok → Register → Run → validated → Compare; ../evil.py refused with the reason.', async () => {
  await goHash(`#/workspace/${base}`, 3000);
  await openAddMethod('Create from template');
  expect(/does not write your algorithm or train a model/.test(await dialog()), 'the plain statement is missing');
  await p.fill('.addm input[aria-label="method name"]', NAME);
  await p.fill('.addm input[aria-label="display name"]', DISPLAY);
  await p.fill('.addm input[aria-label="author"]', 'Researcher 1');
  await p.eval(`(() => { const e = document.querySelector('.addm select[aria-label="kind"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, 'heuristic'); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await p.fill('.addm input[aria-label="short description"]', 'Nearest pickup first, written in the browser check.');
  await p.waitFor('/pairs/.test(document.querySelector(".amtpl")?.innerText ?? "")', 15000, 'instance keys');
  const tplText = await text('.amtpl');
  expect(/driver_id, rider_id/.test(tplText) && /solve\(instance, config\)/.test(tplText), 'decision format or solve() not shown');
  const before = p.downloadCount();
  await p.click('Generate the template (.zip)', '.addm button');
  await p.waitDownload(before, 30000); await sleep(800);
  await p.waitFor('/Downloaded gui_greedy.zip/.test(document.querySelector(".amtpl")?.innerText ?? "")', 15000, 'download confirmation');
  const file = join(DL, `${NAME}.zip`);
  expect(existsSync(file), `no ${file}`);
  copyFileSync(file, join(OUT, `${NAME}-template.zip`));
  const members = unzip(readFileSync(file));
  expect(JSON.stringify(Object.keys(members).sort()) === JSON.stringify([`${NAME}/README.md`, `${NAME}/plugin.py`, `${NAME}/test_plugin.py`]), `members ${Object.keys(members)}`);
  const src = members[`${NAME}/plugin.py`].toString();
  expect(src.includes(`"name": "${DISPLAY}"`) && src.includes('"method_id": "gui-greedy"') && src.includes('"author": "Researcher 1"'), 'METADATA does not carry the typed values');
  expect(/move-openlab method check gui_greedy --bundle/.test(members[`${NAME}/README.md`].toString()), 'README lacks the check command');
  const s1 = await shot('template-generated');
  const done = src.slice(0, src.indexOf('def solve(')) + GREEDY;
  const completed = zip([[`${NAME}/plugin.py`, Buffer.from(done)], [`${NAME}/test_plugin.py`, members[`${NAME}/test_plugin.py`]], [`${NAME}/README.md`, members[`${NAME}/README.md`]]]);
  const completedFile = join(OUT, `${NAME}-completed.zip`);
  writeFileSync(completedFile, completed);
  await p.setFiles('.amtpl input[aria-label="plug-in ZIP to upload"]', [completedFile]);
  await p.waitFor('/Self-test in the sandbox — (ok|failed)/.test(document.querySelector(".amtpl .amcard")?.innerText ?? "")', 120000, 'upload checks');
  const steps = await text('.amtpl .amcard');
  for (const k of ['ZIP checked — ok', 'Metadata (read without running the code) — ok', 'Not registered yet — ok', 'Self-test in the sandbox — ok']) expect(steps.includes(k), `step missing: ${k} in ${steps.slice(0, 400)}`);
  const s2 = await shot('upload-checks-ok');
  expect(await clickIn('.amtpl .amcard', 'Self-test in the sandbox', 'Register') === 'clicked', 'Register not clickable');
  await p.waitFor(`/Registered ${DISPLAY}/.test(document.querySelector("[role=dialog]")?.innerText ?? "")`, 120000, 'registration');
  const s3 = await shot('template-registered');
  const r = await runAndCompare('gui-greedy', DISPLAY, '.amtpl .note, .amtpl .amcard', DISPLAY);
  // a malicious ZIP: refused before anything is stored, with the reason
  await goHash(`#/workspace/${base}`, 3000);
  await openAddMethod('Create from template');
  const evil = join(OUT, 'evil.zip');
  writeFileSync(evil, zip([['../evil.py', Buffer.from('import os\n')], ['x_evil/plugin.py', Buffer.from('METADATA = {}\n')]]));
  await p.setFiles('.amtpl input[aria-label="plug-in ZIP to upload"]', [evil]);
  await p.waitFor('/ZIP checked — failed/.test(document.querySelector(".amtpl .amcard")?.innerText ?? "")', 30000, 'refusal');
  const refusal = await text('.amtpl .amcard');
  expect(/'\.\.'/.test(refusal) && !/Register/.test(refusal), `refusal ${refusal}`);
  const s4 = await shot('malicious-zip-refused');
  const listed = (await api(`/api/problems/${PID}/methods`)).body.plugins.filter((i) => i.origin === 'uploaded').map((i) => i.plugin);
  expect(JSON.stringify(listed) === JSON.stringify(['gui_greedy@0.1.0']), `uploads ${listed}`);
  F.template = { zip: join(OUT, `${NAME}-template.zip`), completed: completedFile, extension: r.ext, validation: r.validation, served: r.served, refusal: refusal.split('\n').slice(-1)[0] };
  return { actual: `ZIP ${Object.keys(members).join(', ')} (${statSync(file).size} bytes); upload checks all ok; registered; extension ${r.ext}: ${r.validation.accepted}/${r.validation.runs} validated, ${r.served} served; Compare shows ${DISPLAY}. ../evil.py refused: “${F.template.refusal.slice(0, 120)}”.`, evidence: [s1, s2, s3, ...r.shots, s4] };
});

await check('D', 'Dark theme and 375 px phone', 'The catalogue and the template form render in the dark theme and at 375 px without horizontal scrolling.', async () => {
  await p.click('Register my method', '.choice'); await sleep(600);
  await p.eval(`document.documentElement.setAttribute('data-theme', 'dark')`); await sleep(300);
  const s1 = await shot('dark-catalogue');
  await p.eval(`document.documentElement.removeAttribute('data-theme')`);
  await p.size(375, 812, 2, true); await sleep(800);
  const fit = await p.eval('(() => { const d = document.querySelector(".drawer.addm"); return { sw: document.documentElement.scrollWidth, w: innerWidth, dw: d.scrollWidth, dcw: d.clientWidth }; })()');
  const s2 = await shot('phone-catalogue');
  await p.click('Create from template', '.choice'); await sleep(600);
  const fit2 = await p.eval('(() => { const d = document.querySelector(".drawer.addm"); return { sw: document.documentElement.scrollWidth, w: innerWidth, dw: d.scrollWidth, dcw: d.clientWidth }; })()');
  const s3 = await shot('phone-template');
  await p.size(W, H, 1);
  expect(fit.sw <= fit.w + 1 && fit.dw <= fit.dcw + 1 && fit2.sw <= fit2.w + 1 && fit2.dw <= fit2.dcw + 1, `widths ${JSON.stringify([fit, fit2])}`);
  return { actual: `Page ${fit.sw}/${fit.w} px, dialog ${fit.dw}/${fit.dcw} px (catalogue); ${fit2.dw}/${fit2.dcw} px (template).`, evidence: [s1, s2, s3] };
});

report.finished = new Date().toISOString();
report.summary = { total: report.checks.length, pass: report.checks.filter((c) => c.status === 'PASS').length };
writeFileSync(join(OUT, 'plugins.json'), JSON.stringify(report, null, 1));
console.log(`${report.summary.pass}/${report.summary.total} checks passed`);
await p.close();
process.exit(report.summary.pass === report.summary.total ? 0 : 1);
