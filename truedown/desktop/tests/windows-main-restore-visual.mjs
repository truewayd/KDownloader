// Explicit, isolated desktop capture of the same show_main path used by the tray.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

assert.equal(process.platform, "win32");
assert.equal(process.argv[2], "--visible", "Requires explicit visible acceptance");
const source = path.resolve(process.argv[3]);
const renewed = process.argv.includes("--renewed");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-main-restore-"));
for (const name of ["TrueDown.exe", "truedown-core.exe", "truedown-cli.exe", "aria2c.exe"]) await fs.copyFile(path.join(source, name), path.join(fixture, name));
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
async function until(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Main restore acceptance timed out");
}
const apiPort = await port(), debugPort = await port();
const env = { ...process.env, TRUEDOWN_DESKTOP_TEST: "0", TRUEDOWN_ADDR: `127.0.0.1:${apiPort}`,
  TRUEDOWN_DESKTOP_TEST_DEBUG_PORT: String(debugPort), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "",
  TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "" };
const executable = path.join(fixture, "TrueDown.exe"), args = ["--data-dir", path.join(fixture, "profile")];
const child = spawn(executable, args, { env, windowsHide: true, stdio: "ignore" });
let browser, main, launchError;
child.on("error", error => { launchError = error; });
const invoke = (command, args) => main.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
const readState = () => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(desktop, "tests/windows-native-state.ps1"), "-ProcessId", String(child.pid)], { windowsHide: true, encoding: "utf8", timeout: 15000 }));
try {
  await until(() => {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null);
    return fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false);
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  main = browser.contexts()[0].pages()[0];
  await until(() => main.evaluate(() => Boolean(document.documentElement.dataset.material && window.__TAURI__?.core)).catch(() => false));
  await main.evaluate(() => {
    window.__restoreSentinel = crypto.randomUUID();
    window.__restoreEvents = [];
    for (const type of ["focus", "blur", "resize", "pageshow", "pagehide"]) window.addEventListener(type, () => window.__restoreEvents.push({ type, time: Date.now(), width: innerWidth, height: innerHeight }));
    const original = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = async (command, args) => {
      const start = Date.now();
      const result = await original(command, args);
      if (command === "apply_material") window.__restoreEvents.push({ type: command, start, time: Date.now(), args, result });
      return result;
    };
  });
  const sentinel = await main.evaluate(() => window.__restoreSentinel);
  const title = await main.evaluate(() => window.__TAURI__.window.getCurrentWindow().title());
  await invoke("open_auxiliary", { kind: "new-task" });
  const driver = await until(() => browser.contexts()[0].pages().find(page => page.url().includes("window=new-task")));
  await driver.evaluate(() => window.__TAURI__.core.invoke("close_auxiliary"));
  const evidence = [];
  for (let trial = 0; trial < 3; trial++) {
    const initial = readState().find(state => state.title === title);
    assert.ok(initial?.visible);
    await invoke("frame_action", { action: "close" });
    const hidden = await until(() => {
      const state = readState().find(state => state.title === title);
      return state && !state.visible ? state : null;
    });
    await main.evaluate(() => { window.__restoreEvents.length = 0; });
    const output = path.join(fixture, `restore-${trial}`);
    const recorder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(desktop, "tests/windows-transition-capture.ps1"), "-ProcessId", String(child.pid), "-WindowHandle", initial.handle, "-OutputDirectory", output, "-FrameCount", "180"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    recorder.stdout.on("data", data => { stdout += data; });
    recorder.stderr.on("data", data => { stderr += data; });
    try {
      await until(() => { if (recorder.exitCode !== null) throw new Error(stderr); return stdout.includes("ready"); });
      const start = Date.now();
      // This existing native callback calls exactly the tray's show_main,
      // without adding another executable's startup time to the recording.
      await driver.evaluate(() => window.__TAURI__.core.invoke("finish_task_window"));
      await until(() => recorder.exitCode !== null, 10000);
      assert.equal(recorder.exitCode, 0, stderr);
      const state = await until(() => {
        const state = readState().find(state => state.title === title);
        return state?.visible ? state : null;
      });
      if (renewed) assert.notEqual(state.handle, initial.handle);
      else assert.equal(state.handle, initial.handle);
      assert.equal(await main.evaluate(() => window.__restoreSentinel), sentinel);
      evidence.push({ trial, start, initial, hidden, state, events: await main.evaluate(() => window.__restoreEvents), output });
      await fs.writeFile(path.join(fixture, "evidence.json"), JSON.stringify(evidence, null, 2));
      console.log(`restore ${trial}: ${output}`);
    } finally { if (recorder.exitCode === null) recorder.kill(); }
  }
} finally {
  if (main && child.exitCode === null) await invoke("core_request", { request: { method: "POST", path: "/system/exit" } }).catch(() => {});
  await until(() => child.exitCode !== null || child.signalCode !== null, 10000).catch(() => {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
  });
  await browser?.close().catch(() => {});
  console.log(`fixture=${fixture}`);
}
