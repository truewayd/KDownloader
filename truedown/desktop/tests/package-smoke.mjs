import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const application = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2], "Pass the packaged native executable");
const virtualDisplay = process.argv[3] === "--virtual-display";
assert.ok(!process.argv[3] || virtualDisplay, "Unknown package acceptance option");
assert.ok(!virtualDisplay || (process.platform === "linux" && process.env.DISPLAY), "Virtual display acceptance requires Linux under xvfb-run");
const directory = path.dirname(application);
const cli = path.join(directory, process.platform === "win32" ? "truedown-cli.exe" : "truedown-cli");
const coreExecutable = path.join(directory, process.platform === "win32" ? "truedown-core.exe" : "truedown-core");
for (const executable of [application, coreExecutable, cli]) {
  assert.ok((await fs.lstat(executable)).isFile(), `Missing packaged executable: ${executable}`);
}
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-package-review-"));
const run = promisify(execFile);
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const port = await freePort(), debugPort = await freePort();
const env = { ...process.env, TRUEDOWN_ADDR: `127.0.0.1:${port}`,
  TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "" };
if (process.platform === "linux") env.GDK_BACKEND = "x11";
async function command(...args) {
  return run(cli, ["--data-dir", profile, ...args], { env, windowsHide: true, timeout: 15000 });
}
let diagnostic = "", browser;
function request(route, options = {}) {
  return fetch(`http://127.0.0.1:${port}${route}`, { ...options, signal: AbortSignal.timeout(5000) });
}
function appendDiagnostic(data) { diagnostic = (diagnostic + data).slice(-8192); }
function launch(executable, args) {
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", error => {
    if (!child.pid) child.launchError = error;
    appendDiagnostic(error);
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", appendDiagnostic);
  return child;
}
function exited(child) { return Boolean(child.launchError) || child.exitCode !== null || child.signalCode !== null; }
function assertRunning(child) {
  if (exited(child)) throw new Error(`Package process exited before readiness (${child.exitCode ?? child.signalCode ?? "spawn failed"}): ${diagnostic}`);
}
async function bounded(promise, timeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Native browser diagnostic timed out")), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function stop(child) {
  if (exited(child)) return;
  await command("exit").catch(() => {});
  await until(() => exited(child), 15000).catch(async () => {
    child.kill("SIGKILL");
    await until(() => exited(child), 5000);
  });
}
// Commit the profile using the packaged console entry before choosing the
// native health path. Read-only `paths` may still describe an unmigrated root.
const core = launch(coreExecutable, ["serve", "--data-dir", profile]);
let standaloneInfo;
try {
  await until(() => {
    assertRunning(core);
    return command("--json", "status").then(result => { standaloneInfo = JSON.parse(result.stdout).core; return true; }, () => false);
  });
  const startup = await request("/settings/startup");
  assert.equal(startup.status, 200);
  assert.equal((await startup.json()).supported, false, "The console core cannot own login startup");
  const response = await request("/settings/updates", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoUpdateTrueDown: false }),
  });
  assert.equal(response.status, 200);
  await command("exit");
  await until(() => exited(core), 30000);
  assert.equal(core.exitCode, 0, diagnostic);
} finally {
  await stop(core);
}
const location = JSON.parse((await command("--json", "paths")).stdout);
assert.equal(location.layoutVersion, 1, "The core must commit the profile before native startup");
assert.deepEqual(standaloneInfo, location.build, "Packaged console core and CLI must match");
if (process.env.TRUEDOWN_BUILD_NUMBER) assert.equal(location.build.buildNumber, process.env.TRUEDOWN_BUILD_NUMBER);
if (process.env.TRUEDOWN_COMMIT) assert.equal(location.build.commit, process.env.TRUEDOWN_COMMIT);
const updates = path.join(location.paths.state, "updates");
await fs.mkdir(updates, { recursive: true });
const token = randomBytes(24).toString("hex"), health = path.join(updates, `native-health-${token}`);
Object.assign(env, { TRUEDOWN_UPDATE_HEALTH_FILE: health, TRUEDOWN_UPDATE_HEALTH_TOKEN: token,
  TRUEDOWN_UPDATE_EXPECTED_BUILD: location.build.buildNumber });
if (process.platform === "win32") env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${debugPort}`;
// WebKitGTK may defer loading an unmapped view. Linux exercises ordinary
// frontend startup inside Xvfb; Windows exercises the actual hidden update
// startup. Neither mode presents a window on the user's desktop.
diagnostic = "";
const child = launch(application, [...(virtualDisplay ? [] : ["--background"]), "--data-dir", profile]);
async function until(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Native package acceptance timed out: ${diagnostic}`);
}
try {
  if (process.platform === "win32") {
    await until(() => {
      assertRunning(child);
      return fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(5000) }).then(response => response.ok, () => false);
    });
    const { chromium } = await import("playwright");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 15000 });
    for (const page of browser.contexts()[0].pages()) {
      page.on("pageerror", appendDiagnostic);
      page.on("console", message => { if (message.type() === "error") appendDiagnostic(message.text()); });
    }
  }
  await until(async () => {
    assertRunning(child);
    return fs.readFile(health, "utf8").then(value => value === token, () => false);
  });
  const identity = await request("/system/info");
  assert.equal(identity.status, 200);
  const info = await identity.json();
  assert.deepEqual(info, location.build);
  assert.deepEqual(JSON.parse((await command("--json", "status")).stdout).core, info);
  if (browser) {
    const page = browser.contexts()[0].pages()[0];
    assert.equal(await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().isVisible()), false);
  }
  await command("exit");
  await until(() => exited(child), 30000);
  assert.equal(child.exitCode, 0, diagnostic);
  console.log(`native_package_ready=ok matched_shell_core_cli=ok graceful_exit=ok display=${virtualDisplay ? "virtual" : "hidden"} profile=${profile}`);
} catch (error) {
  if (browser) {
    for (const page of browser.contexts()[0].pages()) {
      console.error("Native page diagnostics:", await bounded(page.evaluate(() => ({ url: location.href, text: document.body?.innerText.slice(-4000) })), 3000).catch(() => null));
    }
  }
  throw error;
} finally {
  try { await stop(child); }
  finally { if (browser) await bounded(browser.close(), 5000).catch(() => {}); }
}
