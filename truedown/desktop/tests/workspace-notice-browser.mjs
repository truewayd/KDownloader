import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { readUIFixtureAsset } from "./ui-fixture-assets.mjs";

const assets = new URL("../../web/", import.meta.url);
const screenshots = process.argv[2] || await fs.mkdtemp(path.join(os.tmpdir(), "truedown-notice-"));
await fs.mkdir(screenshots, { recursive: true });
const idle = { trueDown: { supported: true, autoUpdate: true, restartNeedsConfirmation: false }, engine: {} };
let state = idle, fail = false, reads = 0, restarts = 0;
let limit = 0, runtimeFail = false;
let moduleState = { running: false, version: "0.2.0" };
let nextResult = null;
const retries = { truedown: 0, "next-engine": 0, mega: 0, dropbox: 0, "google-drive": 0 };
let summary = {};
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname;
  if (["/system/update/check", "/system/engine/next", "/modules/update"].includes(name) && request.method === "POST") {
    const moduleUpdate = name === "/modules/update";
    let kind = name === "/system/engine/next" ? "next-engine" : "truedown";
    if (moduleUpdate) {
      let body = "";
      for await (const chunk of request) body += chunk;
      kind = JSON.parse(body).id;
      assert.ok(["mega", "dropbox", "google-drive"].includes(kind));
      moduleState = { id: kind, running: true, phase: "installing", version: "" };
    } else {
      state = kind === "next-engine" && nextResult ? nextResult : { ...idle, busy: kind };
    }
    retries[kind]++;
    await new Promise(resolve => setTimeout(resolve, 250));
    response.writeHead(202).end(JSON.stringify(moduleUpdate ? moduleState : state)); return;
  }
  if (name === "/modules/update") { response.end(JSON.stringify(moduleState)); return; }
  if (name === "/system/update") {
    reads++;
    if (fail) { response.writeHead(503).end("offline"); return; }
    response.end(JSON.stringify(state)); return;
  }
  if (name === "/system/update/restart") { restarts++; response.end("{}"); return; }
  if (name === "/tasks") { response.end(JSON.stringify({ tasks: [], total: 0, summary })); return; }
  if (name === "/settings/runtime") {
    if (runtimeFail) { response.writeHead(503).end("offline"); return; }
    response.end(JSON.stringify({ globalDownloadLimitBps: limit, concurrentDownloads: 3 })); return;
  }
  if (name.startsWith("/settings/")) { response.end("{}"); return; }
  const file = name.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg|png)$/.test(file)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png" }[file.split(".").at(-1)]);
    response.end(await readUIFixtureAsset(file, assets));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  for (const colorScheme of ["light", "dark"]) {
    state = idle;
    const context = await browser.newContext({ viewport: { width: 1080, height: 760 }, colorScheme, reducedMotion: "reduce" });
    await context.addInitScript(() => {
      window.__TRUEDOWN_PLATFORM__ = "windows";
      window.calls = [];
      window.confirmUpdate = false;
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "frame_state") return { maximized: false };
        if (command === "confirm_action") return confirmUpdate;
        if (command !== "core_request") return false;
        const response = await fetch(args.request.path, { method: args.request.method, body: args.request.body || undefined });
        return { status: response.status, owned: true, body: await response.text(), headers: {} };
      } } };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => systemUpdateState !== null);
    assert.equal(await page.locator("#workspace-notice").isVisible(), false);
    assert.equal(await page.locator("#workspace-traffic").isVisible(), false);
    assert.equal(await page.locator("#workspace-speed").textContent(), "0 B/s");
    assert.equal(await page.locator("#exit-truedown-btn").count(), 0);
    summary = { downloading: 2, downloadSpeed: 1048576, error: 0 };
    limit = 2 * 1048576;
    await page.evaluate(() => { refreshAndSchedule(true); scheduleSystemUpdateRefresh(true); });
    await page.waitForFunction(() => !document.getElementById("workspace-limit-action").hidden);
    assert.equal(await page.locator("#workspace-speed").textContent(), "1.0 MiB/s");
    assert.equal(await page.locator("#workspace-limit-label").textContent(), "全局限速 2.0 MiB/s");
    assert.equal(await page.locator("#workspace-traffic").isVisible(), true, "limit supplements live speed");
    await page.locator("#workspace-limit-action").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => calls.filter(call => call.command === "open_auxiliary").at(-1).args.kind), "settings");
    await page.screenshot({ path: path.join(screenshots, `${colorScheme}-limit.png`) });
    await page.locator(".sidebar-toggle").click();
    assert.equal(await page.locator("#workspace-limit-action").isVisible(), true);
    assert.match(await page.locator("#workspace-limit-action").getAttribute("aria-label"), /2.0 MiB\/s/);
    assert.equal(await page.locator("#workspace-speed").isVisible(), true);
    await page.setViewportSize({ width: 390, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(screenshots, `${colorScheme}-limit-narrow.png`) });
    await page.setViewportSize({ width: 1080, height: 760 });
    await page.locator(".sidebar-toggle").click();
    limit = 4 * 1048576;
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => document.getElementById("workspace-limit-label").textContent.includes("4.0 MiB/s"));
    runtimeFail = true;
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => document.getElementById("workspace-limit-action").hidden);
    assert.equal(await page.locator("#workspace-traffic").isVisible(), true);
    assert.equal(await page.evaluate(() => workspaceUpdateReadFailed), false, "runtime failure is independent of updater state");
    runtimeFail = false;
    limit = 0;
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => workspaceLimitRead === null);
    assert.equal(await page.locator("#workspace-limit-action").isVisible(), false);
    limit = 2 * 1048576;
    summary = {};
    await page.evaluate(() => { refreshAndSchedule(true); scheduleSystemUpdateRefresh(true); });
    await page.waitForFunction(() => currentSummary.downloading === 0 && workspaceDownloadLimitBps > 0);
    assert.equal(await page.locator("#workspace-limit-action").isVisible(), false, "idle configured limits stay hidden");
    limit = 0;
    // The real polling path must see progress even with an empty, filtered list.
    await page.locator("#task-search").fill("unrelated file");
    state = { ...idle, busy: "truedown", download: { taskId: 91, status: "downloading", totalLength: 10485760, completedLength: 4194304, downloadSpeed: 1048576 } };
    await page.waitForFunction(() => document.getElementById("workspace-notice-progress").getAttribute("aria-valuenow") === "40", null, { timeout: 10000 });
    assert.equal(await page.locator("#workspace-notice-detail").textContent(), "40%");
    assert.match(await page.locator("#workspace-notice-action").getAttribute("data-tooltip"), /40%.*4.0 MiB.*10.0 MiB.*1.0 MiB\/s/);
    assert.equal(await page.locator(".notice-progress-value").getAttribute("stroke-dasharray"), "40 100");
    assert.equal(await page.locator("#workspace-notice-action > .icon").isVisible(), false);
    assert.ok(await page.locator(".notice-copy").evaluate(node => {
      const title = node.firstElementChild.getBoundingClientRect(), detail = node.lastElementChild.getBoundingClientRect();
      return Math.abs(title.y - detail.y) < 2 && node.scrollWidth <= node.clientWidth;
    }), "notice fits on one line");
    await page.screenshot({ path: path.join(screenshots, `${colorScheme}-download.png`) });
    await page.locator(".sidebar-toggle").click();
    assert.equal(await page.locator(".notice-copy").isVisible(), false);
    assert.equal(await page.locator("#workspace-notice-progress").isVisible(), true);
    assert.equal(await page.locator("#workspace-notice-action > .icon").isVisible(), false);
    await page.screenshot({ path: path.join(screenshots, `${colorScheme}-download-collapsed.png`) });
    await page.locator(".sidebar-toggle").click();
    await page.locator("#workspace-notice-action").click();
    assert.equal(await page.evaluate(() => calls.filter(call => call.command === "open_auxiliary").at(-1).args.kind), "about");
    for (const status of ["paused", "queued", "done"]) {
      state = { ...state, download: { ...state.download, status } };
      await page.evaluate(() => scheduleSystemUpdateRefresh(true));
      await page.waitForFunction(expected => systemUpdateState.download.status === expected, status);
      assert.equal(await page.locator("#workspace-notice-progress").isVisible(), status !== "done");
      await page.screenshot({ path: path.join(screenshots, `${colorScheme}-${status}.png`) });
    }
    state = { ...idle, busy: "next-engine", download: { status: "queued", totalLength: 0 } };
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => workspaceNoticeTarget === "engine");
    assert.equal(await page.locator("#workspace-notice-progress").getAttribute("aria-valuenow"), null, "unknown totals use indeterminate progress");
    state = { ...idle, trueDown: { ...idle.trueDown, restartRequired: true, restartNeedsConfirmation: true, pendingVersion: "1.2.3" } };
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => workspaceNoticeTarget === "restart");
    await page.screenshot({ path: path.join(screenshots, `${colorScheme}-restart.png`) });
    const beforeRestart = restarts;
    await page.evaluate(() => { systemUpdateState.trueDown.restartNeedsConfirmation = false; });
    await page.locator("#workspace-notice-action").click();
    await page.waitForFunction(() => !restartConfirmationPending && !restartingForUpdate);
    assert.equal(restarts, beforeRestart, "cancellation cannot restart");
    await page.evaluate(() => { confirmUpdate = true; });
    await page.locator("#workspace-notice-action").click();
    await page.waitForFunction(() => !restartConfirmationPending && !restartingForUpdate);
    assert.equal(restarts, beforeRestart + 1, "confirmed restart uses the existing endpoint");
    state = { ...state, trueDown: { ...state.trueDown, restartNeedsConfirmation: false } };
    const confirmations = await page.evaluate(() => calls.filter(call => call.command === "confirm_action").length);
    await page.evaluate(() => { confirmUpdate = false; systemUpdateState.trueDown.restartNeedsConfirmation = true; });
    await page.evaluate(() => Promise.all([restartForTrueDownUpdate(), restartForTrueDownUpdate()]));
    assert.equal(restarts, beforeRestart + 2, "fresh idle state restarts directly and coalesces clicks");
    assert.equal(await page.evaluate(() => calls.filter(call => call.command === "confirm_action").length), confirmations, "idle restart has no confirmation");
    await page.evaluate(() => { settingsDirtyControls.set("engine", new Set([document.getElementById("auto-update-next")])); });
    await page.evaluate(() => restartForTrueDownUpdate());
    assert.equal(restarts, beforeRestart + 2, "unsaved settings remain cancellable even with an idle queue");
    assert.equal(await page.evaluate(() => calls.filter(call => call.command === "confirm_action").length), confirmations + 1);
    await page.evaluate(() => { settingsDirtyControls.clear(); });
    fail = true;
    await page.evaluate(() => restartForTrueDownUpdate());
    assert.equal(restarts, beforeRestart + 2, "failed preflight never guesses idle");
    fail = false;
    state = { ...state, trueDown: { ...state.trueDown, restartRequired: false } };
    await page.evaluate(() => restartForTrueDownUpdate());
    assert.equal(restarts, beforeRestart + 2, "stale pending restart cannot be submitted");
    state = { ...state, trueDown: { ...state.trueDown, restartRequired: true } };
    state = { ...state, error: "NEXT update failed" };
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => systemUpdateState.error !== "");
    assert.equal(await page.evaluate(() => workspaceNoticeTarget), "restart", "a separate update failure cannot hide a verified restart");
    for (const kind of ["truedown", "next-engine", "mega", "google-drive", "dropbox"]) {
      state = { ...idle, trueDown: { ...idle.trueDown, error: kind === "truedown" ? "Program install failed" : "" }, engine: { error: kind === "next-engine" ? "Engine verification failed" : "" } };
      moduleState = { id: ["mega", "google-drive", "dropbox"].includes(kind) ? kind : "mega", running: false, error: ["mega", "google-drive", "dropbox"].includes(kind) ? "Module installation failed" : "" };
      await page.evaluate(() => scheduleSystemUpdateRefresh(true));
      await page.waitForFunction(expected => workspaceNoticeCommand?.kind === expected, kind);
      const command = page.locator("#workspace-notice-command");
      assert.equal(await command.isVisible(), true);
      const row = await page.locator("#workspace-notice-action").boundingBox();
      const action = await command.boundingBox();
      assert.ok(action.x >= row.x + row.width && Math.abs(action.y + action.height / 2 - row.y - row.height / 2) < 2, "retry stays on the same row");
      await page.screenshot({ path: path.join(screenshots, `${colorScheme}-${kind}-retry.png`) });
      const before = retries[kind];
      const opened = await page.evaluate(() => calls.filter(call => call.command === "open_auxiliary").length);
      await command.focus();
      await page.keyboard.press("Enter");
      await page.evaluate(kind => Promise.all([requestUpdateOperation(kind), requestUpdateOperation(kind)]), kind);
      assert.equal(retries[kind], before + 1, "duplicate clicks reuse the full update operation");
      assert.equal(await page.evaluate(() => calls.filter(call => call.command === "open_auxiliary").length), opened, "retry executes without opening settings");
      if (kind === "mega") {
        await page.waitForFunction(() => document.getElementById("workspace-notice-title").textContent === "安装 MEGA 模块");
        moduleState = { id: "mega", running: true, phase: "downloading", download: { taskId: 42, status: "downloading", completedLength: 1024, totalLength: 4096, downloadSpeed: 1024 } };
        await page.evaluate(() => scheduleSystemUpdateRefresh(true));
        await page.waitForFunction(() => document.getElementById("workspace-notice-progress").getAttribute("aria-valuenow") === "25");
        await page.screenshot({ path: path.join(screenshots, `${colorScheme}-mega-progress.png`) });
      }
    }
    moduleState = { running: false };
    state = { ...idle, error: "Program install failed", trueDown: { ...idle.trueDown, error: "Program install failed" },
      engine: { preference: "next", active: "next", activeVersion: "3.0.2", nextInstalled: true, nextInstalledVersion: "3.0.2", nextRecommendedVersion: "3.0.2", autoUpdateSupported: true } };
    nextResult = state;
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => systemUpdateState.trueDown.error === "Program install failed" && !moduleUpdateState.running);
    await page.evaluate(() => { confirmUpdate = true; });
    await page.evaluate(() => installNextEngine());
    await page.waitForFunction(() => document.body.textContent.includes("当前已使用 Aria2 Next v3.0.2。"));
    assert.equal(await page.evaluate(() => systemUpdateState.trueDown.error), "Program install failed", "NEXT success preserves an independent program failure");
    assert.doesNotMatch(await page.locator("#engine-update-status").textContent(), /Program install failed/);
    nextResult = null;
    state = { ...idle, trueDown: { ...idle.trueDown, restartRequired: true, pendingVersion: "1.2.3" } };
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => workspaceNoticeTarget === "restart");
    await page.locator(".sidebar-toggle").click();
    assert.equal(await page.locator("#workspace-notice-command").isVisible(), true);
    assert.match(await page.locator("#workspace-notice-command").getAttribute("aria-label"), /重启/);
    await page.screenshot({ path: path.join(screenshots, `${colorScheme}-collapsed.png`) });
    await page.setViewportSize({ width: 390, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    fail = true;
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => workspaceUpdateReadFailed);
    assert.notEqual(await page.evaluate(() => workspaceNoticeTarget), "restart", "stale restart action is suppressed after failed reads");
    fail = false;
    state = { ...idle, busy: "program-update" };
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => systemUpdateState.busy === "program-update");
    assert.equal(await page.evaluate(() => workspaceNoticeTarget), "about");
    state = { ...idle, busy: "engine-recovery" };
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => !workspaceUpdateReadFailed && workspaceNoticeTarget === "engine");
    await page.locator("#workspace-notice-action").click();
    assert.equal(await page.evaluate(() => calls.filter(call => call.command === "open_auxiliary").at(-1).args.kind), "engine");
    state = { ...idle, error: "Checksum mismatch" };
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => document.getElementById("workspace-notice-action").dataset.tooltip === "Checksum mismatch");
    state = idle;
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => workspaceNoticeTarget === "tasks" && document.getElementById("workspace-notice").hidden);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
    const stopped = reads;
    await page.waitForTimeout(1700);
    assert.equal(reads, stopped, "teardown stops update polling");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(`Update notice acceptance passed. Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
