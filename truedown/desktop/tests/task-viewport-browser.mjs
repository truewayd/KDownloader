import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { readUIFixtureAsset } from "./ui-fixture-assets.mjs";

const assets = new URL("../../web/", import.meta.url);
const output = path.resolve(process.argv[2] || "../dist/task-viewport-review");
const groups = { revision: 1, groups: [{ id: "video", name: "Video", extensions: [".mp4"] }, { id: "other", name: "Other", extensions: [] }] };
const tasks = Array.from({ length: 2400 }, (_, index) => ({ id: index + 1, name: `Movie ${index + 1}.mp4`, outputName: `Movie ${index + 1}.mp4`, category: "video", status: ["downloading", "error", "queued", "paused"][index] || "done", totalLength: 1024000, completedLength: 512000, downloadSpeed: 4096, link: `https://example.test/${index + 1}`, folder: "Downloads" }));
for (const [index, name] of ["example.exe", "PROMO WWWW artwork FINAL PACK.png", "软件安装包-版本２０２６-测试示例.exe"].entries()) {
  Object.assign(tasks[index], { name, outputName: name });
}
Object.assign(tasks[0], { totalLength: 1023.9 * 1024 ** 3, downloadSpeed: 1023.9 * 1024 ** 2, createdAt: "2026-11-22T02:00:00Z" });
const requests = [];
let revision = 1;
let rowsRevision = 1;
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
    const rowsVersion = JSON.stringify([rowsRevision, offset, limit, search]);
    const rowsUnchanged = url.searchParams.get("rowsVersion") === rowsVersion;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("ETag", `"${revision}-${offset}-${search}"`);
    response.end(JSON.stringify({ tasks: rowsUnchanged ? undefined : filtered.slice(offset, offset + limit), rowsVersion, rowsUnchanged, total: filtered.length, groups, revision, epoch: "fixture", orderVersion: "fixed-order",
      summary: { total: tasks.length, downloading: 1, error: 1, paused: 1, queued: 1, done: tasks.length - 4, downloadSpeed: revision * 4096, groupCounts: { video: tasks.length } } }));
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
    let finishInitialRead;
    pendingReads = new Promise(resolve => { finishInitialRead = resolve; });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelector('#tasks-wrap .kd-page-placeholder')?.childElementCount === 4);
    assert.equal(await page.locator("#tasks-wrap .empty-state").isVisible(), false, "an unread task list must not claim it is empty");
    assert.equal(await page.locator('#tasks-wrap .kd-page-placeholder[data-variant="list"]').isVisible(), true);
    finishInitialRead(); pendingReads = null;
    await page.waitForFunction(() => currentTotal === 2400);
    await page.waitForFunction(() => document.querySelector(".task-rows td-file-name")?.shadowRoot?.textContent);
    const filenames = await page.locator(".task-rows td-file-name").evaluateAll(nodes => nodes.slice(0, 3).map(node => {
      const range = document.createRange();
      range.selectNodeContents(node.shadowRoot);
      return { name: node.textContent, displayed: node.shadowRoot.textContent,
        renderedWidth: range.getBoundingClientRect().width, available: node.getBoundingClientRect().width };
    }));
    assert.equal(filenames[0].displayed, "example.exe");
    for (const file of filenames) {
      assert.ok(file.displayed.endsWith(file.name.slice(file.name.lastIndexOf("."))));
      assert.ok(file.renderedWidth <= file.available, `${width}px: filename clipped: ${JSON.stringify(file)}`);
    }
    const sampleName = page.locator(".task-rows td-file-name").first();
    await sampleName.evaluate(node => {
      const sample = document.createTextNode("ex…le.exe");
      node.shadowRoot.append(sample);
      const range = document.createRange();
      range.selectNodeContents(sample);
      node.style.width = Math.ceil(range.getBoundingClientRect().width) + "px";
      sample.remove();
    });
    await page.waitForFunction(() => document.querySelector(".task-rows td-file-name").shadowRoot.textContent === "ex…le.exe");
    await sampleName.evaluate(node => node.style.removeProperty("width"));
    await page.waitForFunction(() => document.querySelector(".task-rows td-file-name").shadowRoot.textContent === "example.exe");
    let englishStatusWidth;
    for (const language of ["en", "zh-CN"]) {
      await page.evaluate(language => window.TrueDownI18n.setLanguage(language), language);
      await page.waitForFunction(label => document.querySelector('[data-sort-field="created"]').textContent.trim() === label,
        language === "en" ? "Date added" : "添加时间");
      const clipped = await page.locator(".tasks-table .sort-button").evaluateAll(buttons => buttons.filter(button => {
        const range = document.createRange();
        range.selectNodeContents(button.firstChild);
        const label = range.getBoundingClientRect(), icon = button.lastElementChild.getBoundingClientRect();
        const box = button.getBoundingClientRect();
        return Math.min(label.left, icon.left) < box.left - 0.1 || Math.max(label.right, icon.right) > box.right + 0.1;
      }).map(button => button.textContent.trim()));
      assert.deepEqual(clipped, [], `${width}px: clipped ${language} headings`);
      const clippedValues = await page.locator(".task-rows tr:first-child :is(.task-size, .task-speed, .task-remaining, .task-created), .task-rows tr:nth-child(5) .row-actions").evaluateAll(cells =>
        cells.filter(cell => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          const content = range.getBoundingClientRect(), bounds = cell.getBoundingClientRect();
          return content.left < bounds.left || content.right > bounds.right;
        }).map(cell => cell.className));
      assert.deepEqual(clippedValues, [], `${width}px: clipped ${language} task values or actions`);
      if (language === "en") englishStatusWidth = await page.locator(".task-heading-status").evaluate(node => node.offsetWidth);
    }
    assert.equal(await page.locator("#tasks-wrap .kd-page-placeholder").isVisible(), false);
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
      rowsRevision++;
      tasks[0].completedLength += 100;
      for (const done of changeWaiters) done();
      await page.waitForFunction(value => currentTasks[0]?.completedLength === value, tasks[0].completedLength, { timeout: 1500 });
      console.log(`backend change painted in ${Math.round(performance.now() - changeStart)}ms without waiting for the 2500ms poll`);
      await page.waitForFunction(() => taskChangePromise !== null && loadTasksPromise === null);
      await page.evaluate(() => { window.renderedTasks = currentTasks; });
      revision++;
      for (const done of changeWaiters) done();
      await page.waitForFunction(expected => taskRenderedRevision === expected, revision);
      assert.equal(await page.evaluate(() => currentTasks === window.renderedTasks && currentSummary.downloadSpeed === taskRenderedRevision * 4096), true,
        "summary-only refresh keeps the rendered row array and updates queue metrics");
    }
    assert.equal(await page.locator(".pagination, .metric-strip").count(), 0);
    assert.equal(await page.locator(".task-rows tr").count(), 100);
    assert.equal(await page.locator(".task-index, .col-index").count(), 0);
    assert.equal(await page.locator(".tasks-table thead th:visible").count(), 9);
    assert.equal(await page.locator(".task-rows tr").first().locator("td:visible").count(), 9);
    assert.equal(await page.locator(".spacer-data").first().getAttribute("colspan"), "7");
    const statusFits = label => label.scrollWidth <= label.clientWidth
      && getComputedStyle(label).whiteSpace === "nowrap";
    assert.ok(await page.locator(".status-label").evaluateAll(labels => labels.every(label =>
      label.scrollWidth <= label.clientWidth && getComputedStyle(label).whiteSpace === "nowrap")));
    const firstCheckbox = page.locator(".task-rows [data-select-task]").first();
    await firstCheckbox.check();
    assert.equal(await page.evaluate(() => selectedTaskIDs.has(currentTasks[0].id)), true, "selection keeps using the task ID without a visible ordinal");
    if (width === 1200) {
      const fileHeading = page.locator('[data-sort-field="file"]');
      const statusHeading = page.locator('[data-sort-field="status"]');
      const start = await fileHeading.boundingBox(), target = await statusHeading.boundingBox();
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x + target.width - 3, target.y + target.height / 2, { steps: 8 });
      await page.waitForSelector('[data-task-column="status"][data-column-drop="after"]');
      await page.mouse.up();
      assert.equal(await page.locator("[data-task-column]").first().getAttribute("data-task-column"), "status");
      assert.equal(await page.locator(".tasks-table col").nth(1).getAttribute("class"), "col-status");
      assert.equal(await page.locator('.task-rows tr').first().locator('td').nth(1).locator('.status-badge').count(), 1);
      assert.equal(await firstCheckbox.isChecked(), true);
      assert.equal(await page.evaluate(() => currentSort + ":" + currentSortOrder), "status:asc", "dragging a column must not sort the tasks");
      await statusHeading.press("Alt+ArrowRight");
      assert.equal(await page.locator("[data-task-column]").first().getAttribute("data-task-column"), "file");
      assert.equal(await statusHeading.evaluate(button => button === document.activeElement), true);
      await statusHeading.press("Alt+ArrowLeft");
      await statusHeading.click();
      assert.equal(await page.evaluate(() => currentSort + ":" + currentSortOrder), "status:desc", "clicking a heading still sorts tasks");
      const resizer = page.locator(".task-heading-status .task-resizer");
      assert.equal(await resizer.evaluate(node => getComputedStyle(node).cursor), "col-resize");
      const handle = await resizer.boundingBox();
      const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
      const initial = await statusHeading.evaluate(node => node.closest("th").offsetWidth);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 80, y, { steps: 5 });
      await page.mouse.up();
      assert.equal(await statusHeading.evaluate(node => node.closest("th").offsetWidth), initial + 80);
      await resizer.press("ArrowLeft");
      assert.equal(await statusHeading.evaluate(node => node.closest("th").offsetWidth), initial + 72);
      const cancelHandle = await resizer.boundingBox();
      await page.mouse.move(cancelHandle.x + 4, y);
      await page.mouse.down();
      await page.mouse.move(cancelHandle.x + 40, y);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      assert.equal(await statusHeading.evaluate(node => node.closest("th").offsetWidth), initial + 72);
      assert.equal(await page.evaluate(() => currentSort + ":" + currentSortOrder), "status:desc");
      await statusHeading.click({ button: "right" });
      const progressItem = page.getByRole("menuitemcheckbox", { name: "进度", exact: true });
      assert.equal(await progressItem.isChecked(), true);
      const fixedActions = page.getByRole("menuitemcheckbox", { name: "操作", exact: true });
      assert.equal(await fixedActions.isChecked(), true);
      assert.equal(await fixedActions.isDisabled(), true);
      assert.equal(await page.getByRole("menuitemcheckbox").last().textContent(), "操作");
      await progressItem.click();
      assert.equal(await page.locator(".task-rows .task-progress").first().isVisible(), false);
      assert.equal(await page.locator(".spacer-data").first().getAttribute("colspan"), "6");
      assert.equal(await firstCheckbox.isChecked(), true);
      const reopened = await context.newPage();
      await reopened.goto(page.url());
      await reopened.evaluate(() => window.TrueDownI18n.setLanguage("en"));
      await reopened.waitForFunction(() => document.querySelector(".status-done")?.textContent === "Done");
      for (const [status, label] of Object.entries({ downloading: "Downloading", error: "Error", paused: "Paused", queued: "Queued", done: "Done" })) {
        const text = reopened.locator(`.status-${status} .status-label`).first();
        assert.equal(await text.textContent(), label);
        assert.equal(await text.evaluate(statusFits), true, `${label} fits on one line`);
      }
      assert.equal(await reopened.locator("[data-task-column]").first().getAttribute("data-task-column"), "status");
      const savedStatus = reopened.locator('[data-sort-field="status"]');
      assert.equal(await savedStatus.evaluate(node => node.closest("th").offsetWidth), initial + 72);
      assert.equal(await reopened.locator(".task-heading-progress").isVisible(), false);
      await savedStatus.press("Shift+F10");
      const unchecked = reopened.getByRole("menuitemcheckbox", { name: "Progress", exact: true });
      assert.equal(await unchecked.isChecked(), false);
      assert.equal(await unchecked.locator(".icon").isVisible(), false);
      await unchecked.click();
      assert.equal(await reopened.locator(".task-heading-progress").isVisible(), true);
      await savedStatus.click({ button: "right" });
      await reopened.locator('[data-menu-action="columns-auto"]').click();
      assert.equal(await savedStatus.evaluate(node => node.closest("th").offsetWidth), englishStatusWidth);
      await statusHeading.click({ button: "right" });
      await page.screenshot({ path: path.join(output, "task-header-menu.png") });
      await page.locator('[data-menu-action="column-show-progress"]').click();
      await statusHeading.click({ button: "right" });
      await page.locator('[data-menu-action="columns-auto"]').click();
      assert.equal(await reopened.locator('.task-rows tr').first().locator('td').nth(1).locator('.status-badge').count(), 1);
      await reopened.route("**/i18n-en.js", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: await response.text() + '\nwindow.TrueDownEnglish = { ...window.TrueDownEnglish, "下载中": "Downloading Downloading" };' });
      });
      await reopened.setViewportSize({ width: 390, height: 800 });
      await reopened.reload();
      await reopened.evaluate(() => window.TrueDownI18n.setLanguage("en"));
      const longLabel = reopened.locator(".status-downloading .status-label").first();
      await reopened.waitForFunction(() => document.querySelector(".status-downloading .status-label")?.textContent === "Downloading Downloading");
      assert.equal(await longLabel.evaluate(label =>
        label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === "ellipsis"), true);
      assert.equal(await reopened.locator(".status-downloading").first().getAttribute("data-tooltip"), "Downloading Downloading");
      assert.equal(await reopened.locator(".task-rows tr").first().evaluate(row => row.getBoundingClientRect().height), 64);
      await reopened.evaluate(() => window.TrueDownI18n.setLanguage("zh-CN"));
      await reopened.close();
    }
    await page.evaluate(() => { writeClipboard = async text => { window.copiedLinks = text; }; });
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
    const scroll = page.locator("#tasks-wrap");
    const expectShadows = (left, right) => page.waitForFunction(([left, right]) =>
      [[".select-cell", "::after", left], [".task-actions-cell", "::before", right]].every(([selector, pseudo, visible]) =>
        ["thead", ".task-rows", ".task-spacer"].every(section => {
          const cell = document.querySelector(`${section} ${selector}`);
          const shade = getComputedStyle(cell, pseudo);
          return (shade.content !== "none") === visible && getComputedStyle(cell).boxShadow === "none"
            && (!visible || (shade.backgroundImage.includes("linear-gradient") && shade.pointerEvents === "none"));
        })), [left, right]);
    if (await scroll.evaluate(node => node.scrollWidth > node.clientWidth)) {
      const positions = () => page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().left;
        return [box("thead .select-cell"), box(".task-rows .select-cell"), box(".task-actions-heading"), box(".task-rows .row-actions"), box(".task-heading-file")];
      });
      const before = await positions();
      const pinnedHeadingsAreOnTop = () => page.evaluate(() =>
        [".select-cell", ".task-actions-heading"].every(selector => {
          const heading = document.querySelector(`thead ${selector}`);
          const rect = heading.getBoundingClientRect();
          return heading.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        }));
      assert.equal(await pinnedHeadingsAreOnTop(), true);
      await expectShadows(false, true);
      await scroll.evaluate(node => { node.scrollLeft = (node.scrollWidth - node.clientWidth) / 2; });
      await expectShadows(true, true);
      if (width === 960) {
        const { x, y, width: clipWidth } = await scroll.boundingBox();
        for (const colorScheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme });
          await page.screenshot({ path: path.join(output, `pinned-shadows-${colorScheme}.png`), clip: { x, y, width: clipWidth, height: 230 } });
        }
      }
      await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; });
      await expectShadows(true, false);
      const after = await positions();
      assert.deepEqual(after.slice(0, 4), before.slice(0, 4), "selection and actions stay pinned");
      assert.equal(await pinnedHeadingsAreOnTop(), true);
      assert.ok(after[4] < before[4], "data columns scroll between the pinned edges");
      const corner = page.locator(".tasks-table thead th:last-child");
      const bounds = await corner.boundingBox();
      await scroll.evaluate(node => { node.scrollTop = 480; });
      assert.deepEqual(await corner.boundingBox(), bounds, "Actions stays in the top right on both axes");
      assert.equal(await pinnedHeadingsAreOnTop(), true);
      assert.equal(await page.locator(".task-rows tr").first().locator("td:last-child .row-actions").count(), 1);
      await scroll.evaluate(node => { node.scrollTo(0, 0); });
    } else if (width === 1200) {
      await expectShadows(false, false);
      assert.equal(await scroll.evaluate(node => node.scrollWidth), await scroll.evaluate(node => node.clientWidth));
    }
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
    assert.equal(placeholder.size, `${await page.locator(".tasks-table").evaluate(node => node.offsetWidth)}px 64px`);
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
    const nextSelection = await page.locator('.task-rows [data-select-task]').first().getAttribute("value");
    await page.locator('.task-rows [data-select-task]').first().check();
    await page.locator("#batch-copy-btn").click();
    assert.equal(await page.evaluate(() => copiedLinks), `https://example.test/1\nhttps://example.test/${nextSelection}`, "copy includes selected tasks outside the virtual viewport");
    await page.locator("#batch-clear-btn").click();
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
    const preferenceWindow = await context.newPage();
    await preferenceWindow.goto(page.url());
    await preferenceWindow.evaluate(() => localStorage.setItem("truedown-layout-density-v1", "compact"));
    await page.waitForFunction(() => document.documentElement.dataset.layoutDensity === "compact");
    await page.evaluate(() => window.TrueDownI18n.setLanguage("en"));
    await page.waitForFunction(() => [...document.querySelectorAll(".task-remaining")].some(cell => /\d+ min$/.test(cell.textContent)));
    const compactHeights = await page.locator(".task-rows tr").evaluateAll(rows => [...new Set(rows.map(row => row.getBoundingClientRect().height))]);
    assert.deepEqual(compactHeights, [52], "all mounted compact rows match virtual geometry");
    assert.equal(await page.locator(".task-spacer td").first().evaluate(cell => getComputedStyle(cell).backgroundSize),
      `${await page.locator(".tasks-table").evaluate(node => node.offsetWidth)}px 52px`);
    await page.mouse.move(1, 1);
    await page.locator("#toast.is-visible").waitFor({ state: "detached" });
    await page.screenshot({ path: path.join(output, `workspace-${width}-compact.png`), animations: "disabled" });
    await page.locator("#tasks-wrap").evaluate(node => { node.scrollTop = 1200 * 52; });
    await page.waitForFunction(() => currentOffset > 1100 && taskViewportOffset === currentOffset);
    await preferenceWindow.evaluate(() => localStorage.removeItem("truedown-layout-density-v1"));
    await page.waitForFunction(() => document.documentElement.dataset.layoutDensity === "comfortable");
    assert.ok(await page.locator("#tasks-wrap").evaluate(node => Math.abs(node.scrollTop / 64 - 1200) <= 1),
      "changing density keeps the same portion of the list visible");
    await preferenceWindow.close();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${width}: full-range virtual scrolling, bounded DOM, incremental rows, global counts and toolbar passed`);
  }
  assert.ok(requests.every(request => request.limit <= 100), "reads must remain bounded");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
