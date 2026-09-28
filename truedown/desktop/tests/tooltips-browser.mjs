import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { readUIFixtureAsset } from "./ui-fixture-assets.mjs";

const assets = new URL("../../web/", import.meta.url);
const updateScenarios = {
  update: { trueDown: { updateAvailable: true, availableVersion: "1.2.3" } },
  restart: { trueDown: { restartRequired: true, pendingVersion: "1.2.3" } },
  "update-failure": { error: "Checksum mismatch" },
  "update-check": { busy: "truedown" },
  "engine-ready": { engine: { restartRequired: true } },
  ...Object.fromEntries(["downloading", "paused", "queued", "error", "done"].map(status => [`update-${status}`, { busy: "truedown", download: { status, totalLength: 104857600, completedLength: 41943040, downloadSpeed: 4404019 } }])),
  "update-unknown": { busy: "next-engine", download: { status: "downloading", totalLength: 0, completedLength: 41943040, downloadSpeed: 4404019 } },
};
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
    const idle = scenario === "idle" || scenario in updateScenarios;
    const speed = idle || scenario === "stalled" ? 0 : scenario === "fast" ? 1023.9 * 1024 ** 4 : 4404019;
    response.end(JSON.stringify({ tasks: tasks.map(task => idle && task.id === 1 ? { ...task, status: "paused", downloadSpeed: 0 } : task), total: 3, summary: { total: 3, downloading: idle ? 0 : scenario === "fast" ? 10000 : 1, error: scenario === "fast" ? 10000 : 1, done: 1, paused: idle ? 1 : 0, downloadSpeed: speed } })); return;
  }
  if (url.pathname === "/system/update") { response.end(JSON.stringify(updateScenarios[scenario] || { trueDown: {}, engine: {} })); return; }
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
      assert.equal(await page.locator("#workspace-traffic svg").count(), 3);
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
      assert.equal(await page.locator("#workspace-notice-action > .icon").isVisible(), false);
      assert.equal(await page.locator("#workspace-speed").isVisible(), true);
      assert.equal(await page.locator(".traffic-count").first().isVisible(), false);
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
      // Check the same status surface across expanded, collapsed and narrow layouts.
      for (const scenario of ["active", "stalled", "fast", "idle", ...Object.keys(updateScenarios)]) {
        await page.setViewportSize({ width: 1080, height: 760 });
        await page.goto(`${origin}/?scenario=${scenario}`);
        await page.waitForFunction(() => systemUpdateState !== null && document.getElementById("task-count").textContent === "3");
        for (const mode of ["expanded", "collapsed", "narrow"]) {
          if (mode === "collapsed") await page.locator(".sidebar-toggle").click();
          if (mode === "narrow") await page.setViewportSize({ width: 390, height: 700 });
          assert.equal(await page.locator("#workspace-notice").isVisible(), scenario !== "idle", `${scenario}/${mode}: visibility`);
          if (["active", "stalled", "fast"].includes(scenario)) {
            const geometry = await page.locator("#workspace-traffic").evaluate(node => {
              const speed = node.querySelector("#workspace-speed"), count = node.querySelector(".traffic-count");
              return { overflow: node.scrollWidth > node.clientWidth, clipped: speed.scrollWidth > speed.clientWidth,
                speedFirst: speed.getBoundingClientRect().right <= count.getBoundingClientRect().left,
                countVisible: count.checkVisibility(), icons: [...node.querySelectorAll("svg")].filter(icon => icon.checkVisibility()).length };
            });
            assert.equal(geometry.overflow, false, `${scenario}/${mode}: traffic overflow`);
            assert.equal(geometry.clipped, false, `${scenario}/${mode}: speed must fit`);
            assert.equal(geometry.countVisible, mode === "expanded");
            assert.equal(geometry.icons, mode === "expanded" ? 3 : 0);
            if (mode === "expanded") assert.equal(geometry.speedFirst, true);
          } else if (scenario !== "idle") {
            assert.equal(await page.locator("#workspace-traffic").isVisible(), false);
            const marker = page.locator("#workspace-notice-action > .icon, #workspace-notice-progress");
            assert.equal((await Promise.all((await marker.all()).map(node => node.isVisible()))).filter(Boolean).length, 1, `${scenario}/${mode}: one visible update indicator`);
            assert.ok((await page.locator("#workspace-notice-action").getAttribute("aria-label")).length > 0);
          }
        }
      }
      await page.setViewportSize({ width: 1080, height: 760 });
      await page.goto(origin);
      await page.waitForFunction(() => systemUpdateState !== null);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const widths = await page.evaluate(async () => {
        const sidebar = document.querySelector(".sidebar"), toggle = document.querySelector(".sidebar-toggle");
        const start = sidebar.getBoundingClientRect().width;
        toggle.click();
        const transition = sidebar.getAnimations().find(animation => animation.transitionProperty === "flex-basis");
        if (!transition) return { start, missing: true };
        transition.pause();
        transition.currentTime = 110;
        const middle = sidebar.getBoundingClientRect().width;
        transition.finish();
        const end = sidebar.getBoundingClientRect().width;
        toggle.click();
        await Promise.all(sidebar.getAnimations().map(animation => animation.finished.catch(() => {})));
        return { start, middle, end, expanded: sidebar.getBoundingClientRect().width };
      });
      assert.ok(!widths.missing && widths.start > widths.middle && widths.middle > widths.end, JSON.stringify(widths));
      assert.equal(widths.end, 56);
      assert.equal(widths.expanded, widths.start);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.locator(".sidebar-toggle").click();
      assert.equal(await page.locator(".sidebar").evaluate(node => node.getAnimations().length), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("Tooltip and traffic acceptance passed (light, dark, narrow, keyboard, live updates, idle and update notices).");
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
