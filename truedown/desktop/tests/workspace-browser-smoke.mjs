// Real browser acceptance with local task responses; never starts an engine.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { assertToastPlacement } from "./toast-layout.mjs";

const assets = new URL("../../web/", import.meta.url);
const screenshots = process.argv[2] || await fs.mkdtemp(path.join(os.tmpdir(), "truedown-workspace-"));
await fs.mkdir(screenshots, { recursive: true });
let revision = 0;
const tasks = [
  { id: 1, status: "downloading", outputName: "Ocean - episode 01.mp4" },
  { id: 2, status: "paused", outputName: "Illustration collection.zip" },
  { id: 3, status: "done", outputName: "Reference images.tar" },
  { id: 4, status: "error", outputName: "Architecture study.blend", error: "Server returned 503" },
  ...Array.from({ length: 16 }, (_, index) => ({ id: index + 5, status: "queued", outputName: `Project archive ${index + 1}.zip` })),
].map(task => ({ ...task, folder: "C:\\Downloads", link: `https://example.test/downloads/${task.id}` }));
const summary = { total: tasks.length, downloading: 1, paused: 1, done: 1, error: 1, queued: 16 };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/tasks") {
    revision += 1;
    const status = url.searchParams.get("status") || "all";
    const search = url.searchParams.get("search")?.toLowerCase() || "";
    const filtered = tasks.filter(task => (status === "all" || task.status === status) && task.outputName.toLowerCase().includes(search));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ tasks: filtered.map(task => ({ ...task, progress: task.status === "downloading" ? `${revision}% - 4.2 MiB/s` : "-" })), total: filtered.length, summary }));
    return;
  }
  if (url.pathname === "/system/logs") { response.end("TrueDown workspace acceptance fixture\nEngine connected\n"); return; }
  if (url.pathname === "/system/info") { response.end(JSON.stringify({ version: "dev", buildNumber: 0, commit: "unknown" })); return; }
  if (url.pathname === "/system/update") { response.end(JSON.stringify({ engine: { active: "next", activeVersion: "2.7.2" } })); return; }
  const name = url.pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    const type = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" }[name.split(".").at(-1)];
    response.setHeader("Content-Type", `${type}; charset=utf-8`);
    response.end(await fs.readFile(new URL(name, assets)));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of process.argv.includes("--about-only") ? [] : [1080, 390]) {
    for (const colorScheme of ["light", "dark"]) {
      for (const deviceScaleFactor of [1, 2]) {
        const native = width > 720;
        const height = native ? 760 : 700;
        const name = `${native ? "native" : "mobile"}-${colorScheme}-${deviceScaleFactor * 100}`;
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, colorScheme });
        if (native) await context.addInitScript(() => {
          window.__TRUEDOWN_PLATFORM__ = "windows";
          window.nativeCalls = [];
          window.__TAURI__ = { core: { invoke: async (command, args) => {
            nativeCalls.push({ command, args });
            if (command === "apply_material") return false;
            if (command === "frame_state") return { maximized: false };
            if (command !== "core_request") return;
            const response = await fetch(args.request.path);
            return { status: response.status, owned: true, headers: {}, body: await response.text() };
          } } };
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(origin);
        await page.waitForFunction(count => document.querySelectorAll("tr[data-task-id]").length === count, tasks.length);
        await assertToastPlacement(page, path.join(screenshots, `${name}-toast`));
        assert.equal(await page.title(), "下载任务");
        assert.equal(await page.locator("#exit-truedown-btn").count(), 0);
        assert.ok((await page.locator("#tasks-title").boundingBox()).width <= 1);
        if (native) assert.equal(await page.locator(".native-window-title").isVisible(), false);
        if (native) {
          assert.equal(await page.locator(".native-titlebar").count(), 1);
          const sidebar = await page.locator(".sidebar").boundingBox();
          assert.ok(sidebar.y >= 0);
          for (const selector of [".sidebar-toggle", ".brand"]) assert.ok(await page.locator(selector).evaluate(element => {
            const box = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          }));
        }
        assert.equal(await page.locator('[data-native-window="about"]').count(), 0);
        const geometry = await page.evaluate(() => {
          const bounds = selector => {
            const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect();
            return { x, y, width, height, right, bottom };
          };
          return { rootWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, width: innerWidth, height: innerHeight, sidebar: bounds(".sidebar"), main: bounds(".dashboard"), footer: bounds(".sidebar-footer"), toolbar: bounds(".task-toolbar"), query: bounds(".task-controls"), table: bounds(".table-scroll") };
        });
        await page.screenshot({ path: path.join(screenshots, `${name}.png`) });
        await fs.writeFile(path.join(screenshots, `${name}.json`), JSON.stringify(geometry, null, 2));
        assert.ok(geometry.rootWidth <= width + 1 && geometry.bodyWidth <= width + 1, `${name}: horizontal page overflow ${JSON.stringify(geometry)}`);
        assert.ok(geometry.sidebar.right <= geometry.main.x + 1, `${name}: sidebar overlaps content`);
        assert.ok(geometry.footer.bottom <= height + 1, `${name}: bottom utilities are outside the viewport`);
        for (const selector of ["#new-task-btn", "#settings-btn", "#batch-task-btn", "#task-search", "#task-filter"]) {
          const reachable = await page.locator(selector).evaluate(element => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.x >= 0 && box.right <= innerWidth && box.y >= 0 && box.bottom <= innerHeight && element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          });
          assert.ok(reachable, `${name}: ${selector} cannot be reached without scrolling`);
        }
        assert.equal(await page.locator('[data-task-filter]:not([data-task-filter="all"])').count(), 0, "status navigation is owned by the dropdown");
        await page.locator("#task-filter").selectOption("done");
        await page.waitForFunction(() => document.querySelectorAll("tr[data-task-id]").length === 1 && document.querySelector("#task-filter").value === "done");
        assert.equal(await page.locator("#tasks-title").textContent(), "已完成");
        await page.locator("#task-filter").selectOption("paused");
        await page.waitForFunction(() => document.querySelector("#tasks-title").textContent === "已暂停");
        await page.locator('[data-task-filter="all"]').click();
        await page.waitForFunction(count => document.querySelectorAll("tr[data-task-id]").length === count, tasks.length);
        for (const order of ["asc", "desc"]) {
          await page.locator('[data-sort-field="file"]').click();
          await page.waitForFunction(expected => document.querySelector('[data-sort-field="file"]').dataset.sortOrder === expected, order);
          assert.equal(await page.locator('[data-sort-field="file"] use').getAttribute("href"), `/icons.svg#icon-arrow-${order === "asc" ? "up" : "down"}`);
        }
        if (native) {
          await page.locator(".sidebar-toggle").click();
          assert.equal(await page.locator(".sidebar-toggle").getAttribute("aria-expanded"), "false");
          const sidebar = await page.locator(".sidebar").boundingBox();

          const accessibility = await page.locator(".sidebar").ariaSnapshot();
          for (const label of ["全部下载", "设置", "新建下载"]) assert.ok(accessibility.includes(label), `${name}: collapsed sidebar lost ${label}`);
          await page.screenshot({ path: path.join(screenshots, `${name}-collapsed.png`) });
          await page.locator(".sidebar-toggle").click();
          for (const kind of ["settings"]) await page.locator(`[data-route="${kind}"]`).click();
          assert.deepEqual(await page.evaluate(() => nativeCalls.filter(call => call.command === "open_auxiliary").map(call => call.args.kind)), ["settings"]);
          assert.equal(await page.locator("#tasks-page").isVisible(), true);
        }
        const checkbox = page.locator('tr[data-task-id="1"] [data-select-task]');
        await checkbox.focus();
        const before = await page.locator('tr[data-task-id="1"] .progress-line').textContent();
        await page.evaluate(() => { window.focusedTaskCheckbox = document.activeElement; });
        await page.waitForFunction(previous => document.querySelector('tr[data-task-id="1"] .progress-line').textContent !== previous, before, { timeout: 6000 });
        assert.equal(await page.evaluate(() => document.activeElement === focusedTaskCheckbox && focusedTaskCheckbox.isConnected), true, `${name}: task polling replaced focused row control`);
        const tableBox = await page.locator(".table-scroll").boundingBox();
        await page.mouse.move(tableBox.x + 70, Math.min(tableBox.y + 70, height - 40));
        if (!native) {
          await page.mouse.wheel(1600, 0);
          await page.waitForFunction(() => document.querySelector(".table-scroll").scrollLeft > 0);
          const action = await page.locator('tr[data-task-id="1"] [data-action="remove"]').boundingBox();
          assert.ok(action.x >= tableBox.x && action.x + action.width <= tableBox.x + tableBox.width, `${name}: horizontal wheel cannot expose row actions`);
        }
        await page.mouse.wheel(0, 1600);
        await page.waitForFunction(() => document.querySelector(".table-scroll").scrollTop > 0 || document.querySelector(".task-panel").scrollTop > 0);
        assert.deepEqual(errors, [], `${name}: JavaScript errors`);
        console.log(`${name}: navigation, utilities, accessibility, focus-preserving polling, wheel and bounds OK`);
        await context.close();
      }
    }
  }
  for (const platform of ["windows", "macos", "linux"]) {
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 480, height: 360 }, colorScheme, deviceScaleFactor: 2 });
      await context.addInitScript(platform => {
        window.__TRUEDOWN_PLATFORM__ = platform;
        window.nativeCalls = [];
        window.__TAURI__ = { core: { invoke: async (command, args) => {
          nativeCalls.push({ command, args });
          if (command === "apply_material") return false;
          if (command === "frame_state") return { maximized: false };
          if (command === "desktop_state") return { owned: true };
          if (command !== "core_request") return;
          const response = await fetch(args.request.path);
          return { status: response.status, body: await response.text() };
        } } };
      }, platform);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/?window=settings#settings/about`);
      await page.waitForFunction(() => document.querySelector("#about-build").textContent !== "正在读取…");
      assert.equal(await page.locator('[data-settings-link="about"]').getAttribute("aria-current"), "page");
      for (const [width, height] of [[480, 360], [400, 320]]) {
        await page.setViewportSize({ width, height });
        await assertToastPlacement(page);
        assert.ok(await page.evaluate(() => {
          const panel = document.querySelector(".settings-content").getBoundingClientRect();
          const header = document.querySelector(".native-titlebar")?.getBoundingClientRect() || { bottom: 0 };
          return document.documentElement.scrollWidth <= innerWidth && panel.y >= header.bottom && panel.bottom <= innerHeight;
        }), `${platform} About must fit at ${width} x ${height}`);
        await page.screenshot({ path: path.join(screenshots, `about-${platform}-${colorScheme}-${width}.png`) });
      }
      for (const shortcut of ["Escape", platform === "macos" ? "Meta+w" : "Control+w"]) await page.keyboard.press(shortcut);
      assert.equal(await page.evaluate(() => nativeCalls.filter(call => call.command === "close_auxiliary").length), 2, "About retains window close shortcuts");
      assert.equal(await page.locator("[data-window-action]").count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`about-${platform}-${colorScheme}: compact layout, caption close and keyboard dismissal OK`);
    }
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
