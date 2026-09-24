// Explicit visible acceptance: only isolated, process-owned popup windows are captured.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
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
// Start capture once before showing the app: launching a console for each image
// can change OS focus and correctly dismiss a transient menu before capture.
const captureWorker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(desktop, "tests/windows-popup-capture.ps1"), "-Server"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
const captureLines = createInterface({ input: captureWorker.stdout });
let captureReply;
captureLines.on("line", line => { captureReply?.(line); });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { captureWorker.kill(); reject(new Error("Capture helper startup timed out")); }, 15000);
  captureReply = line => { clearTimeout(timer); captureReply = null; assert.equal(line, "ready"); resolve(); };
  captureWorker.once("error", error => { clearTimeout(timer); reject(error); });
});
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
const capture = (title, name) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { captureReply = null; reject(new Error("Capture timed out")); }, 15000);
  captureReply = line => {
    clearTimeout(timer); captureReply = null;
    try { const result = JSON.parse(line); if (result.error) reject(new Error(result.error)); else resolve(result); }
    catch (error) { reject(error); }
  };
  captureWorker.stdin.write(JSON.stringify({ processId: child.pid, title, path: name ? path.join(fixture, name) : "" }) + "\n");
});
try {
  await until(() => fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false), 90000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0], main = context.pages()[0];
  await main.emulateMedia({ colorScheme: null });
  await until(() => main.evaluate(() => typeof confirmAction === "function" && Boolean(window.__TAURI__?.core)).catch(() => false));
  await invoke(main, "open_auxiliary", { kind: "settings" });
  const settings = await until(() => context.pages().find(page => page.url().includes("window=settings")));
  await settings.emulateMedia({ colorScheme: null });
  await until(() => settings.evaluate(() => typeof settingsReady !== "undefined" && settingsReady.has("general")));
  const evidence = [];
  const baseline = page => page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return ["--kd-surface", "--kd-text", "--kd-control-radius", "--kd-font-body"].map(name => css.getPropertyValue(name).trim());
  });
  const mainBaseline = await baseline(main);
  for (const kind of ["info", "warning", "error"]) {
    const title = { info: "信息", warning: "恢复默认设置？", error: "移除下载任务？" }[kind];
    const message = { info: "设置已更新，新任务将使用新的默认值。", warning: "恢复当前分类的默认设置并立即保存。自定义文件分组保持不变。", error: "此操作会移除所选任务。请确认后继续。" }[kind];
    if (kind !== "info") {
      await invoke(settings, "prepare_popup", { kind: "confirmation" });
      const warm = await until(() => context.pages().find(page => page.url().endsWith("confirmation.html")));
      await until(() => warm.evaluate(() => window.__popupLoaded && !window.__popupActive));
      await invoke(settings, "prepare_popup", { kind: "confirmation" });
      assert.equal(context.pages().filter(page => page.url().endsWith("confirmation.html")).length, 1);
    }
    const started = performance.now();
    await settings.evaluate(options => { window.popupResult = undefined; confirmAction(options).then(value => { window.popupResult = value; }); }, { title, message, kind, confirmLabel: kind === "info" ? "知道了" : "继续", cancelLabel: "取消" });
    const popup = await until(() => context.pages().find(page => page.url().endsWith("confirmation.html")));
    await popup.emulateMedia({ colorScheme: null });
    await popup.locator("#confirm").waitFor({ state: "visible" });
    await until(() => popup.locator("#title").textContent().then(value => value === title));
    await until(async () => {
      if (popup.isClosed()) throw new Error(`Popup ${kind} closed during readiness: ${await settings.evaluate(() => window.popupResult)}`);
      const state = await popup.evaluate(() => ({ active: window.__popupActive, message: document.getElementById("message").textContent }));
      if (!state.active && state.message !== message) throw new Error(`Popup readiness failed: ${JSON.stringify(state)}`);
      return state.active;
    });
    const readyMs = Math.round(performance.now() - started);
    assert.deepEqual(await baseline(popup), mainBaseline, "popup must use the same product baseline");
    assert.equal(await popup.locator("#title").evaluate(el => getComputedStyle(el).position), "absolute", "native title must not be repeated as a visible heading");
    await assert.rejects(invoke(popup, "core_request", { request: { method: "GET", path: "/tasks" } }));
    await assert.rejects(invoke(popup, "open_auxiliary", { kind: "settings" }));
    await assert.rejects(invoke(settings, "confirmation_answer", { accepted: true }));
    await assert.rejects(invoke(settings, "confirm_action", { options: { title: "确认窗口并发检查", message: "测试另一个确认窗口打开时是否会被拒绝。", confirmLabel: "确认", cancelLabel: "取消", kind } }));
    assert.equal(await settings.locator("#dialog-overlay").getAttribute("aria-hidden"), "true");
    const state = await capture(title, `confirmation-${kind}.png`);
    assert.notEqual(state.owner, "0"); assert.equal(state.ownerEnabled, false);
    evidence.push({ kind, prepared: kind !== "info", readyMs, ...state });
    await popup.locator(kind === "info" ? "#confirm" : "#cancel").click();
    await until(() => settings.evaluate(() => window.popupResult !== undefined));
    assert.equal(await settings.evaluate(() => window.popupResult), kind === "info");
    await until(() => !context.pages().includes(popup));
  }
  await settings.evaluate(() => {
    const message = Array.from({ length: 30 }, (_, index) => `${index + 1}. 恢复默认值后，新任务将使用默认下载选项；已有任务与自定义文件分组保持不变。`).join("\n");
    confirmAction({ title: "恢复默认设置？", message, kind: "warning", confirmLabel: "恢复默认", cancelLabel: "取消" });
  });
  const longPopup = await until(() => context.pages().find(page => page.url().endsWith("confirmation.html")));
  await until(() => longPopup.evaluate(() => window.__popupActive));
  assert.equal(await longPopup.evaluate(() => {
    const message = document.getElementById("message"), footer = document.querySelector("footer").getBoundingClientRect();
    return innerHeight <= 420 && message.scrollHeight > message.clientHeight && footer.bottom <= innerHeight && footer.top >= 0;
  }), true, "long descriptions must scroll within the height bound and leave actions visible");
  await longPopup.keyboard.press("Escape");
  await until(() => !context.pages().includes(longPopup));
  await invoke(main, "open_auxiliary", { kind: "settings" });

  await settings.locator("#settings-reset-btn").waitFor({ state: "visible" });
  await settings.screenshot();
  await capture("设置", "settings.png");
  await invoke(main, "open_auxiliary", { kind: "settings" });
  await settings.locator("#cfg-folder").fill("C:\\Downloads\\TrueDown selection");
  await settings.locator("#cfg-folder").click();
  await capture("设置", null);
  await settings.evaluate(() => {
    window.menuEvents = [];
    const original = invokeNative;
    invokeNative = async (command, args) => {
      if (command.includes("context_menu")) window.menuEvents.push(command);
      try { return await original(command, args); }
      catch (error) { if (command.includes("context_menu")) window.menuEvents.push(error.message); throw error; }
    };
  });
  await settings.locator("#cfg-folder").evaluate(element => { element.focus(); element.setSelectionRange(0, 8); element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: innerWidth - 10, clientY: innerHeight - 10 })); });
  const menu = await until(() => context.pages().find(page => page.url().endsWith("context-menu-window.html")))
    .catch(async error => { throw new Error(`${error.message}: ${JSON.stringify(await settings.evaluate(() => ({ events: window.menuEvents, visible: document.visibilityState, focused: document.hasFocus() })))}`); });
  await menu.emulateMedia({ colorScheme: null });
  await menu.locator('[data-action="select-all"]').waitFor({ state: "visible" });
  await until(() => menu.evaluate(() => window.__popupActive));
  const menuState = await capture("操作菜单", "context-menu-editor.png");
  assert.deepEqual(await baseline(menu), mainBaseline);
  assert.equal(await settings.locator('.kd-context-menu').count(), 0, "desktop menus must not exist in the caller DOM");
  await assert.rejects(invoke(menu, "core_request", { request: { method: "GET", path: "/tasks" } }));
  await assert.rejects(invoke(menu, "context_menu_answer", { action: "remove" }));
  assert.notEqual(menuState.owner, "0"); assert.equal(menuState.ownerEnabled, true);
  assert.equal(menuState.ownerForeground, true, "mouse menus must keep their caller as the foreground HWND");
  assert.equal(await settings.evaluate(() => document.hasFocus()), true, "mouse menus must retain editor focus");
  await settings.keyboard.press("End");
  await until(() => menu.evaluate(() => document.activeElement?.dataset.action === "select-all"));
  evidence.push({ kind: "menu", ...menuState });
  await menu.locator('[data-action="select-all"]').click();
  await until(() => !context.pages().includes(menu));
  await until(() => settings.locator("#cfg-folder").evaluate(e => e.selectionStart === 0 && e.selectionEnd === e.value.length));
  await until(() => settings.evaluate(() => !els.settingsForm.inert));
  await capture("设置", null);
  await settings.locator("#cfg-folder").click({ button: "right" });
  const escapeMenu = await until(async () => {
    for (const page of context.pages().filter(page => page.url().endsWith("context-menu-window.html"))) {
      if (await page.evaluate(() => window.__popupActive).catch(() => false)) return page;
    }
  });
  await escapeMenu.locator('[data-action="select-all"]').waitFor({ state: "visible" });
  await until(() => escapeMenu.evaluate(() => window.__popupActive));
  await escapeMenu.keyboard.press("Escape");
  await until(() => !context.pages().includes(escapeMenu));
  await invoke(settings, "close_auxiliary");
  await invoke(main, "open_auxiliary", { kind: "new-task" });
  const form = await until(() => context.pages().find(page => page.url().includes("window=new-task")));
  await form.emulateMedia({ colorScheme: null });
  await form.locator("#download-form").waitFor({ state: "visible" });
  await until(() => form.evaluate(() => typeof nativeTaskFormReady !== "undefined" && nativeTaskFormReady && document.querySelector(".app-shell").hidden));
  // Ensure the native compositor has presented the initialized form, not the
  // index document's earlier main-view frame retained by PrintWindow.
  await form.screenshot();
  await capture("新建下载", "new-task.png");
  await fs.writeFile(path.join(fixture, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`Independent confirmation HWNDs, owner disable/restore, fail-closed IPC and results passed. Screenshots: ${fixture}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser?.isConnected()) {
    for (const page of browser.contexts()[0].pages()) {
      if (page.url().includes("window=settings") || /\/$/.test(page.url())) {
        await Promise.race([invoke(page, "confirmation_cancel").catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
      }
    }
  }
  await Promise.race([browser?.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  await fetch(`http://127.0.0.1:${apiPort}/system/exit`, { method: "POST", signal: AbortSignal.timeout(2500) }).catch(() => {});
  if (child.exitCode === null) await new Promise(resolve => { const timer = setTimeout(resolve, 10000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
  if (child.exitCode === null) child.kill();
  captureWorker.stdin.end();
  captureLines.close();
  captureWorker.kill();
}
// The native process and capture helper have been stopped. Terminate a stuck
// CDP transport too, so a disconnected WebView cannot keep this CLI fixture open.
process.exit(process.exitCode || 0);
