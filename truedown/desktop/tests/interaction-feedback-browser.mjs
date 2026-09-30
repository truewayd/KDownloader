import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { readUIFixtureAsset } from "./ui-fixture-assets.mjs";

const assets = new URL("../../web/", import.meta.url);
const output = path.resolve("../dist/interaction-feedback");
await fs.mkdir(output, { recursive: true });
const groups = { revision: 1, groups: ["image", "video", "audio", "archive", "application", "document", "project", "other"].map(id => ({ id, name: id, extensions: id === "other" ? [] : [`.${id}`] })) };
const tasks = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: i ? `Example-${i}.zip` : "TrueDown-update.zip", category: "archive", status: "downloading", updateDownload: i === 0, totalLength: 10000000, completedLength: 4000000, downloadSpeed: 1000000, progress: "40%", createdAt: "2026-09-30T00:00:00Z" }));
const state = { busy: "truedown", download: { taskId: 1, status: "downloading" }, trueDown: { supported: true }, engine: {} };
let writes = 0;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const json = value => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
  if (url.pathname === "/tasks") return json({ tasks, total: tasks.length, groups, summary: { total: tasks.length, downloading: tasks.length } });
  if (url.pathname === "/system/update") return json(state);
  if (url.pathname === "/settings/file-groups") return json(groups);
  if (url.pathname.startsWith("/settings/")) return json({ revision: 1, values: {} });
  if (url.pathname === "/tasks/batch" || url.pathname.startsWith("/queue/")) { writes++; return json({ succeeded: [1], failed: [] }); }
  const name = url.pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" }[name.split(".").at(-1)]);
    response.end(await readUIFixtureAsset(name, assets));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch();
try {
  for (const width of [1200, 390]) for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 780 }, colorScheme });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => currentTasks.length === 30 && systemUpdateState);
    const before = await page.locator("#tasks-wrap").boundingBox();
    await page.locator('[data-select-task][value="1"]').check();
    const after = await page.locator("#tasks-wrap").boundingBox();
    assert.equal(after.y, before.y, "selection must not displace list");
    assert.equal(after.height, before.height, "selection must not shrink viewport");
    const floating = await page.locator("#batch-toolbar").boundingBox();
    assert.ok(floating.x >= after.x && floating.x + floating.width <= after.x + after.width);
    assert.ok(floating.y > after.y && floating.y + floating.height < after.y + after.height);
    assert.equal(await page.locator('tr[data-update-download="true"] .update-task-label').count(), 1);
    const checkboxStyle = await page.locator('[data-select-task][value="1"]').evaluate(node => {
      const style = getComputedStyle(node), check = getComputedStyle(node, "::after");
      return [style.borderTopWidth, style.boxShadow, check.borderRightWidth];
    });
    assert.deepEqual(checkboxStyle.slice(0, 2), ["1px", "none"]);
    assert.ok(parseFloat(checkboxStyle[2]) >= 1 && parseFloat(checkboxStyle[2]) <= 1.5, "check stroke may snap to device pixels");
    assert.equal(await page.locator("[data-select-page]").evaluate(node => node.indeterminate), true);
    await page.waitForTimeout(260);
    await page.screenshot({ path: path.join(output, `${width}-${colorScheme}-selection.png`) });
    const prior = writes;
    for (const selector of ['tr[data-task-id="1"] [data-action="pause"]', 'tr[data-task-id="1"] [data-action="remove"]', "#batch-pause-btn", "#batch-remove-btn", "#pause-queue-btn"]) {
      await page.locator(selector).click();
      await page.locator("#dialog-overlay.open").waitFor();
      assert.match(await page.locator("#dialog-message").textContent(), /更新/);
      await page.locator("#dialog-cancel-btn").click();
      await page.waitForFunction(() => !document.querySelector("#dialog-overlay").classList.contains("open"));
      assert.equal(writes, prior, "cancel must not mutate task or queue");
    }
    await page.locator("#batch-clear-btn").click();
    assert.equal(await page.locator("#batch-toolbar").isVisible(), false);
    assert.equal(await page.locator("[data-select-task]:checked").count(), 0);
    assert.equal(await page.locator("#tasks-wrap").evaluate(node => node === document.activeElement), true);
    await page.locator("#task-search").fill("Example");
    await page.locator("#task-search-clear").click();
    assert.equal(await page.locator("#task-search").inputValue(), "");
    await page.evaluate(() => {
      document.documentElement.dataset.material = "native";
      document.documentElement.dataset.platform = "windows";
    });
    await page.waitForTimeout(250);
    const selectedBackground = await page.locator('.primary-nav a[aria-current]').evaluate(node => getComputedStyle(node).backgroundColor);
    assert.match(selectedBackground, /(?:0\.45|\/ 0\.45)/, "selection must retain transparency");
    await page.locator('[data-task-category="video"]').click();
    await page.waitForTimeout(380);
    const indicator = await page.locator(".navigation-indicator").boundingBox();
    const selected = await page.locator('[data-task-category="video"]').boundingBox();
    assert.ok(Math.abs(indicator.y + indicator.height / 2 - selected.y - selected.height / 2) < 1);
    await page.evaluate(() => showToast("Animation preview"));
    await page.waitForTimeout(260);
    assert.equal(await page.locator(".kd-toast").evaluate(node => getComputedStyle(node).opacity), "1");
    await page.waitForFunction(() => !document.querySelector(".kd-toast").classList.contains("is-visible"));
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".kd-toast").evaluate(node => getComputedStyle(node).visibility), "hidden");
    await page.evaluate(() => { location.hash = "#settings/files"; });
    await page.waitForFunction(() => fileGroupsDraft?.length === 8);
    await page.locator(".settings-content").evaluate(node => {
      node.scrollTop += document.querySelector(".group-editor-actions").getBoundingClientRect().top - node.getBoundingClientRect().top + 180;
    });
    const sticky = await page.locator(".group-editor-actions").boundingBox();
    const scroller = await page.locator(".settings-content").boundingBox();
    assert.ok(Math.abs(sticky.y - scroller.y) <= 1, `sticky action must meet top: ${sticky.y}, ${scroller.y}`);
    await page.screenshot({ path: path.join(output, `${width}-${colorScheme}-sticky.png`) });
    const searchSizes = await page.locator("#settings-search").evaluate(node => [node.offsetHeight, getComputedStyle(node).paddingLeft, getComputedStyle(node).paddingRight]);
    assert.deepEqual(searchSizes, [36, "36px", "36px"]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".navigation-indicator").evaluate(node => getComputedStyle(node).transitionDuration), "0.001s");
    await page.emulateMedia({ forcedColors: "active" });
    assert.equal(await page.locator('[data-select-task][value="1"]').evaluate(node => getComputedStyle(node).appearance), "auto");
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${width} ${colorScheme}: overlay geometry, update cancellation, search, indicator, toast and sticky placement OK`);
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
