// First-run setup in a real browser, on an installation that has no account yet (Linux, macOS, Windows):
//   node scripts/e2e/first_run.mjs --python <folder>/venv/bin/python --config <folder>/move-openlab.json --out <dir>
// Opens the link the launcher opens (`move-openlab setup-link`: the setup key travels in the #fragment), checks the
// "Welcome to MOVE OpenLab" page (key filled in and hidden, French text, password meter, mismatch refused), creates
// the administrator through the form and checks that the Workspace opens. Screenshots of the genuine pages are
// written to <out>. The generated password is written only to <out>/admin.json (mode 0600) for the next checks of
// the same run, never printed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const PY = arg('python'), CONFIG = arg('config'), OUT = arg('out');
const CHROME = process.env.CHROME || 'chromium';
if (!PY || !CONFIG || !OUT) { console.error('usage: first_run.mjs --python P --config C --out DIR'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const link = execFileSync(PY, ['-m', 'move_openlab.cli', 'setup-link', '--config', CONFIG], { encoding: 'utf8' }).trim();
const base = link.slice(0, link.indexOf('/setup#'));
const checks = [];
const ok = (id, what, cond, detail = '') => { checks.push({ id, what, ok: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${id} ${what}${detail ? ' — ' + detail : ''}`); };

const p = await launch(CHROME, { width: 1280, height: 900 });
try {
  await p.goto(base + '/');                                       // no account yet: every page leads to the setup
  await p.waitFor('location.pathname === "/setup"', 15000, 'redirect to /setup');
  const keyField = await p.eval('!document.getElementById("keybox").hidden');
  ok('F1', 'without the link, the page asks for the setup key', keyField);
  await p.goto('about:blank');                                   // as the launcher does: a new page on the link
  await p.goto(link);
  await p.waitFor('document.getElementById("keybox").hidden === true', 10000, 'key filled from the link');
  const page = await p.eval('({ h: document.querySelector("h1").innerText, url: location.href, key: document.querySelector("input[name=setup_key]").value.length })');
  ok('F2', 'setup link: key filled in and hidden, removed from the address bar', page.h === 'Welcome to MOVE OpenLab' && page.key >= 32 && !page.url.includes('#'), `${page.h}; ${page.url}`);
  await p.shot(join(OUT, 'first-run-welcome.png'));
  const pw = `Mo-${randomBytes(12).toString('base64url')}-9a`;
  await p.fill('input[name=username]', 'admin1');
  await p.fill('input[name=display_name]', 'Administrator One');
  await p.fill('input[name=new_password]', pw);
  await p.fill('input[name=confirm_password]', pw + 'x');
  await sleep(600);
  const mismatch = await p.eval('document.getElementById("match").innerText');
  ok('F3', 'the form says when the two passwords differ', /do not match/.test(mismatch), mismatch);
  await p.fill('input[name=confirm_password]', pw);
  await sleep(600);
  const strength = await p.eval('document.getElementById("strength").className');
  ok('F4', 'the password meter rates the chosen password', /strong|acceptable/.test(strength), strength);
  await p.shot(join(OUT, 'first-run-filled.png'));
  await p.eval('document.querySelector("form[action=\\"/api/setup/admin\\"] button[type=submit]").click()');
  await p.waitFor('location.pathname === "/" && !!document.querySelector("#root, .app, header")', 30000, 'Workspace');
  await sleep(4000);
  const me = await p.eval('fetch("/api/auth/me").then((r) => r.json())');
  ok('F5', 'the administrator is created, signed in, and the Workspace opens', me.user?.username === 'admin1' && me.user?.role === 'admin' && !me.user?.must_change_password, JSON.stringify(me.user));
  await p.shot(join(OUT, 'first-run-workspace.png'));
  await p.goto(base + '/setup');
  await p.waitFor('location.pathname !== "/setup"', 10000, 'setup closed');
  ok('F6', 'the setup page is closed for good', true, await p.eval('location.pathname'));
  writeFileSync(join(OUT, 'admin.json'), JSON.stringify({ username: 'admin1', password: pw }), { mode: 0o600 });
  ok('F7', 'no page error', p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
} catch (e) {
  ok('F0', 'browser run', false, String(e).slice(0, 300));
} finally {
  await p.close();
}
writeFileSync(join(OUT, 'first-run.json'), JSON.stringify({ base, checks }, null, 1));
const passed = checks.filter((c) => c.ok).length;
console.log(`${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
