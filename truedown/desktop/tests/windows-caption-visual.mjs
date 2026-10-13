// Explicit, interactive acceptance for DWM composition; regular CI stays hidden.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { chromium } from "playwright";

assert.equal(process.platform, "win32", "Native visual acceptance requires Windows");
assert.equal(process.argv[2], "--visible", "Visible native acceptance requires --visible");
assert.ok(process.argv.length <= 4, "Unexpected visual acceptance arguments");
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.argv[3] || path.join(desktop, "target/debug"));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-caption-visual-"));
// Cargo's output name differs from the packaged product name. Never silently
// select a stale packaged alias when validating the current development build.
const executable = path.join(source, process.argv[3] ? "TrueDown.exe" : "truedown-desktop.exe");
await fs.copyFile(executable, path.join(fixture, "TrueDown.exe"));
for (const name of ["truedown-core.exe", "truedown-cli.exe", "aria2c.exe"]) await fs.copyFile(path.join(source, name), path.join(fixture, name));
const build = { executable, sha256: createHash("sha256").update(await fs.readFile(executable)).digest("hex") };
console.log(`Validating ${build.executable} (${build.sha256})`);
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const apiPort = await port(), debugPort = await port();
// Keep helpers alive before showing the app: console startup can dismiss an
// otherwise correct tooltip, and compiling native queries slows each capture.
async function nativeWorker(script) {
  const worker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(desktop, "tests", script), "-Server"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  worker.stderr.resume();
  const lines = createInterface({ input: worker.stdout });
  let pending;
  const receive = () => new Promise((resolve, reject) => {
    assert.ok(!pending, "Native helper requests must be serial");
    const timer = setTimeout(() => { pending = undefined; worker.kill(); reject(new Error("Native helper timed out")); }, 15000);
    pending = { resolve: value => { clearTimeout(timer); pending = undefined; resolve(value); },
      reject: error => { clearTimeout(timer); pending = undefined; reject(error); } };
  });
  lines.on("line", line => pending?.resolve(line));
  worker.on("error", error => pending?.reject(error));
  worker.on("exit", () => pending?.reject(new Error("Native helper exited")));
  const close = () => { worker.stdin.end(); lines.close(); worker.kill(); };
  try { assert.equal(await receive(), "ready"); }
  catch (error) { close(); throw error; }
  return {
    async request(payload) {
      const response = receive();
      worker.stdin.write(JSON.stringify(payload) + "\n");
      const result = JSON.parse(await response);
      if (result.error) throw new Error(result.error);
      return result;
    }, close,
  };
}
const stateWorker = await nativeWorker("windows-native-state.ps1");
let captureWorker, glyphWorker;
try {
  captureWorker = await nativeWorker("windows-popup-capture.ps1");
  glyphWorker = await nativeWorker("windows-visual-window.ps1");
} catch (error) { stateWorker.close(); captureWorker?.close(); throw error; }
const child = spawn(path.join(fixture, "TrueDown.exe"), ["--data-dir", path.join(fixture, "profile")], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
    TRUEDOWN_DESKTOP_TEST: "0", TRUEDOWN_ADDR: `127.0.0.1:${apiPort}`,
    TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "",
    TRUEDOWN_DESKTOP_TEST_DEBUG_PORT: String(debugPort),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "",
  },
});
let stderr = "";
child.stdout.resume();
child.stderr.on("data", value => { stderr = (stderr + value).slice(-32768); });
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
const readWindows = () => stateWorker.request({ processId: child.pid });
const capture = args => captureWorker.request({ processId: child.pid, ...args });
async function acceptTooltip(page, kind, phase, scheme, readOwner, deactivate) {
  await page.emulateMedia({ colorScheme: scheme });
  await until(async () => Boolean((await readOwner())?.dark) === (scheme === "dark"));
  await deactivate();
  await until(async () => (await readOwner())?.foreground === false);
  await until(() => page.evaluate(() => document.documentElement.dataset.nativeTooltip === "true"));
  const anchor = kind === "main" ? "#open-downloads-btn" : "#caption-tooltip-fixture";
  await page.evaluate(kind => {
    if (kind === "main") return;
    const button = document.createElement("button");
    button.id = "caption-tooltip-fixture";
    button.textContent = "Tooltip fixture";
    button.dataset.tooltip = "Title bar tooltip overlay";
    button.style.cssText = "position:fixed;right:16px;top:60px;z-index:100";
    document.body.append(button);
  }, kind);
  const text = await page.locator(anchor).getAttribute("data-tooltip");
  const box = await page.locator(anchor).boundingBox();
  assert.ok(box, "Hover anchor must be visible");
  const windowHandle = (await readOwner()).handle;
  const hover = await capture({ windowHandle, hover: { x: box.x + box.width / 2, y: box.y + box.height / 2 } });
  const hoverPath = path.join(fixture, `${kind}-${phase}-${scheme}-hover.json`);
  await fs.writeFile(hoverPath, JSON.stringify({ windowHandle, ...hover }));
  try {
    let observed;
    const shown = await until(async () => {
      const owner = await readOwner();
      const bounds = await page.evaluate(() => {
        const tip = document.getElementById("kd-tooltip");
        if (tip.hidden || getComputedStyle(tip).visibility === "hidden") return null;
        return tip.getBoundingClientRect().toJSON();
      });
      observed = { owner, bounds };
      return owner?.foreground === false && bounds && !owner.captionExcludedFromWebView && { bounds, revealed: owner };
    }).catch(async error => {
      await fs.writeFile(path.join(fixture, `${kind}-${phase}-${scheme}-failure.json`), JSON.stringify(observed, null, 2));
      throw error;
    });
    const { bounds, revealed } = shown;
    assert.deepEqual(revealed.captionHits, [8, 9, 20], "Revealing a tooltip must retain native caption hit testing");
    assert.ok(bounds.y < 40, "Tooltip must cover caption pixels");
    const screenshot = path.join(fixture, `${kind}-tooltip-${phase}-${scheme}.png`);
    assert.equal(await page.locator("#kd-tooltip").isVisible(), true);
    assert.equal(await page.locator("#kd-tooltip").textContent(), text);
    const captureState = await capture({ windowHandle, path: screenshot, screen: true });
    const captured = await readOwner();
    await fs.writeFile(path.join(fixture, `${kind}-${phase}-${scheme}-capture.json`), JSON.stringify({ captured, captureState, hover }, null, 2));
    const scale = revealed.dpi / 96;
    assert.ok(Math.abs(captureState.cursorX - hover.targetX) < box.width * scale / 2
      && Math.abs(captureState.cursorY - hover.targetY) < box.height * scale / 2,
    "Mouse must remain inside the owned hover anchor during capture");
    assert.equal(captured.foreground, false, "Capture must retain the inactive state");
    assert.equal(captured.captionExcludedFromWebView, false, "Capture must retain the rounded reveal");
    assert.equal(await page.locator("#kd-tooltip").isVisible(), true, "Capture must retain the visible tooltip");
    // Auxiliary Escape shortcuts close their window as well. Exercise the
    // shared dismissal directly; keyboard dismissal is covered separately.
    await page.evaluate(() => KDComponents.installTooltips().hide());
    await until(async () => (await readOwner())?.captionExcludedFromWebView);
    assert.equal((await readOwner()).visible, true, "Tooltip dismissal must retain the tested window");
    assert.equal(await page.locator("#kd-tooltip").isVisible(), false);
    return { phase, scheme, active: false, bounds, revealed, screenshot };
  } finally {
    await capture({ releaseHover: { windowHandle, ...hover } });
    if (kind !== "main") await page.locator(anchor).evaluate(node => node.remove());
  }
}
try {
  await until(() => fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2500) }).then(r => r.ok, () => false), 90000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0], main = context.pages()[0];
  await until(() => main.evaluate(() => Boolean(window.__TAURI__?.core && document.querySelector(".native-titlebar"))).catch(() => false));
  const evidence = { build };
  for (const kind of ["settings", "new-task", "task-details", "task-preview", "main"]) {
    if (kind === "task-details") await invoke(main, "open_task_details", { id: 1 });
    else if (kind === "task-preview") await invoke(main, "open_task_preview", { id: 1 });
    else if (kind !== "main") await invoke(main, "open_auxiliary", { kind });
    const page = kind === "main" ? main : await until(() => context.pages().find(page => page.url().includes(`window=${kind}`)));
    // Playwright otherwise injects its default light theme into attached views.
    // Null explicitly restores the WebView's real operating-system preference.
    await page.emulateMedia({ colorScheme: null });
    await until(() => page.evaluate(() => Boolean(window.__TAURI__?.core && document.querySelector(".native-titlebar"))).catch(() => false));
    const dark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
    const windows = await main.evaluate(async () => Promise.all((await window.__TAURI__.window.getAllWindows()).map(async window => ({ label: window.label, title: await window.title() }))));
    const title = windows.find(window => window.label === kind).title;
    let state = await until(async () => (await readWindows()).find(window => window.title === title && window.visible && Boolean(window.dark) === dark));
    assert.equal(state.clientTopInset, 0);
    assert.deepEqual(state.captionHits, [8, 9, 20]);
    const output = path.join(fixture, `${kind}-system-theme.png`);
    const glyphs = await glyphWorker.request({ processId: child.pid, windowHandle: state.handle, path: output, keepVisible: true });
    assert.match(glyphs.glyphs, /native_caption_glyphs=ok/);
    evidence[kind] = { dark, state, output };
    console.log(`${kind}: native caption glyphs and system theme OK`);
    const tooltipEvidence = [];
    const readOwner = async () => (await readWindows()).find(window => window.handle === state.handle);
    const sentinel = await page.evaluate(() => window.__captionDocument = crypto.randomUUID());
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const initial = state;
        if (kind === "main") {
          // Use the tray's show_main path, retaining this document on a new HWND.
          await invoke(main, "open_auxiliary", { kind: "new-task" });
          const driver = await until(() => context.pages().find(page => page.url().includes("window=new-task")));
          await until(() => driver.evaluate(() => Boolean(window.__TAURI__?.core)).catch(() => false));
          await invoke(page, "frame_action", { action: "close" });
          await invoke(driver, "finish_task_window");
        } else {
          await invoke(page, "close_auxiliary");
          if (kind === "task-details") await invoke(main, "open_task_details", { id: 1 });
          else if (kind === "task-preview") await invoke(main, "open_task_preview", { id: 1 });
          else await invoke(main, "open_auxiliary", { kind });
        }
        state = await until(async () => (await readWindows()).find(window => window.visible && window.handle !== initial.handle && window.title === initial.title));
        assert.equal(await page.evaluate(() => window.__captionDocument), sentinel, "Shell renewal must retain the tooltip's document");
        assert.equal(state.captionExcludedFromWebView, true, "Renewal must clear the old tooltip footprint");
      }
      for (const scheme of ["light", "dark"]) {
        const phase = attempt === 0 ? "initial" : `reopened-${attempt}`;
        const deactivate = async () => {
          // Activation is requested by the application's own UI thread; a
          // separate PowerShell process is subject to foreground-lock denial.
          await invoke(main, "open_auxiliary", { kind: kind === "new-task" ? "settings" : "new-task" });
        };
        tooltipEvidence.push(await acceptTooltip(page, kind, phase, scheme, readOwner, deactivate));
        evidence[kind].tooltips = tooltipEvidence;
        await fs.writeFile(path.join(fixture, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
        console.log(`${kind}: ${phase} ${scheme} inactive tooltip reveal and dismissal OK`);
      }
    }
    if (kind === "main") {
      // Commands from a previous document/session must not reopen a reveal.
      const session = await invoke(page, "frame_tooltip", { session: 0, revision: 0, bounds: null });
      const layout = await page.evaluate(() => ({ left: innerWidth - 200, top: 8, width: 180, height: 38, radius: 12, viewportWidth: innerWidth, viewportHeight: innerHeight }));
      await invoke(page, "frame_tooltip", { session, revision: 2, bounds: null });
      await invoke(page, "frame_tooltip", { session, revision: 1, bounds: layout });
      assert.equal((await readOwner()).captionExcludedFromWebView, true);
      const newer = await invoke(page, "frame_tooltip", { session: 0, revision: 0, bounds: null });
      assert.notEqual(session, newer);
      await invoke(page, "frame_tooltip", { session, revision: 3, bounds: layout });
      assert.equal((await readOwner()).captionExcludedFromWebView, true);
      await assert.rejects(invoke(page, "frame_tooltip", { session: newer, revision: 1, bounds: { ...layout, width: 4000 } }));
      await page.reload();
      await until(() => page.evaluate(() => document.documentElement.dataset.nativeTooltip === "true").catch(() => false));
      assert.equal((await readOwner()).captionExcludedFromWebView, true);
      console.log("main: stale tooltip request rejection and navigation OK");
    }
    await page.emulateMedia({ colorScheme: null });
    if (kind !== "main") await invoke(page, "close_auxiliary");
  }
  await fs.writeFile(path.join(fixture, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Screenshots: ${fixture}`);
} finally {
  await fs.writeFile(path.join(fixture, "stderr.log"), stderr);
  console.log(`Diagnostics: ${fixture}`);
  await fetch(`http://127.0.0.1:${apiPort}/system/exit`, { method: "POST", signal: AbortSignal.timeout(2500) }).catch(() => {});
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
    const timer = setTimeout(finish, 10000);
    function finish() { clearTimeout(timer); child.off("exit", finish); resolve(); }
    child.once("exit", finish);
  });
  if (child.exitCode === null && child.signalCode === null) child.kill();
  captureWorker.close(); stateWorker.close(); glyphWorker.close();
}
