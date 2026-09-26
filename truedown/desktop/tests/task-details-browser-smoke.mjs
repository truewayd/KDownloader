import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { readUIFixtureAsset } from "./ui-fixture-assets.mjs";

const assets = new URL("../../web/", import.meta.url);
const screenshots = path.resolve(process.argv[2] || "../dist/task-details-review");
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" }[name.split(".").at(-1)]);
    response.end(await readUIFixtureAsset(name, assets));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  await fs.mkdir(screenshots, { recursive: true });
  for (const colorScheme of ["light", "dark"]) for (const [width, height] of [[640, 640], [520, 420]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 2 });
    await context.addInitScript(() => {
      const listeners = new Map();
      window.__TRUEDOWN_PLATFORM__ = "windows";
      window.nativeCalls = [];
      window.detailState = { id: 1, open: true, revision: 1 };
      window.emitDetailState = state => {
        if (state.revision > window.detailState.revision) window.detailState = state;
        for (const listener of listeners.get("truedown:task-details") || []) listener({ payload: state });
      };
      window.fixtureTasks = [1, 2].map(id => ({
        id, name: `Task ${id}.zip`, outputName: `Task ${id}.zip`, status: "paused", category: "other",
        totalLength: 102400, completedLength: 51200, downloadSpeed: 0, folder: "C:\\Downloads",
        link: `https://example.test/${"long-path/".repeat(12)}file-${id}.zip`, settingsRevision: "1",
        settings: { connections: 16, maxSpeedBps: 0, maxTries: 5, retryWait: 3 },
        transfer: { available: true, connections: 2, pieceCount: 96, pieceLength: 1048576, completedPieces: 42, serversAvailable: true,
          pieces: Array.from({ length: 32 }, (_, i) => ({ first: i * 3, count: 3, completed: i < 10 ? 3 : i < 22 ? 1 : 0 })),
          servers: [{ fileIndex: 1, host: "cdn.example.test", downloadSpeed: 0 }, { fileIndex: 1, host: "mirror.example.test", downloadSpeed: 4096 }] },
      }));
      window.__TAURI__ = {
        event: { listen: async (name, callback) => {
          listeners.set(name, [...(listeners.get(name) || []), callback]);
          return () => listeners.set(name, listeners.get(name).filter(value => value !== callback));
        } },
        core: { invoke: async (command, args) => {
          window.nativeCalls.push({ command, args });
          if (command === "frame_state") return { maximized: false };
          if (command === "task_details_state") return window.detailState;
          if (command === "close_auxiliary") return window.emitDetailState({ ...window.detailState, open: false, revision: window.detailState.revision + 1 });
          if (command !== "core_request") return;
          const request = args.request;
          const url = new URL(request.path, "http://localhost");
          if (url.pathname === "/tasks/detail") {
            const task = window.fixtureTasks.find(task => task.id === Number(url.searchParams.get("id")));
            if (!task) return { status: 404, body: "Task removed", headers: {} };
            if (request.method === "POST") {
              const saved = JSON.parse(request.body);
              if (saved.revision !== task.settingsRevision) return { status: 409, body: "Conflict", headers: {} };
              task.settings = saved.values; task.settingsRevision = String(Number(task.settingsRevision) + 1);
            }
            const response = { status: 200, body: JSON.stringify(task), headers: {} };
            if (window.holdDetailRead && request.method === "GET") return new Promise(resolve => { window.finishDetailRead = () => resolve(response); });
            return response;
          }
          if (url.pathname === "/tasks/batch") {
            const { action, ids } = JSON.parse(request.body);
            for (const task of window.fixtureTasks) if (ids.includes(task.id)) task.status = action === "pause" ? "paused" : "downloading";
            return { status: 200, body: "{}", headers: {} };
          }
          throw new Error(`Unexpected detail request: ${request.method} ${request.path}`);
        } },
      };
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?window=task-details`);
    await page.waitForFunction(() => taskDetailData?.id === 1);
    assert.equal(await page.locator(".sidebar").isVisible(), false);
    assert.equal(await page.locator("#task-detail-back").isVisible(), false);
    assert.equal(await page.locator("#batch-task-btn").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('#task-piece-map > span').count(), 32);
    assert.equal(await page.locator('#task-piece-map [data-piece-state="complete"]').count(), 10);
    assert.equal(await page.locator('#task-connections-body tr').count(), 2);
    assert.match(await page.locator('#task-piece-map').getAttribute('aria-label'), /42.*96/);
    assert.ok((await page.locator('#task-info-grid').textContent()).includes('未报告'));
    await page.screenshot({ path: path.join(screenshots, `details-${width}-${colorScheme}.png`) });
    await page.evaluate(() => { fixtureTasks[0].transfer = { available: false }; loadTaskDetails(); });
    await page.waitForFunction(() => document.getElementById('task-piece-map').hidden);
    assert.equal(await page.locator('#task-connections-body tr').count(), 0, 'unavailable reads clear stale connection speeds');
    await page.locator("#task-settings-tab").click();
    await page.waitForFunction(() => taskDetailTab === "settings" && taskDetailData?.id === 1);
    const scroll = page.locator(".task-detail-scroll");
    if (await scroll.evaluate(element => element.scrollHeight > element.clientHeight)) {
      await scroll.hover();
      await page.mouse.wheel(0, 800);
      await page.waitForFunction(() => document.querySelector(".task-detail-scroll").scrollTop > 0);
      const save = await page.locator("#task-settings-save").boundingBox();
      assert.ok(save && save.y >= 0 && save.y + save.height <= height);
      await page.mouse.wheel(0, -1600);
      await page.waitForFunction(() => document.querySelector(".task-detail-scroll").scrollTop === 0);
    }
    await page.locator("#task-setting-connections").fill("8");
    await page.evaluate(() => loadTaskDetails());
    assert.equal(await page.locator("#task-setting-connections").inputValue(), "8");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !nativeDetailOpen);
    const reads = await page.evaluate(() => nativeCalls.length);
    await page.evaluate(() => loadTaskDetails());
    assert.equal(await page.evaluate(() => nativeCalls.length), reads);
    await page.evaluate(() => emitDetailState({ id: 1, open: true, revision: detailState.revision + 1 }));
    await page.waitForFunction(() => taskDetailData?.id === 1);
    assert.equal(await page.locator("#task-setting-connections").inputValue(), "8");
    await page.locator("#task-settings-save").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => fixtureTasks[0].settings.connections === 8 && !taskDetailDrafts.get(1).saving);
    await page.locator('[data-action="resume"]').click();
    await page.waitForFunction(() => taskDetailData?.status === "downloading");
    assert.equal(await page.locator("#task-setting-connections").isDisabled(), true);
    assert.equal(await page.locator("#task-setting-speed").isDisabled(), false);
    await page.evaluate(() => { holdDetailRead = true; loadTaskDetails(); });
    await page.waitForFunction(() => typeof finishDetailRead === "function");
    await page.evaluate(() => { holdDetailRead = false; emitDetailState({ id: 2, open: true, revision: detailState.revision + 1 }); });
    await page.waitForFunction(() => taskDetailData?.id === 2);
    await page.evaluate(() => finishDetailRead());
    assert.equal(await page.locator("#task-detail-title").textContent(), "Task 2.zip");
    await page.evaluate(() => emitDetailState({ id: 1, open: true, revision: 1 }));
    assert.equal(await page.locator("#task-detail-title").textContent(), "Task 2.zip");
    await page.locator("#task-settings-tab").click();
    await page.locator("#task-setting-tries").fill("9");
    await page.evaluate(() => { fixtureTasks[1].settingsRevision = "10"; });
    await page.locator("#task-settings-save").click();
    await page.waitForFunction(() => taskDetailDrafts.get(2)?.message.includes("\u8349\u7a3f"));
    assert.equal(await page.locator("#task-setting-tries").inputValue(), "9");
    await page.screenshot({ path: path.join(screenshots, `settings-${width}-${colorScheme}.png`) });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !nativeDetailOpen);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${width} ${colorScheme}: details layout, actions, drafts, hide/reopen, stale reads, conflicts and keyboard OK`);
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
