// Minimal Chrome DevTools Protocol driver for the browser end-to-end checks — Node 22+ only (built-in WebSocket),
// no npm dependency. Starts a headless Chromium, drives one page with real mouse and keyboard events, captures
// screenshots, and collects page errors. Used by scripts/e2e/acceptance.mjs.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(chrome, { width = 1440, height = 900 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'move-openlab-e2e-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chromium did not start')), 30000);
    proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    proc.on('exit', (c) => reject(new Error(`Chromium exited (${c})`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); }
    else listeners.forEach((f) => f(m));
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable'); await s('Log.enable'); await s('DOM.enable');
  const errors = [], network = [], dialogs = [], downloads = new Map();
  listeners.add((m) => {
    if (m.method === 'Browser.downloadProgress' && m.params.state !== 'inProgress') downloads.set(m.params.guid, m.params.state);
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    // browser-level messages: CSP violations, blocked resources ... (HTTP error statuses are kept apart: some are expected)
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') (m.params.entry.source === 'network' ? network : errors).push(`${m.params.entry.source}: ${m.params.entry.text} ${m.params.entry.url ?? ''}`.trim());
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); s('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }
  });
  const page = {
    errors, network, dialogs,
    /** Save downloads into `dir`. Take `downloadCount()` before the click, then `waitDownload(count)`. */
    async allowDownloads(dir) { await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true }); },
    downloadCount: () => downloads.size,
    async waitDownload(count, timeout = 30000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (downloads.size > count) { const st = [...downloads.values()].at(-1); if (st !== 'completed') throw new Error(`download ${st}`); return true; }
        await sleep(150);
      }
      throw new Error('no download finished');
    },
    /** Put files into an <input type=file> (hidden ones too) and fire its change event, as a person choosing them would. */
    async setFiles(css, files) {
      const { root } = await s('DOM.getDocument', { depth: 1 });
      const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: css });
      if (!nodeId) throw new Error(`no file input ${css}`);
      await s('DOM.setFileInputFiles', { nodeId, files });
    },
    /** Focus a field, clear it with the keyboard (End, then Backspace — works for every input type) and type. */
    async fill(css, text) {
      const len = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) throw new Error('no field ${css.replace(/'/g, '')}'); e.focus(); return String(e.value ?? '').length; })()`);
      await page.key('End', 'End', 35);
      for (let i = 0; i < len; i++) await page.key('Backspace', 'Backspace', 8);
      await s('Input.insertText', { text });
    },
    async size(width, height, dsf = 1, mobile = false) { await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile }); },
    async goto(url) {
      const loaded = new Promise((r) => { const f = (m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { listeners.delete(f); r(); } }; listeners.add(f); });
      await s('Page.navigate', { url }); await Promise.race([loaded, sleep(20000)]);
    },
    async eval(expr) {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, timeout = 20000, what = expr) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { try { if (await page.eval(expr)) return true; } catch { /* page changing */ } await sleep(150); }
      throw new Error(`timed out waiting for ${what}`);
    },
    /** Visible element whose text (or aria-label) contains `text`, optionally within a CSS scope: its centre point. */
    async find(text, scope = 'button, a, [role=menuitem], [role=option], label, summary, input, select', exact = false) {
      return page.eval(`(() => { const want = ${JSON.stringify(text)}; const ok = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
        const hit = Array.from(document.querySelectorAll(${JSON.stringify(scope)})).filter(ok).find((e) => { const t = (e.textContent || '').replace(/\\s+/g, ' ').trim(), a = e.getAttribute('aria-label') || '';
          return ${exact ? 't === want || a === want' : 't.includes(want) || a.includes(want)'}; });
        if (!hit) return null; hit.scrollIntoView({ block: 'center', inline: 'center' }); const r = hit.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!hit.disabled }; })()`);
    },
    /** Move the mouse only (hover: tooltips, :hover styles). */
    async hover(x, y) { await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); },
    async clickAt(x, y) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    },
    async click(text, scope, exact) {
      let p = null;
      for (let i = 0; i < 60 && !p; i++) { p = await page.find(text, scope, exact); if (!p) await sleep(150); }
      if (!p) throw new Error(`nothing to click: ${text}`);
      if (p.disabled) throw new Error(`disabled: ${text}`);
      await page.clickAt(p.x, p.y); await sleep(120);
    },
    async focusCss(css) { await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); e.focus(); if (e.select) e.select(); return true; })()`); },
    async type(text) { await s('Input.insertText', { text }); },
    async key(key, code = key, vk = { Enter: 13, Escape: 27, Tab: 9 }[key] ?? 0) {
      const text = { Enter: '\r', ' ': ' ' }[key];          // a character key must carry its text to activate buttons
      await s('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
      await s('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    },
    async shot(path, format = 'png') { const r = await s('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 85 } : {}) }); writeFileSync(path, Buffer.from(r.data, 'base64')); },
    async media(features) { await s('Emulation.setEmulatedMedia', { features }); },
    async clearCookies() { await s('Network.clearBrowserCookies'); },
    async close() { try { ws.close(); } catch { /* */ } proc.kill('SIGTERM'); await sleep(300); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
  };
  return page;
}
