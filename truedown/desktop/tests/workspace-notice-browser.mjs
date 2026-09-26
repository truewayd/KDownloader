import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { readUIFixtureAsset } from "./ui-fixture-assets.mjs";

const assets = new URL("../../web/", import.meta.url);
const screenshots = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-notice-"));
const idle = { trueDown: { supported: true, autoUpdate: true }, engine: {} };
let state = idle, fail = false, reads = 0, restarts = 0;
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname;
  if (name === "/system/update") {
    reads++;
    if (fail) { response.writeHead(503).end("offline"); return; }
    response.end(JSON.stringify(state)); return;
  }
  if (name === "/system/update/restart") { restarts++; response.end("{}"); return; }
  if (name === "/tasks") { response.end(JSON.stringify({ tasks: [], total: 0, summary: {} })); return; }
  if (name.startsWith("/settings/")) { response.end("{}"); return; }
  const file = name.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(file)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" }[file.split(".").at(-1)]);
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
        const response = await fetch(args.request.path, { method: args.request.method });
        return { status: response.status, owned: true, body: await response.text(), headers: {} };
      } } };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => systemUpdateState !== null);
    assert.equal(await page.locator("#workspace-notice").isVisible(), false);
    assert.equal(await page.locator("#exit-truedown-btn").count(), 0);
    // The real polling path must see progress even with an empty, filtered list.
    await page.locator("#task-search").fill("unrelated file");
    state = { ...idle, busy: "truedown", download: { taskId: 91, status: "downloading", totalLength: 10485760, completedLength: 4194304, downloadSpeed: 1048576 } };
    await page.waitForFunction(() => document.getElementById("workspace-notice-progress").value === 40, null, { timeout: 10000 });
    assert.match(await page.locator("#workspace-notice-detail").textContent(), /40%.*4.0 MiB.*10.0 MiB.*1.0 MiB\/s/);
    await page.screenshot({ path: path.join(screenshots, `${colorScheme}-download.png`) });
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
    assert.equal(await page.locator("#workspace-notice-progress").getAttribute("value"), null, "unknown totals use indeterminate progress");
    state = { ...idle, trueDown: { ...idle.trueDown, restartRequired: true, pendingVersion: "1.2.3" } };
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => workspaceNoticeTarget === "restart");
    await page.screenshot({ path: path.join(screenshots, `${colorScheme}-restart.png`) });
    const beforeRestart = restarts;
    await page.locator("#workspace-notice-action").click();
    await page.waitForFunction(() => !restartConfirmationPending && !restartingForUpdate);
    assert.equal(restarts, beforeRestart, "cancellation cannot restart");
    await page.evaluate(() => { confirmUpdate = true; });
    await page.locator("#workspace-notice-action").click();
    await page.waitForFunction(() => !restartConfirmationPending && !restartingForUpdate);
    assert.equal(restarts, beforeRestart + 1, "confirmed restart uses the existing endpoint");
    state = { ...state, error: "NEXT update failed" };
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => systemUpdateState.error !== "");
    assert.equal(await page.evaluate(() => workspaceNoticeTarget), "restart", "a separate update failure cannot hide a verified restart");
    await page.locator(".sidebar-toggle").click();
    assert.equal(await page.locator("#workspace-notice-action").isVisible(), true);
    assert.match(await page.locator("#workspace-notice-action").getAttribute("aria-label"), /1\.2\.3/);
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
    await page.waitForFunction(() => document.getElementById("workspace-notice-detail").textContent === "Checksum mismatch");
    state = idle;
    await page.evaluate(() => scheduleSystemUpdateRefresh(true));
    await page.waitForFunction(() => document.getElementById("workspace-notice").hidden);
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
