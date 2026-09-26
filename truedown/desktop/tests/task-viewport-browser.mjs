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
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/tasks") {
    const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
    requests.push({ offset, limit });
    const search = url.searchParams.get("search") || "";
    const filtered = tasks.filter(task => task.name.includes(search));
    response.setHeader("Content-Type", "application/json");
    response.setHeader("ETag", `"${revision}-${offset}-${search}"`);
    response.end(JSON.stringify({ tasks: filtered.slice(offset, offset + limit), total: filtered.length, groups,
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
    const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: "dark", reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => currentTotal === 2400);
    assert.equal(await page.locator(".pagination, .metric-strip").count(), 0);
    assert.equal(await page.locator(".task-rows tr").count(), 100);
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
