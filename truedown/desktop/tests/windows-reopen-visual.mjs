// Explicit visible compositor acceptance. Uses an isolated profile and keeps
// raw screen frames; ordinary native CI remains hidden.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

assert.equal(process.platform, "win32");
assert.equal(process.argv[2], "--visible", "Requires explicit --visible opt-in");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const layoutOnly = process.argv.includes("--layout-only");
const source = path.resolve((process.argv[3]?.startsWith("--") ? null : process.argv[3]) || path.join(desktop, "target/debug"));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-reopen-visual-"));
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
    TRUEDOWN_DESKTOP_TEST_DEBUG_PORT: String(debugPort), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "",
  },
});
let browser, launchError;
child.on("error", error => { launchError = error; });
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, "Desktop exited");
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error("Reopen acceptance timed out");
}
const invoke = (page, command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
const readWindows = (visibilityOnly = false) => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(desktop, "tests/windows-native-state.ps1"), "-ProcessId", String(child.pid), ...(visibilityOnly ? ["-VisibilityOnly"] : [])], { windowsHide: true, encoding: "utf8", timeout: 15000 }));
async function record(handle, label, action) {
  const output = path.join(fixture, label);
  const recorder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(desktop, "tests/windows-transition-capture.ps1"), "-ProcessId", String(child.pid), "-WindowHandle", handle, "-OutputDirectory", output], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  recorder.stdout.on("data", bytes => { stdout += bytes; });
  recorder.stderr.on("data", bytes => { stderr += bytes; });
  const finished = new Promise((resolve, reject) => {
    recorder.on("error", reject);
    recorder.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `Capture exit ${code}`)));
  });
  finished.catch(() => {}); // Keep startup/action failures from orphaning a rejection.
  try {
    await until(() => { if (recorder.exitCode !== null && !stdout.includes("ready")) throw new Error(stderr); return stdout.includes("ready"); });
    const start = performance.now();
    await action();
    const elapsed = performance.now() - start;
    await Promise.race([finished, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Capture timeout")), 10000); timer.unref(); })]);
    return { elapsed, output };
  } finally { if (recorder.exitCode === null) recorder.kill(); }
}
try {
  await until(() => fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false), 90000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0], main = context.pages()[0];
  await until(() => main.evaluate(() => Boolean(window.__TAURI__?.core)).catch(() => false));
  const created = await fetch(`http://127.0.0.1:${apiPort}/start-headless-download`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ downloadSource: { type: "http", link: "https://example.invalid/retained-task.bin" }, name: "retained-task.bin", folder: path.join(fixture, "downloads"), startDownload: false }),
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(created.ok);
  const taskID = Number((await created.text()).match(/^OK (\d+)$/)?.[1]);
  assert.ok(taskID > 0);
  const evidence = {};
  for (const kind of layoutOnly ? ["task-details"] : ["settings", "new-task", "task-details"]) {
    const open = () => kind === "task-details" ? invoke(main, "open_task_details", { id: taskID }) : invoke(main, "open_auxiliary", { kind });
    await open();
    await until(() => context.pages().some(page => page.url().includes(`window=${kind}`)));
    const page = context.pages().find(page => page.url().includes(`window=${kind}`));
    await until(() => page.evaluate(() => Boolean(window.__TAURI__?.core)).catch(() => false));
    if (kind === "task-details") await until(() => page.evaluate(() => document.querySelector("#task-detail-title")?.textContent === "retained-task.bin"));
    await page.evaluate(() => { window.__reopenSentinel = crypto.randomUUID(); });
    const sentinel = await page.evaluate(() => window.__reopenSentinel);
    if (kind === "new-task") await page.locator("#m-link").fill("https://example.invalid/retained-draft");
    const title = await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().title());
    let initial;
    await until(() => readWindows(true).some(window => window.title === title && window.visible));
    initial = readWindows().find(window => window.title === title && window.visible);
    assert.ok(initial, `Missing ${kind}`);
    evidence[kind] = [];
    if (kind === "task-details") {
      const layout = await page.evaluate(() => {
        const panel = document.querySelector(".task-detail-page").getBoundingClientRect();
        return { left: panel.left, right: innerWidth - panel.right };
      });
      assert.ok(Math.abs(layout.left - 8) <= 1 && Math.abs(layout.right - 8) <= 1, "Native task details must not reserve a hidden sidebar");
      await page.screenshot({ path: path.join(fixture, "task-details-layout.png") });
      console.log(`native task-detail gutters=${JSON.stringify(layout)}`);
    }
    if (layoutOnly) { await invoke(page, "close_auxiliary"); continue; }
    for (let attempt = 0; attempt < 3; attempt++) {
      const colorScheme = attempt === 0 ? "light" : "dark";
      console.log(`${kind}: ${colorScheme}, forced-colors=${attempt === 2 ? "active (isolated WebView emulation)" : "none"}`);
      await page.emulateMedia({ colorScheme, forcedColors: attempt === 2 ? "active" : "none" });
      assert.equal(await invoke(page, "apply_material", { enabled: attempt !== 2, dark: attempt !== 0 }), attempt !== 2);
      await until(() => page.evaluate(solid => document.documentElement.dataset.material === (solid ? "solid" : "native"), attempt === 2));
      initial = readWindows().find(window => window.title === title && window.visible);
      assert.equal(initial.dark, attempt === 0 ? 0 : 1);
      assert.equal(initial.backdrop, attempt === 2 ? 1 : 2);
      const size = initial.clientSize;
      const closed = await record(initial.handle, `${kind}-${attempt}-close`, () => invoke(page, "close_auxiliary"));
      await until(() => !readWindows(true).find(window => window.handle === initial.handle)?.visible, 5000);
      const result = await record(initial.handle, `${kind}-${attempt}`, open);
      let state;
      try {
        await until(() => readWindows(true).some(window => window.title === title && window.visible));
        state = readWindows().find(window => window.title === title && window.visible);
      } catch (error) { console.log({ title, windows: readWindows() }); throw error; }
      assert.equal(state.backdropResult, initial.backdropResult);
      assert.equal(state.backdrop, initial.backdrop, "Recreated HWND must retain its DWM backdrop");
      assert.equal(state.dark, initial.dark, "Recreated HWND must retain its DWM caption theme");
      assert.equal(state.captionExcludedFromWebView, true);
      assert.equal(state.taskbarIconMatchesWindow, true);
      assert.deepEqual(state.clientSize, size, "Reopening must not accumulate caption height");
      assert.equal(await page.evaluate(() => window.__reopenSentinel), sentinel, "WebView must not reload");
      if (kind === "new-task") assert.equal(await page.locator("#m-link").inputValue(), "https://example.invalid/retained-draft");
      evidence[kind].push({ ...result, closed, state, size });
      await fs.writeFile(path.join(fixture, "evidence.json"), JSON.stringify(evidence, null, 2));
      console.log(`${kind} reopen ${attempt}: ${result.elapsed.toFixed(1)}ms`);
      initial = state;
    }
    await page.emulateMedia({ colorScheme: "light", forcedColors: "none" });
    await invoke(page, "apply_material", { enabled: true, dark: false });
    await invoke(page, "close_auxiliary");
  }
  await fs.writeFile(path.join(fixture, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`Native acceptance evidence: ${fixture}`);
} finally {
  await fetch(`http://127.0.0.1:${apiPort}/system/exit`, { method: "POST", signal: AbortSignal.timeout(2500) }).catch(() => {});
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 }); } catch {}
  }
}
