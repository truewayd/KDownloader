import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { readUIFixtureAsset } from "./ui-fixture-assets.mjs";

const assets = new URL("../../web/", import.meta.url);
const failure = "The server temporarily refused this download (HTTP 503). Retry the task later; the existing partial file will be preserved.";
const tasks = [
  { id: 1, status: "downloading", outputName: "Coastal landscapes.zip", totalLength: 104857600, completedLength: 41943040, downloadSpeed: 4404019, progress: "40%" },
  { id: 2, status: "error", outputName: "Architecture study.blend", error: failure },
  { id: 3, status: "done", outputName: "Reference images.zip" },
].map(task => ({ ...task, folder: "C:\\Downloads", link: `https://example.test/files/${task.id}` }));
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const scenario = new URL(request.headers.referer || url, "http://localhost").searchParams.get("scenario");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (url.pathname === "/tasks") {
    const idle = scenario === "idle" || scenario === "update";
    response.end(JSON.stringify({ tasks: tasks.map(task => idle && task.id === 1 ? { ...task, status: "paused", downloadSpeed: 0 } : task), total: 3, summary: { total: 3, downloading: idle ? 0 : 1, error: 1, done: 1, paused: idle ? 1 : 0, downloadSpeed: idle ? 0 : 4404019 } })); return;
  }
  if (url.pathname === "/system/update") { response.end(JSON.stringify({ trueDown: scenario === "update" ? { updateAvailable: true, availableVersion: "1.2.3" } : {}, engine: {} })); return; }
  if (url.pathname.startsWith("/settings/")) { response.end("{}"); return; }
  const file = url.pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(file)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" }[file.split(".").at(-1)] + "; charset=utf-8");
    response.end(await readUIFixtureAsset(file, assets));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes("--serve")) {
  console.log(`Tooltip preview: ${origin} (also ?scenario=idle and ?scenario=update)`);
} else {
  let browser;
  try {
    browser = await chromium.launch();
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1080, height: 760 }, colorScheme, reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin);
      await page.waitForFunction(() => document.getElementById("active-count").textContent === "1");
      assert.equal(await page.locator("[title]").count(), 0, "no native title bubbles remain");
      assert.equal(await page.locator("#workspace-traffic svg").count(), 2);
      assert.equal((await page.locator("#workspace-traffic").innerText()).includes("\u4e0b\u8f7d\u4e2d"), false);
      assert.equal(await page.locator("#workspace-speed").innerText(), "4.2 MiB/s");
      const tip = page.locator("#kd-tooltip");
      const settings = page.locator("#settings-btn");
      await settings.hover();
      await tip.waitFor({ state: "visible" });
      assert.equal(await tip.getAttribute("data-kind"), "label");
      assert.equal(await tip.textContent(), "\u8bbe\u7f6e");
      assert.equal(await settings.getAttribute("aria-describedby"), "kd-tooltip");
      await page.keyboard.press("Escape");
      await tip.waitFor({ state: "hidden" });
      assert.equal(await settings.getAttribute("aria-describedby"), null);
      // Keyboard focus uses the same tooltip and preserves unrelated descriptions.
      await settings.evaluate(node => node.setAttribute("aria-describedby", "existing-help"));
      await settings.focus();
      await tip.waitFor({ state: "visible" });
      assert.equal(await settings.getAttribute("aria-describedby"), "existing-help kd-tooltip");
      await page.keyboard.press("Escape");
      assert.equal(await settings.getAttribute("aria-describedby"), "existing-help");
      const error = page.locator('tr[data-task-id="2"] .progress-line');
      await error.hover();
      await tip.waitFor({ state: "visible" });
      assert.equal(await tip.getAttribute("data-kind"), "card");
      assert.ok((await tip.textContent()).includes("HTTP 503"));
      await tip.hover();
      await page.waitForTimeout(200);
      assert.equal(await tip.isVisible(), true, "pointer can enter the description");
      await error.evaluate(node => { node.dataset.tooltip = "<img src=x onerror=alert(1)> Updated failure"; });
      await page.waitForFunction(() => document.getElementById("kd-tooltip").textContent.includes("Updated failure"));
      assert.equal(await tip.locator("img").count(), 0, "descriptions are plain text");
      await error.evaluate(node => node.closest("tr").remove());
      await tip.waitFor({ state: "hidden" });
      await page.locator(".sidebar-toggle").click();
      await page.locator("#workspace-notice-action").hover();
      await tip.waitFor({ state: "visible" });
      assert.equal(await page.locator("#workspace-notice-action > .icon").isVisible(), true);
      assert.equal(await tip.getAttribute("data-kind"), "card");
      await page.setViewportSize({ width: 390, height: 700 });
      await page.mouse.move(300, 100);
      await settings.hover();
      await tip.waitFor({ state: "visible" });
      const box = await tip.boundingBox();
      assert.ok(box.x >= 8 && box.y >= 8 && box.x + box.width <= 382 && box.y + box.height <= 692);
      await page.goto(`${origin}/?scenario=idle`);
      await page.waitForFunction(() => document.getElementById("error-count").textContent === "1");
      assert.equal(await page.locator("#workspace-notice").isVisible(), false, "errors alone do not show download traffic");
      assert.equal(await settings.isVisible(), true);
      await page.goto(`${origin}/?scenario=update`);
      await page.waitForFunction(() => document.getElementById("workspace-notice-title").textContent === "\u53d1\u73b0\u65b0\u7248\u672c");
      assert.equal(await page.locator("#workspace-notice").isVisible(), true, "idle downloads cannot hide updates");
      assert.equal(await page.locator("#workspace-traffic").isVisible(), false);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("Tooltip and traffic acceptance passed (light, dark, narrow, keyboard, live updates, idle and update notices).");
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
