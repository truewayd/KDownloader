// Explicit visible acceptance: only isolated, process-owned popup windows are captured.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

assert.equal(process.platform, "win32");
assert.equal(process.argv[2], "--visible", "Visible popup checks require explicit opt-in");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-popup-visual-"));
for (const [source, name] of [["target/debug/truedown-desktop.exe", "TrueDown.exe"], ["binaries/truedown-core-x86_64-pc-windows-msvc.exe", "truedown-core.exe"], ["binaries/truedown-cli-x86_64-pc-windows-msvc.exe", "truedown-cli.exe"], ["target/debug/aria2c.exe", "aria2c.exe"]]) await fs.copyFile(path.join(desktop, source), path.join(fixture, name));
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
const apiPort = await port(), debugPort = await port();
const child = spawn(path.join(fixture, "TrueDown.exe"), ["--data-dir", path.join(fixture, "profile")], { windowsHide: true, stdio: "ignore", env: {
  ...process.env, TRUEDOWN_DESKTOP_TEST: "0", TRUEDOWN_ADDR: `127.0.0.1:${apiPort}`, TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "", TRUEDOWN_DESKTOP_TEST_DEBUG_PORT: String(debugPort), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "",
} });
let browser, launchError;
child.on("error", error => { launchError = error; });
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null);
    const result = await check(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Popup acceptance timed out");
}
const invoke = (page, command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
const capture = (title, name) => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(desktop, "tests/windows-popup-capture.ps1"), "-ProcessId", String(child.pid), "-Title", title, "-OutputPath", path.join(fixture, name)], { windowsHide: true, timeout: 15000, encoding: "utf8" }));
try {
  await until(() => fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false), 90000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0], main = context.pages()[0];
  await main.emulateMedia({ colorScheme: null });
  await until(() => main.evaluate(() => typeof confirmAction === "function" && Boolean(window.__TAURI__?.core)).catch(() => false));
  const evidence = [];
  for (const kind of ["info", "warning", "error"]) {
    const title = { info: "信息", warning: "恢复默认设置？", error: "移除下载任务？" }[kind];
    const message = { info: "设置已更新，新任务将使用新的默认值。", warning: "恢复当前分类的默认设置并立即保存。自定义文件分组保持不变。", error: "此操作会移除所选任务。请确认后继续。" }[kind];
    if (kind !== "info") {
      await invoke(main, "prepare_popup", { kind: "confirmation" });
      const warm = await until(() => context.pages().find(page => page.url().endsWith("confirmation.html")));
      await until(() => warm.evaluate(() => window.__popupLoaded && !window.__popupActive));
      await invoke(main, "prepare_popup", { kind: "confirmation" });
      assert.equal(context.pages().filter(page => page.url().endsWith("confirmation.html")).length, 1);
    }
    const started = performance.now();
    await main.evaluate(options => { window.popupResult = undefined; confirmAction(options).then(value => { window.popupResult = value; }); }, { title, message, kind, confirmLabel: kind === "info" ? "知道了" : "继续", cancelLabel: "取消" });
    const popup = await until(() => context.pages().find(page => page.url().endsWith("confirmation.html")));
    await popup.emulateMedia({ colorScheme: null });
    await popup.locator("#confirm").waitFor({ state: "visible" });
    await until(() => popup.locator("#title").textContent().then(value => value === title));
    await until(async () => {
      if (popup.isClosed()) throw new Error(`Popup ${kind} closed during readiness: ${await main.evaluate(() => window.popupResult)}`);
      const state = await popup.evaluate(() => ({ active: window.__popupActive, message: document.getElementById("message").textContent }));
      if (!state.active && state.message !== message) throw new Error(`Popup readiness failed: ${JSON.stringify(state)}`);
      return state.active;
    });
    const readyMs = Math.round(performance.now() - started);
    await assert.rejects(invoke(popup, "core_request", { request: { method: "GET", path: "/tasks" } }));
    await assert.rejects(invoke(popup, "open_auxiliary", { kind: "settings" }));
    await assert.rejects(invoke(main, "confirmation_answer", { accepted: true }));
    await assert.rejects(invoke(main, "confirm_action", { options: { title: "Duplicate", message: "Duplicate", confirmLabel: "Yes", cancelLabel: "No", kind } }));
    assert.equal(await main.locator("#dialog-overlay").getAttribute("aria-hidden"), "true");
    const state = capture(title, `confirmation-${kind}.png`);
    assert.notEqual(state.owner, "0"); assert.equal(state.ownerEnabled, false);
    evidence.push({ kind, prepared: kind !== "info", readyMs, ...state });
    await popup.locator(kind === "info" ? "#confirm" : "#cancel").click();
    await until(() => main.evaluate(() => window.popupResult !== undefined));
    assert.equal(await main.evaluate(() => window.popupResult), kind === "info");
    await until(() => !context.pages().includes(popup));
  }
  await invoke(main, "open_auxiliary", { kind: "settings" });
  const settings = await until(() => context.pages().find(page => page.url().includes("window=settings")));
  await settings.emulateMedia({ colorScheme: null });
  await settings.locator("#cfg-user-agent").fill("TrueDown editor selection");
  await settings.locator("#cfg-user-agent").evaluate(element => { element.focus(); element.setSelectionRange(0, 8); element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: innerWidth - 10, clientY: innerHeight - 10 })); });
  const menu = await until(() => context.pages().find(page => page.url().endsWith("context-menu-window.html")));
  await menu.emulateMedia({ colorScheme: null });
  await menu.locator('[data-action="select-all"]').waitFor({ state: "visible" });
  assert.equal(await settings.locator('.kd-context-menu').count(), 0, "desktop menus must not exist in the caller DOM");
  await assert.rejects(invoke(menu, "core_request", { request: { method: "GET", path: "/tasks" } }));
  await assert.rejects(invoke(menu, "context_menu_answer", { action: "remove" }));
  const menuState = capture("TrueDown menu", "context-menu-editor.png");
  assert.notEqual(menuState.owner, "0"); assert.equal(menuState.ownerEnabled, true);
  evidence.push({ kind: "menu", ...menuState });
  await menu.locator('[data-action="select-all"]').click();
  await until(() => !context.pages().includes(menu));
  await until(() => settings.locator("#cfg-user-agent").evaluate(e => e.selectionStart === 0 && e.selectionEnd === e.value.length));
  await settings.locator("#cfg-user-agent").click({ button: "right" });
  const escapeMenu = await until(() => context.pages().find(page => page.url().endsWith("context-menu-window.html")));
  await escapeMenu.locator('[data-action="select-all"]').waitFor({ state: "visible" });
  await until(() => escapeMenu.evaluate(() => window.__popupActive));
  await escapeMenu.keyboard.press("Escape");
  await until(() => !context.pages().includes(escapeMenu));
  await fs.writeFile(path.join(fixture, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`Independent confirmation HWNDs, owner disable/restore, fail-closed IPC and results passed. Screenshots: ${fixture}`);
} finally {
  await fetch(`http://127.0.0.1:${apiPort}/system/exit`, { method: "POST", signal: AbortSignal.timeout(2500) }).catch(() => {});
  await browser?.close();
  if (child.exitCode === null) await new Promise(resolve => { const timer = setTimeout(resolve, 10000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
  if (child.exitCode === null) child.kill();
}
