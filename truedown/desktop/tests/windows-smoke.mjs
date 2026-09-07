import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

if (process.platform !== "win32") throw new Error("This acceptance test requires Windows WebView2");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.argv[2] || path.join(desktop, "target/debug"));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-window-review-"));
const installation = path.join(fixture, "Application with spaces");
const profile = path.join(fixture, "Profile with spaces");
await fs.mkdir(installation);
for (const name of ["truedown-desktop.exe", "truedown-core.exe", "truedown-cli.exe", "aria2c.exe"]) {
  await fs.copyFile(path.join(source, name), path.join(installation, name));
}
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function waitUntil(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Native acceptance test timed out");
}
const port = await freePort(), debugPort = await freePort();
const child = spawn(path.join(installation, "truedown-desktop.exe"), ["--background", "--data-dir", profile], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env, TRUEDOWN_DESKTOP_TEST: "1", TRUEDOWN_ADDR: `127.0.0.1:${port}`,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "",
  },
});
child.stdout.resume(); child.stderr.resume();
let browser, main;
const invoke = (page, command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
const api = async (page, method, route, body) => {
  const response = await invoke(page, "core_request", { request: { method, path: route, ...(body ? { body: JSON.stringify(body) } : {}) } });
  assert.equal(response.status, 200, response.body);
  return JSON.parse(response.body);
};
const errors = [];
try {
  await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error("Desktop exited before WebView readiness");
    return fetch(`http://127.0.0.1:${debugPort}/json/version`).then(response => response.ok, () => false);
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0];
  main = await waitUntil(() => context.pages()[0]);
  const observe = page => {
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
  };
  context.pages().forEach(observe); context.on("page", observe);
  await main.waitForFunction(() => window.__TAURI__ && document.querySelector("#task-count"));
  await api(main, "GET", "/system/info");
  assert.equal(await main.evaluate(() => window.__TRUEDOWN_PLATFORM__), "windows");
  await main.locator('[data-route="settings"]').click();
  const settings = await waitUntil(() => context.pages().find(page => page.url().includes("window=settings")));
  for (const kind of ["logs", "about", "settings"]) await invoke(main, "open_auxiliary", { kind });
  await waitUntil(() => context.pages().length === 4);
  const logs = await waitUntil(() => context.pages().find(page => page.url().includes("window=logs")));
  const about = await waitUntil(() => context.pages().find(page => page.url().endsWith("about.html")));
  const storage = await api(main, "GET", "/system/storage");
  assert.equal(storage.layoutVersion, 1);
  assert.equal(storage.paths.cache.toLowerCase(), path.join(profile, "cache").toLowerCase());
  await fs.access(path.join(storage.paths.cache, "webview", "EBWebView"));
  assert.equal((await fs.readdir(installation)).some(name => name.includes("WebView")), false);
  await logs.waitForFunction(() => document.querySelector("#application-log-output").textContent.includes("starting"));
  await about.waitForFunction(() => document.querySelector("#version").textContent.includes("build"));
  assert.equal(new URL(main.url()).hash, "");
  await settings.locator('[data-settings-link="general"]').click();
  await settings.waitForFunction(() => !document.querySelector('[data-settings-page="general"]').inert);
  await settings.locator("#cfg-conns").fill("8");
  await settings.locator("#settings-save-btn").click();
  await settings.waitForFunction(() => document.querySelector("#settings-save-status").textContent === "本页设置已保存。");
  assert.equal((await api(main, "GET", "/settings/task-defaults")).values.connections, 8);
  await settings.locator("#cfg-conns").fill("7");
  await invoke(settings, "close_auxiliary");
  await invoke(main, "open_auxiliary", { kind: "settings" });
  assert.equal(await settings.locator("#cfg-conns").inputValue(), "7");
  assert.equal(context.pages().length, 4);
  await assert.rejects(invoke(about, "core_request", { request: { method: "POST", path: "/settings/runtime", body: "{}" } }));
  await assert.rejects(invoke(logs, "copy_api_token"));
  const auth = await api(settings, "POST", "/auth/settings", { enabled: true });
  assert.equal(auth.enabled, true);
  assert.equal(Object.hasOwn(auth, "token"), false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/tasks?limit=1`)).status, 401);
  assert.equal((await api(main, "GET", "/system/info")).product, "TrueDown");
  const session = await context.newCDPSession(settings);
  for (const [width, height, deviceScaleFactor] of [[640, 480, 1.25], [1020, 760, 2], [1280, 900, 3]]) {
    await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
    const layout = await settings.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, footer: document.querySelector(".settings-footer").getBoundingClientRect().bottom, height: innerHeight }));
    assert.equal(layout.overflow, false);
    assert.ok(layout.footer <= layout.height);
  }
  await settings.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await settings.screenshot({ path: path.join(fixture, "settings-dark.png") });
  await settings.emulateMedia({ colorScheme: "light", forcedColors: "active" });
  await settings.waitForFunction(() => document.documentElement.dataset.material === "solid");
  const windows = await main.evaluate(async () => Promise.all((await window.__TAURI__.window.getAllWindows()).map(async window => ({ label: window.label, visible: await window.isVisible() }))));
  assert.equal(windows.length, 4);
  assert.ok(windows.every(window => !window.visible), "Acceptance tests must never show native windows");
  assert.deepEqual(errors, []);
  console.log("native_windows=ok shared_cache=ok shared_settings=ok retained_drafts=ok private_auth=ok scale_layout=ok all_windows_hidden=ok");
} finally {
  if (main && child.exitCode === null) await invoke(main, "core_request", { request: { method: "POST", path: "/system/exit" } }).catch(() => {});
  await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 20000).catch(() => child.kill());
  await browser?.close().catch(() => {});
  console.log(`fixture=${fixture}`);
}
assert.equal(child.exitCode, 0);
