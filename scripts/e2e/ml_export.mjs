#!/usr/bin/env node
// ML evaluation evidence in the experiment bundle, through the interface, on synthetic and public data only (the data
// directory made by scripts/e2e/seed_ci.py; server with MOVE_OPENLAB_PLUGIN_MODE=sandbox and the repository's plugins/):
//
//   node scripts/e2e/ml_export.mjs --base http://127.0.0.1:8791 --creds <dir>/dev-credentials.json --out <out dir>
//
// researcher1 runs the example learned plug-in on the public demonstration and imports the public SYNTHETIC evidence
// (examples/ml-evaluation, retargeted to that method). Then, in the Export dialog: Include the evidence · References
// only · Leave out — each ZIP is opened and checked (members, manifest, index, document SHA-256, no predictions in a
// reference export). researcher2 imports the full bundle through Import ▾ → Import a bundle file…: the import report
// says the documents were re-validated and recomputed, and the ML evaluation tab shows the same confusion matrix with a
// working threshold. administrator1 imports the reference bundle: the tab says "reference received with a bundle" and
// "not recomputable here", with no threshold control. Writes ml-export.json and screenshots; exit 1 on a failure.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8791'), OUT = arg('out'), CREDS = arg('creds');
if (!OUT || !CREDS) { console.error('usage: ml_export.mjs --base URL --creds FILE --out DIR'); process.exit(2); }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN = 'example_scored_filter', LEARNED = 'example-scored-filter-greedy', RIDE = 'public-ride-matching';
const KNOWN = { tp: 96, fn: 24, fp: 28, tn: 252 };
const chrome = process.env.CHROME ?? (() => {
  const r = join(homedir(), '.cache/ms-playwright'); const d = existsSync(r) && readdirSync(r).filter((x) => x.startsWith('chromium-')).sort().at(-1);
  return d ? join(r, d, 'chrome-linux64/chrome') : 'chromium';
})();
const SHOTS = join(OUT, 'screenshots'), DL = join(OUT, 'downloads');
mkdirSync(SHOTS, { recursive: true }); mkdirSync(DL, { recursive: true });
const creds = JSON.parse(readFileSync(CREDS, 'utf8'));
const pw = (u) => (typeof creds[u] === 'string' ? creds[u] : creds[u]?.password);
const report = { base: BASE, started: new Date().toISOString(), checks: [] };
let n = 0, p;
const shot = async (name) => { await sleep(600); const f = `${String(++n).padStart(2, '0')}-${name}.png`; await p.shot(join(SHOTS, f)); return f; };
const expect = (c, m) => { if (!c) throw new Error(m); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sameMatrix = (a, b) => !!a && !!b && ['tp', 'fn', 'fp', 'tn'].every((k) => a[k] === b[k]);
const api = (path, init = {}) => p.eval(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init)}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }))`);
const post = (path, body) => api(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
async function check(id, expected, fn) {
  const e0 = p ? p.errors.length : 0;
  const rec = { id, expected, actual: '', status: 'FAIL', evidence: [] };
  try { const r = await fn(); rec.actual = r.actual; rec.evidence = r.evidence ?? []; rec.status = 'PASS'; }
  catch (e) { rec.actual = `ERROR: ${String(e.message ?? e).slice(0, 500)}`; try { rec.evidence.push(await shot(`fail-${id}`)); } catch { /* */ } }
  if (p && p.errors.length > e0) { rec.status = 'FAIL'; rec.actual += ` · page errors: ${p.errors.slice(e0).join(' | ').slice(0, 300)}`; }
  report.checks.push(rec); console.log(`${rec.status}  ${id} — ${rec.actual.slice(0, 220)}`);
  writeFileSync(join(OUT, 'ml-export.json'), JSON.stringify(report, null, 1));
}
async function signIn(user) {
  if (p) await p.close();
  p = await launch(chrome, { width: 1440, height: 1000 }); await p.size(1440, 1000, 1); await p.allowDownloads(DL);
  await p.goto(`${BASE}/login`);
  await p.focusCss('input[name=username]'); await p.type(user); await p.focusCss('input[name=password]'); await p.type(pw(user));
  await p.click('Sign in', 'button');
  await p.waitFor('location.pathname === "/" && !!document.querySelector(".lab-grid")', 90000, `workspace of ${user}`); await sleep(2500);
}
// a ZIP written by Python's zipfile (stored or deflated members)
function unzip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const files = {}; let q = v.getUint32(end + 16, true);
  for (let i = 0; i < v.getUint16(end + 10, true); i++) {
    const method = v.getUint16(q + 10, true), csize = v.getUint32(q + 20, true), len = v.getUint16(q + 28, true), off = v.getUint32(q + 42, true);
    const name = buf.subarray(q + 46, q + 46 + len).toString('utf8');
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true), raw = buf.subarray(start, start + csize);
    files[name] = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    q += 46 + len + v.getUint16(q + 30, true) + v.getUint16(q + 32, true);
  }
  return files;
}
const latestZip = () => readdirSync(DL).filter((f) => f.endsWith('.zip')).map((f) => join(DL, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
let cid = '', evidenceSha = '';
const bundles = {};

try {
  await check('setup', 'researcher1: the example learned plug-in runs on the public demonstration (validated) and the synthetic evidence is imported for it.', async () => {
    await signIn('researcher1');
    const demo = await post('/api/lab/demo');
    const base = demo.body.baseline_id;
    const reg = await post(`/api/problems/${RIDE}/methods/register`, { plugin: PLUGIN });
    expect(reg.status === 200 || /already registered/.test(JSON.stringify(reg.body)), `registration ${reg.status} ${JSON.stringify(reg.body).slice(0, 200)}`);
    const ext = await post(`/api/campaigns/${base}/extend`, { methods: [[LEARNED, '1.0.0']] });
    cid = ext.body.campaign_id;
    const job = (await post(`/api/campaigns/${cid}/execute`)).body;
    for (let i = 0; i < 600; i++) { const j = (await api(`/api/jobs/${job.job_id}`)).body; if (j.state !== 'running') { expect(j.state === 'done', `job ${j.state}`); break; } await sleep(300); }
    const csv = readFileSync(join(ROOT, 'examples/ml-evaluation/synthetic-binary-evidence.csv'), 'utf8');
    const doc = JSON.parse(readFileSync(join(ROOT, 'examples/ml-evaluation/synthetic-binary-evidence.json'), 'utf8'));
    const meta = { ...doc, method_id: LEARNED }; delete meta.records; delete meta.format;
    const up = await p.eval(`(async () => { const f = new FormData(); f.append('file', new Blob([${JSON.stringify(csv)}], { type: 'text/csv' }), 'synthetic-binary-evidence.csv');
      f.append('method_id', ${JSON.stringify(LEARNED)}); f.append('metadata', ${JSON.stringify(JSON.stringify(meta))});
      const r = await fetch('/api/lab/experiments/${cid}/evaluation', { method: 'POST', body: f, credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; })()`);
    expect(up.status === 200, `evidence import ${up.status} ${JSON.stringify(up.body).slice(0, 300)}`);
    evidenceSha = up.body.evidence_sha256;
    const e = (await api(`/api/lab/experiments/${cid}`)).body;
    expect(e.validation.accepted === e.validation.runs, 'runs not all validated');
    return { actual: `extension ${cid}: ${e.validation.accepted}/${e.validation.runs} validated; evidence ${evidenceSha.slice(0, 12)}… (400 synthetic records)` };
  });

  for (const [mode, label] of [['full', 'Include the evidence'], ['reference', 'References only'], ['none', 'Leave out']]) {
    await check(`export-${mode}`, `Export dialog → ML evaluation evidence → "${label}" → the ZIP carries exactly that.`, async () => {
      await p.key('Escape'); await sleep(300);                     // a dialog left open by an earlier step
      await p.eval(`location.hash = '#/workspace/${cid}'`); await sleep(4000);
      await p.click('Export', '.labbar button', true); await p.waitFor('!!document.querySelector(".exportd")', 10000, 'export dialog');
      const section = await p.eval(`document.querySelector('.ml-export')?.innerText ?? ''`);
      expect(/ML evaluation evidence/.test(section) && /Include the evidence/.test(section) && /References only/.test(section) && /Leave out/.test(section), `section: ${section.slice(0, 200)}`);
      await p.click(label, '.ml-export button', true); await sleep(300);
      const s = await shot(`export-dialog-${mode}`);
      const before = p.downloadCount();
      await p.eval(`[...document.querySelectorAll('.exportd .drawer-foot button')].find((b) => /Export bundle|Lock and export/.test(b.innerText)).click()`);
      await p.waitDownload(before, 60000); await sleep(800);
      const buf = readFileSync(latestZip()), files = unzip(buf), man = JSON.parse(files['manifest.json']);
      expect(sha(files['manifest.json']) === files['manifest.sha256'].toString().trim(), 'manifest digest');
      const listed = Object.entries(man.files).every(([k, h]) => files[k] && sha(files[k]) === h);
      expect(listed, 'a member does not match its manifest checksum');
      const ml = Object.keys(files).filter((k) => k.startsWith('ml_evaluations/'));
      let detail;
      if (mode === 'none') {
        expect(ml.length === 0 && !man.ml_evaluations, `ML members ${ml.join(',')}`); detail = 'no ml_evaluations/ member, no manifest entry';
      } else {
        const idx = JSON.parse(files['ml_evaluations/index.json']), e = idx.entries[0];
        expect(man.ml_evaluations.mode === mode && idx.mode === mode && idx.entries.length === 1, `modes ${man.ml_evaluations.mode}/${idx.mode}`);
        expect(sameMatrix(e.recorded.confusion, KNOWN) && e.decision.rule === 'score>=threshold' && e.decision.threshold === 0.5, `recorded ${JSON.stringify(e.recorded.confusion)}`);
        expect(e.dataset.id && e.dataset.split && e.model.name && e.feature_pipeline.name && idx.metric_definitions.length >= 8, 'provenance or metric definitions missing');
        if (mode === 'full') {
          const f = `ml_evaluations/${evidenceSha}.json`;
          expect(files[f] && sha(files[f]) === evidenceSha && e.included && e.recomputable && JSON.parse(files[f]).records.length === 400, 'evidence document');
          detail = `index + ${f.slice(15, 27)}… (400 records, its SHA-256 = its name); recorded matrix ${JSON.stringify(e.recorded.confusion)}`;
        } else {
          expect(ml.length === 1 && !e.included && !e.recomputable && /cannot recompute/.test(e.reason), `members ${ml.join(',')}`);
          detail = `index only (no predictions or labels); marked not recomputable; recorded matrix kept`;
        }
      }
      bundles[mode] = buf;
      await p.click('Done', '.exportd button', true); await sleep(400);
      return { actual: `${listed ? 'every member matches the manifest' : ''}; ${detail}`, evidence: [s] };
    });
  }

  const importAs = async (user, mode) => {
    await signIn(user);
    const f = join(DL, `bundle-${mode}.zip`); writeFileSync(f, bundles[mode]);
    await p.click('Import', '.labbar button'); await p.click('Import a bundle file…', '[role=menuitem]');
    await p.waitFor('!!document.querySelector(".importd")', 10000, 'import dialog');
    await p.setFiles('.importd input[type=file]', [f]);
    await p.waitFor('!!document.querySelector("[data-ml-import]")', 60000, 'verification report');
    const line = await p.eval(`document.querySelector('[data-ml-import]').innerText`), code = await p.eval(`document.querySelector('[data-ml-import]').dataset.mlImport`);
    const s1 = await shot(`import-report-${mode}`);
    await p.click('Import experiment', '.importd button'); await sleep(5000);
    await p.eval(`location.hash = '#/methods/${cid}'`); await sleep(4000);
    await p.click('ML evaluation', '.tabs button', true); await sleep(3000);
    const card = await p.eval(`(() => { const c = [...document.querySelectorAll('.ml-card')].find((x) => /Example: scored pair filter/.test(x.querySelector('h4')?.textContent ?? '')); if (!c) return null;
      const m = {}; for (const k of ['tp', 'fn', 'fp', 'tn']) m[k] = Number(c.querySelector('td[data-cell=' + k + '] b')?.textContent.replace(/[^0-9]/g, '') ?? -1);
      return { text: c.innerText, m, slider: !!c.querySelector('input[type=range]') }; })()`);
    const s2 = await shot(`ml-tab-${mode}`);
    return { line, code, card, evidence: [s1, s2] };
  };

  await check('import-full', 'researcher2 imports the "Include the evidence" bundle: the report says re-validated and recomputed; the ML tab shows the same matrix and a working threshold.', async () => {
    const r = await importAs('researcher2', 'full');
    expect(r.code === '1/0' && /1 document re-validated, every figure recomputed and identical/.test(r.line), `report: ${r.line}`);
    expect(r.card && sameMatrix(r.card.m, KNOWN) && r.card.slider && /imported evidence/.test(r.card.text), `card ${JSON.stringify(r.card?.m)} slider ${r.card?.slider}`);
    const ev = (await api(`/api/lab/experiments/${cid}/evaluation?method_id=${LEARNED}&threshold=0.7`)).body.evaluations.find((x) => x.evidence_sha256 === evidenceSha);
    expect(ev && ev.exploratory && ev.origin === 'imported', 'exploratory threshold on the received evidence');
    return { actual: `report: "${r.line}"; ML tab matrix ${JSON.stringify(r.card.m)}; threshold control present; exploring 0.7 recomputes on the received evidence`, evidence: r.evidence };
  });

  await check('import-reference', 'administrator1 imports the "References only" bundle: the report says references only; the ML tab shows the recorded matrix marked not recomputable, without a threshold control.', async () => {
    const r = await importAs('administrator1', 'reference');
    expect(r.code === '0/1' && /1 reference only: figures as recorded by the exporter, not recomputable here/.test(r.line), `report: ${r.line}`);
    expect(r.card && sameMatrix(r.card.m, KNOWN) && !r.card.slider && /reference received with a bundle/.test(r.card.text) && /not recomputable here/.test(r.card.text), `card ${JSON.stringify(r.card?.m)} ${r.card?.text.slice(0, 200)}`);
    const dl = await api(`/api/lab/experiments/${cid}/evaluation/evidence/${evidenceSha}`);
    expect(dl.status === 404, `evidence download ${dl.status}`);
    return { actual: `report: "${r.line}"; ML tab: recorded matrix ${JSON.stringify(r.card.m)}, "reference received with a bundle", "not recomputable here", no threshold control; the evidence file is not on this account (404)`, evidence: r.evidence };
  });
} finally {
  if (p) await p.close();
  const pass = report.checks.filter((c) => c.status === 'PASS').length;
  report.summary = { pass, total: report.checks.length };
  writeFileSync(join(OUT, 'ml-export.json'), JSON.stringify(report, null, 1));
  console.log(`${pass}/${report.checks.length} checks passed`);
  process.exit(pass === report.checks.length ? 0 : 1);
}
