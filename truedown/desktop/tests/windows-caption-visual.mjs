// Explicit, interactive acceptance for DWM composition; regular CI stays hidden.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

assert.equal(process.platform, "win32", "Native visual acceptance requires Windows");
assert.equal(process.argv[2], "--visible", "Visible native acceptance requires --visible");
assert.ok(process.argv.length <= 4, "Unexpected visual acceptance arguments");
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.argv[3] || path.join(desktop, "target/debug"));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-caption-visual-"));
for (const name of ["TrueDown.exe", "truedown-core.exe", "truedown-cli.exe", "aria2c.exe"]) await fs.copyFile(path.join(source, name), path.join(fixture, name));
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const apiPort = await port(), debugPort = await port();
const child = spawn(path.join(fixture, "TrueDown.exe"), ["--data-dir", path.join(fixture, "profile")], {
  windowsHide: true, stdio: "ignore", env: { ...process.env,
    TRUEDOWN_DESKTOP_TEST: "0", TRUEDOWN_ADDR: `127.0.0.1:${apiPort}`,
    TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "",
    TRUEDOWN_DESKTOP_TEST_DEBUG_PORT: String(debugPort),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "",
  },
});
let browser, launchError;
child.on("error", error => { launchError = error; });
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    assert.ok(child.exitCode === null && child.signalCode === null, "Desktop exited during visual acceptance");
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Visual acceptance readiness timed out");
}
const invoke = (page, command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
function powershell(script, args) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(desktop, "tests", script), "-ProcessId", String(child.pid), ...args],
  { windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
}
const readWindows = () => JSON.parse(powershell("windows-native-state.ps1", []));
try {
  await until(() => fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2500) }).then(r => r.ok, () => false), 90000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0], main = context.pages()[0];
  const evidence = {};
  for (const kind of ["main", "settings", "new-task", "batch-task"]) {
    if (kind !== "main") await invoke(main, "open_auxiliary", { kind });
    const page = kind === "main" ? main : await until(() => context.pages().find(page => page.url().includes(`window=${kind}`)));
    // Playwright otherwise injects its default light theme into attached views.
    // Null explicitly restores the WebView's real operating-system preference.
    await page.emulateMedia({ colorScheme: null });
    await until(() => page.evaluate(() => Boolean(window.__TAURI__?.core && document.querySelector(".native-titlebar"))).catch(() => false));
    const dark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
    const windows = await main.evaluate(async () => Promise.all((await window.__TAURI__.window.getAllWindows()).map(async window => ({ label: window.label, title: await window.title() }))));
    const title = windows.find(window => window.label === kind).title;
    const state = await until(() => readWindows().find(window => window.title === title && window.visible && Boolean(window.dark) === dark));
    assert.equal(state.clientTopInset, 0);
    assert.deepEqual(state.captionHits, [8, 9, 20]);
    const output = path.join(fixture, `${kind}-system-theme.png`);
    const capture = powershell("windows-visual-window.ps1", ["-WindowHandle", state.handle, "-OutputPath", output]);
    assert.match(capture, /native_caption_glyphs=ok/);
    evidence[kind] = { dark, state, output };
    console.log(`${kind}: native caption glyphs and system theme OK`);
  }
  await fs.writeFile(path.join(fixture, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Screenshots: ${fixture}`);
} finally {
  await fetch(`http://127.0.0.1:${apiPort}/system/exit`, { method: "POST", signal: AbortSignal.timeout(2500) }).catch(() => {});
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
    const timer = setTimeout(finish, 10000);
    function finish() { clearTimeout(timer); child.off("exit", finish); resolve(); }
    child.once("exit", finish);
  });
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
