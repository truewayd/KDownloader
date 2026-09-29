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
  for (const kind of ["main", "settings", "new-task", "task-details"]) {
    if (kind === "task-details") await invoke(main, "open_task_details", { id: 1 });
    else if (kind !== "main") await invoke(main, "open_auxiliary", { kind });
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
    const capture = powershell("windows-visual-window.ps1", ["-WindowHandle", state.handle, "-OutputPath", output, ...(kind === "main" ? ["-KeepVisible"] : [])]);
    assert.match(capture, /native_caption_glyphs=ok/);
    evidence[kind] = { dark, state, output };
    console.log(`${kind}: native caption glyphs and system theme OK`);
    if (kind === "main") {
      const tooltipEvidence = [];
      const readOwner = () => readWindows().find(window => window.handle === state.handle);
      for (const scheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: scheme });
        console.log(`Waiting for foreground: ${fixture} (${scheme})`);
        await until(() => readOwner().foreground, 60000);
        await until(() => page.evaluate(() => document.documentElement.dataset.nativeTooltip === "true"));
        await page.evaluate(() => {
          const button = document.createElement("button");
          button.id = "caption-tooltip-fixture";
          button.textContent = "Tooltip fixture";
          button.dataset.tooltip = "Title bar tooltip overlay";
          button.style.cssText = "position:fixed;right:16px;top:60px;z-index:100";
          document.body.append(button);
          button.focus();
        });
        await until(() => page.evaluate(() => !document.getElementById("kd-tooltip").hidden));
        const revealed = await until(() => { const owner = readOwner(); return !owner.captionExcludedFromWebView && owner; });
        const bounds = await page.locator("#kd-tooltip").boundingBox();
        assert.ok(bounds.y < 40, "Tooltip must cover caption pixels");
        const screenshot = path.join(fixture, `main-tooltip-${scheme}.png`);
        // Flush the WebView compositor before PrintWindow reads native pixels.
        await page.screenshot({ path: path.join(fixture, `tooltip-webview-${scheme}.png`) });
        assert.equal(await page.locator("#kd-tooltip").isVisible(), true);
        assert.equal(await page.locator("#kd-tooltip").textContent(), "Title bar tooltip overlay");
        powershell("windows-popup-capture.ps1", ["-Title", readOwner().title, "-OutputPath", screenshot]);
        await page.keyboard.press("Escape");
        await until(() => readOwner().captionExcludedFromWebView);
        assert.equal(await page.locator("#kd-tooltip").isVisible(), false);
        await page.locator("#caption-tooltip-fixture").evaluate(node => node.remove());
        tooltipEvidence.push({ scheme, bounds, revealed, screenshot });
      }
      // Commands from a previous document/session must not reopen a reveal.
      const session = await invoke(page, "frame_tooltip", { session: 0, revision: 0, bounds: null });
      const layout = await page.evaluate(() => ({ left: innerWidth - 200, top: 8, width: 180, height: 38, radius: 12, viewportWidth: innerWidth, viewportHeight: innerHeight }));
      await invoke(page, "frame_tooltip", { session, revision: 2, bounds: null });
      await invoke(page, "frame_tooltip", { session, revision: 1, bounds: layout });
      assert.equal(readOwner().captionExcludedFromWebView, true);
      const newer = await invoke(page, "frame_tooltip", { session: 0, revision: 0, bounds: null });
      assert.notEqual(session, newer);
      await invoke(page, "frame_tooltip", { session, revision: 3, bounds: layout });
      assert.equal(readOwner().captionExcludedFromWebView, true);
      await assert.rejects(invoke(page, "frame_tooltip", { session: newer, revision: 1, bounds: { ...layout, width: 4000 } }));
      await page.reload();
      await until(() => page.evaluate(() => document.documentElement.dataset.nativeTooltip === "true").catch(() => false));
      assert.equal(readOwner().captionExcludedFromWebView, true);
      evidence.tooltips = tooltipEvidence;
      console.log("main: light/dark DOM tooltip caption reveal, dismissal, stale request rejection and navigation OK");
    }
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
