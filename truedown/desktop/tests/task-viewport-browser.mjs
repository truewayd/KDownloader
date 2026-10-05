import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { readUIFixtureAsset } from "./ui-fixture-assets.mjs";

const assets = new URL("../../web/", import.meta.url);
const output = path.resolve(process.argv[2] || "../dist/task-viewport-review");
const groups = { revision: 1, groups: [{ id: "video", name: "Video", extensions: [".mp4"] }, { id: "other", name: "Other", extensions: [] }] };
const tasks = Array.from({ length: 2400 }, (_, index) => ({ id: index + 1, name: `Movie ${index + 1}.mp4`, outputName: `Movie ${index + 1}.mp4`, category: "video", status: index === 0 ? "downloading" : index === 1 ? "error" : "done", totalLength: 1024000, completedLength: 512000, downloadSpeed: 4096, link: `https://example.test/${index + 1}`, folder: "Downloads" }));
const requests = [];
let revision = 1;
let pendingReads = null;
let blockedOffset = null;
const changeWaiters = new Set();
const server = http.createServer(async (request, response) => {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/tasks/changes") {
    if (Number(url.searchParams.get("after")) === revision) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); changeWaiters.delete(done); resolve(); };
      const timer = setTimeout(done, 10000);
      changeWaiters.add(done);
      response.once("close", done);
    });
    response.end(JSON.stringify({ revision }));
    return;
  }
  if (url.pathname === "/tasks") {
    const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
    requests.push({ offset, limit });
    if (pendingReads && (blockedOffset === null || offset === blockedOffset)) await pendingReads;
    const search = url.searchParams.get("search") || "";
    const filtered = tasks.filter(task => task.name.includes(search));
    response.setHeader("Content-Type", "application/json");
    response.setHeader("ETag", `"${revision}-${offset}-${search}"`);
    response.end(JSON.stringify({ tasks: filtered.slice(offset, offset + limit), total: filtered.length, groups, revision, epoch: "fixture", orderVersion: "fixed-order",
      summary: { total: tasks.length, downloading: 1, error: 1, done: tasks.length - 2, downloadSpeed: revision * 4096, groupCounts: { video: tasks.length } } }));
    return;
  }
  if (url.pathname === "/system/update") { response.end('{"trueDown":{},"engine":{}}'); return; }
  if (url.pathname === "/settings/file-groups") { response.end(JSON.stringify(groups)); return; }
  const name = url.pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" }[name.split(".").at(-1)]);
    response.end(await readUIFixtureAsset(name, assets));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  await fs.mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true });
  for (const width of [1200, 960, 390]) {
    const reducedMotion = width === 960;
    const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: width === 1200 ? "light" : "dark", reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => currentTotal === 2400);
    if (width === 1200) {
      let release;
      blockedOffset = 0;
      pendingReads = new Promise(resolve => { release = resolve; });
      const before = requests.length;
      await page.evaluate(() => { void loadTasks(); });
      await page.waitForFunction(() => taskLoadTarget !== null);
      const start = performance.now();
      await page.locator("#tasks-wrap").evaluate(node => { node.scrollTop = 600 * 64; });
      await page.waitForFunction(() => currentTasks[0]?.id > 500, null, { timeout: 1500 });
      console.log(`latest viewport painted in ${Math.round(performance.now() - start)}ms while the old request remained blocked`);
      assert.ok(requests.length > before);
      pendingReads = null; blockedOffset = null; release();
      await page.locator("#tasks-wrap").evaluate(node => { node.scrollTop = 0; });
      await page.waitForFunction(() => currentTasks[0]?.id === 1 && loadTasksPromise === null);
      await page.waitForFunction(() => taskChangePromise !== null);
      const changeStart = performance.now();
      revision++;
      tasks[0].completedLength += 100;
      for (const done of changeWaiters) done();
      await page.waitForFunction(value => currentTasks[0]?.completedLength === value, tasks[0].completedLength, { timeout: 1500 });
      console.log(`backend change painted in ${Math.round(performance.now() - changeStart)}ms without waiting for the 2500ms poll`);
    }
    assert.equal(await page.locator(".pagination, .metric-strip").count(), 0);
    assert.equal(await page.locator(".task-rows tr").count(), 100);
    assert.equal(await page.locator(".task-index, .col-index").count(), 0);
    assert.equal(await page.locator(".tasks-table thead th").count(), 8);
    assert.equal(await page.locator(".task-rows tr").first().locator("td").count(), 8);
    assert.equal(await page.locator(".task-spacer td").first().getAttribute("colspan"), "8");
    const firstCheckbox = page.locator(".task-rows [data-select-task]").first();
    await firstCheckbox.check();
    assert.equal(await page.evaluate(() => selectedTaskIDs.has(currentTasks[0].id)), true, "selection keeps using the task ID without a visible ordinal");
    await firstCheckbox.uncheck();
    assert.equal(await page.locator('[data-task-category="video"] .nav-count').textContent(), "2400");
    assert.equal(await page.locator("#active-count").textContent(), "1");
    assert.equal(await page.locator("#error-count").textContent(), "1");
    assert.equal(await page.locator("#retry-all-btn").isVisible(), width === 1200);
    assert.equal(await page.locator("#clear-done-btn").isVisible(), width === 1200);
    for (const selector of ["#task-search", "#task-filter", "#pause-queue-btn", "#resume-queue-btn", "#open-downloads-btn"]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${width}: unreachable ${selector}`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const height = await page.locator(".task-rows tr").first().evaluate(row => row.getBoundingClientRect().height);
    assert.equal(height, 64, "virtual offsets must match actual row heights");
    await page.screenshot({ path: path.join(output, `workspace-${width}.png`) });
    await page.evaluate(() => taskPages.invalidate());
    let releaseReads;
    pendingReads = new Promise(resolve => { releaseReads = resolve; });
    const beforeScroll = requests.length;
    // Events keep arriving faster than the former 80 ms trailing debounce.
    await page.evaluate(async () => {
      for (let index = 0; index < 12; index++) {
        els.tasksWrap.scrollTop = (600 + index) * 64;
        await new Promise(resolve => setTimeout(resolve, 20));
        if (index === 5) window.requestedDuringScroll = currentOffset;
      }
    });
    assert.ok(await page.evaluate(() => requestedDuringScroll > 500), "continuous scrolling must request rows before stopping");
    assert.ok(requests.length > beforeScroll);
    assert.equal(await page.locator(".task-rows tr").count(), 100, "unloaded range must not allocate task nodes");
    const placeholder = await page.evaluate(() => {
      const wrap = els.tasksWrap.getBoundingClientRect();
      const node = document.elementFromPoint(wrap.x + wrap.width / 2, wrap.y + wrap.height / 2);
      const cell = node.closest(".task-spacer td");
      return cell && { image: getComputedStyle(cell).backgroundImage, size: getComputedStyle(cell).backgroundSize,
        hidden: cell.closest("tbody").getAttribute("aria-hidden"), controls: cell.querySelectorAll("button, input, a").length };
    });
    assert.ok(placeholder?.image.includes("data:image/svg+xml"), `slow reads must expose skeleton rows instead of blank space: ${JSON.stringify({ placeholder, errors })}`);
    assert.equal(placeholder.size, "100% 64px");
    assert.equal(placeholder.hidden, "true");
    assert.equal(placeholder.controls, 0);
    const imageSource = decodeURIComponent(placeholder.image);
    assert.equal(imageSource.includes('<animate attributeName="x1"'), !reducedMotion, "gradient anchors move only when motion is allowed");
    const geometry = await page.evaluate(() => {
      const table = document.querySelector(".tasks-table"), row = table.querySelector(".task-rows tr");
      const svg = decodeURIComponent(table.style.getPropertyValue("--task-placeholder-static"));
      const bounds = row.getBoundingClientRect();
      const icon = row.querySelector(".task-file-cell > .icon").getBoundingClientRect();
      return { svg, x: Math.round((icon.x - bounds.x) * 10) / 10, width: Math.round(icon.width * 10) / 10 };
    });
    assert.ok(geometry.svg.includes(`x="${geometry.x}"`), "placeholder icon follows the actual column position");
    assert.ok(geometry.svg.includes(`width="${geometry.width}"`), "placeholder icon retains the real icon surface size");
    const firstFrame = await page.locator("#tasks-wrap").screenshot({ path: path.join(output, `workspace-${width}-loading.png`) });
    await page.waitForTimeout(400);
    const secondFrame = await page.locator("#tasks-wrap").screenshot();
    assert.equal(firstFrame.equals(secondFrame), reducedMotion, "skeleton pixels animate unless reduced motion is requested");
    await page.locator("#tasks-wrap").evaluate(node => { node.scrollTop = 0; });
    await page.waitForFunction(() => currentOffset === 0);
    pendingReads = null;
    releaseReads();
    await page.waitForFunction(() => loadTasksPromise === null && currentTasks[0]?.id === 1);
    assert.equal(await page.locator("#tasks-wrap").evaluate(node => node.scrollTop), 0, "late responses must not move a returned viewport");
    await page.locator("#tasks-wrap").evaluate(node => { node.scrollTop = 600 * 64; });
    await page.waitForFunction(() => currentOffset > 500 && currentTasks[0]?.id > 500);
    assert.equal(await page.locator(".task-rows tr").count(), 100);
    const at = await page.evaluate(() => ({ offset: currentOffset, top: els.tasksWrap.scrollTop }));
    assert.ok(at.top >= 600 * 64 - 1, "loading a new window must preserve scroll position");
    await page.evaluate(() => { window.retainedRow = document.querySelector('.task-rows tr'); });
    revision++;
    await page.evaluate(() => refreshAndSchedule(true));
    assert.equal(await page.evaluate(() => retainedRow === document.querySelector('.task-rows tr')), true, "polling must reuse task nodes");
    await page.locator("#tasks-wrap").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.waitForFunction(() => currentTasks.at(-1)?.id === 2400);
    assert.equal(await page.locator(".task-rows tr").last().getAttribute("aria-rowindex"), "2401");
    await page.locator("#task-search").fill("Movie 2400.mp4");
    await page.waitForFunction(() => currentTotal === 1);
    assert.equal(await page.locator("#tasks-wrap").evaluate(node => node.scrollTop), 0);
    assert.equal(await page.locator('[data-task-category="video"] .nav-count').textContent(), "2400", "filter must not change group totals");
    assert.equal(await page.locator("#active-count").textContent(), "1", "filter must not change global activity");
    await page.locator("#workspace-notice-action").click();
    await page.waitForFunction(() => currentTotal === 2400 && currentSearch === "");
    assert.equal(await page.locator("#task-search").inputValue(), "");
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${width}: full-range virtual scrolling, bounded DOM, incremental rows, global counts and toolbar passed`);
  }
  assert.ok(requests.every(request => request.limit <= 100), "reads must remain bounded");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
