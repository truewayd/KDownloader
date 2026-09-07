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
// Commit the profile using the packaged console entry before choosing the
// native health path. Read-only `paths` may still describe an unmigrated root.
const core = spawn(path.join(directory, process.platform === "win32" ? "truedown-core.exe" : "truedown-core"),
  ["serve", "--data-dir", profile], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
for (const stream of [core.stdout, core.stderr]) stream.on("data", data => { diagnostic = (diagnostic + data).slice(-8192); });
try {
  await until(() => command("--json", "status").then(() => true, () => false));
  const response = await fetch(`http://127.0.0.1:${port}/settings/updates`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoUpdateTrueDown: false }),
  });
  assert.equal(response.status, 200);
  await command("exit");
  await until(() => core.exitCode !== null, 30000);
  assert.equal(core.exitCode, 0, diagnostic);
} finally {
  if (core.exitCode === null) {
    await command("exit").catch(() => {});
    await until(() => core.exitCode !== null, 15000).catch(() => core.kill());
  }
}
const location = JSON.parse((await command("--json", "paths")).stdout);
assert.equal(location.layoutVersion, 1, "The core must commit the profile before native startup");
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
const child = spawn(application, [...(virtualDisplay ? [] : ["--background"]), "--data-dir", profile], {
  env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
diagnostic = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { diagnostic = (diagnostic + data).slice(-8192); });
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
    await until(() => fetch(`http://127.0.0.1:${debugPort}/json/version`).then(response => response.ok, () => false));
    const { chromium } = await import("playwright");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    for (const page of browser.contexts()[0].pages()) {
      page.on("pageerror", error => { diagnostic += String(error); });
      page.on("console", message => { if (message.type() === "error") diagnostic += message.text(); });
    }
  }
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Native package exited before readiness: ${diagnostic}`);
    return fs.readFile(health, "utf8").then(value => value === token, () => false);
  });
  const info = await fetch(`http://127.0.0.1:${port}/system/info`).then(response => response.json());
  assert.deepEqual(info, location.build);
  await command("--json", "status");
  if (browser) {
    const page = browser.contexts()[0].pages()[0];
    assert.equal(await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().isVisible()), false);
  }
  await command("exit");
  await until(() => child.exitCode !== null, 30000);
  assert.equal(child.exitCode, 0, diagnostic);
  console.log(`native_package_ready=ok matched_shell_core_cli=ok graceful_exit=ok display=${virtualDisplay ? "virtual" : "hidden"} profile=${profile}`);
} catch (error) {
  if (browser) {
    for (const page of browser.contexts()[0].pages()) {
      console.error("Native page diagnostics:", await page.evaluate(() => ({ url: location.href, text: document.body?.innerText.slice(-4000) })).catch(() => null));
    }
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    await command("exit").catch(() => {});
    await until(() => child.exitCode !== null, 15000).catch(() => child.kill());
  }
}
