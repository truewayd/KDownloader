// Interactive desktop required; never part of the default hidden Windows suite.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { acceptNativeEditing, nativeEditingDocumentReady } from './native-editing.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.argv[2], '--visible', 'Editing acceptance requires explicit --visible (uses the system clipboard)');
assert.ok(process.argv.length <= 4);
const source = path.resolve(process.argv[3] || 'target/debug');
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'truedown-editing-')));
const profile = path.join(fixture, 'profile');
for (const name of ['TrueDown.exe', 'truedown-core.exe', 'truedown-cli.exe', 'aria2c.exe']) {
  // The update fixture rebuilds these debug binaries with a new build identity.
  // TrueDown.exe in target/debug is an earlier renamed copy, not cargo's output.
  await fs.copyFile(path.join(source, name === 'TrueDown.exe' ? 'truedown-desktop.exe' : name), path.join(fixture, name));
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const apiPort = await freePort(), debugPort = await freePort();
const child = spawn(path.join(fixture, 'TrueDown.exe'), ['--data-dir', profile], {
  windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env,
    TRUEDOWN_DESKTOP_TEST: '', TRUEDOWN_ADDR: `127.0.0.1:${apiPort}`,
    TRUEDOWN_DESKTOP_TEST_DEBUG_PORT: String(debugPort), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '',
    TRUEDOWN_API_TOKEN: '', TRUEDOWN_REQUIRE_TOKEN: '', TRUEDOWN_TLS_CERT: '', TRUEDOWN_TLS_KEY: '',
    TRUEDOWN_UPDATE_HEALTH_FILE: '', TRUEDOWN_UPDATE_HEALTH_TOKEN: '', TRUEDOWN_UPDATE_EXPECTED_BUILD: '',
  },
});
let browser, launchError;
let diagnostic = '';
child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
child.on('error', error => { launchError = error; });
const end = Date.now() + 120000;
async function bounded(operation, milliseconds = 10000, deadline = end) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native editing deadline exceeded')), Math.max(1, Math.min(milliseconds, deadline - Date.now())));
    })]);
  } finally { clearTimeout(timer); }
}
async function until(check, milliseconds = 30000) {
  const deadline = Math.min(end, Date.now() + milliseconds);
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, `Desktop exited: ${diagnostic}`);
    const result = await bounded(check(), deadline - Date.now());
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Native editing readiness timed out');
}
const request = (route, options = {}) => fetch(`http://127.0.0.1:${apiPort}${route}`, { ...options, signal: AbortSignal.timeout(3000) });
try {
  await until(() => fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false), 60000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 10000 });
  let page = browser.contexts()[0].pages()[0];
  await bounded(page.emulateMedia({ colorScheme: null }));
  const evaluate = script => bounded(page.evaluate(`(async()=>{${script}})()`));
  await until(() => nativeEditingDocumentReady(evaluate));
  await evaluate("return window.__TAURI__.core.invoke('open_auxiliary',{kind:'settings'})");
  page = await until(() => browser.contexts()[0].pages().find(candidate => candidate.url().includes('window=settings')));
  await page.emulateMedia({ colorScheme: null });
  await until(() => nativeEditingDocumentReady(evaluate));
  await until(() => evaluate("return typeof settingsReady !== 'undefined' && settingsReady.has('general')"));
  await page.locator('#cfg-folder').click();
  await acceptNativeEditing(evaluate, until, async action => {
    const menu = await until(() => browser.contexts()[0].pages().find(candidate => candidate.url().endsWith('context-menu-window.html')))
      .catch(async error => { throw new Error(`${action}: ${error.message}; ${diagnostic}; ${JSON.stringify(await evaluate('return window.__nativeEditing.debug()'))}`); });
    await menu.emulateMedia({ colorScheme: null });
    await menu.locator(`[data-action="${action}"]`).click()
      .catch(async error => { throw new Error(`${action}: ${error.message}; ${diagnostic}; ${JSON.stringify(await evaluate('return window.__nativeEditing.debug()'))}`); });
    await until(() => !browser.contexts()[0].pages().includes(menu));
  });
  console.log('windows_native_editing=ok clipboard_round_trip=ok editor_actions=ok');
} finally {
  // Check profile identity before asking a possibly recycled port to exit.
  try {
    const storage = await request('/system/storage');
    if (storage.ok && await fs.realpath((await storage.json()).dataDirectory) === await fs.realpath(profile)) {
      await request('/system/exit', { method: 'POST' });
    }
  } catch {}
  await bounded(browser?.close(), 5000, Infinity).catch(() => {});
  if (child.exitCode === null) await new Promise(resolve => {
    const timer = setTimeout(done, 5000);
    function done() { clearTimeout(timer); child.off('exit', done); resolve(); }
    child.once('exit', done);
  });
  if (child.exitCode === null) child.kill();
}
