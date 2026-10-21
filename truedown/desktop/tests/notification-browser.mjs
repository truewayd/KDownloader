import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { assertToastBounds, readToastPlacement } from "./toast-layout.mjs";

const output = process.argv[2];
if (!output) throw new Error("Pass a governed run directory for notification evidence");
const assets = new URL("../../web/", import.meta.url);
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1);
  if (!name) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/ui-baseline.css"><link rel="stylesheet" href="/workspace.css"><div class="kd-toast" id="toast"></div><script src="/components.js"></script>`);
    return;
  }
  if (!/^[a-z-]+\.(css|js|svg)$/.test(name)) return response.writeHead(404).end();
  try {
    response.setHeader("Content-Type", { css: "text/css", js: "text/javascript", svg: "image/svg+xml" }[name.split(".").at(-1)]);
    response.end(await fs.readFile(new URL(name, assets)));
  } catch { response.writeHead(404).end(); }
});
await fs.mkdir(output, { recursive: true });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const observations = [];
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1200, 390, 320]) for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 760 }, colorScheme, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(width => {
      document.documentElement.style.setProperty("--native-titlebar-height", width > 600 ? "32px" : "0px");
      window.toast = KDComponents.createToast(document.querySelector("#toast"), { duration: 60_000, spriteURL: "/icons.svg" });
    }, width);
    for (const [kind, message] of [
      ["success", "下载链接已复制。"],
      ["error", "下载失败，请重试。\n".repeat(32) + "x".repeat(140)],
      ["info", "正在检查更新，发现新版本后会加入下载任务列表。"],
      ["warning", "任务已保存，等待兼容引擎。"],
      ["announcement", "发现模块更新，后续任务将使用新版本。"],
    ]) {
      await page.evaluate(({ kind, message }) => toast.show(message, kind), { kind, message });
      const placement = await page.waitForFunction(readToastPlacement);
      const bounds = await placement.jsonValue();
      await placement.dispose();
      assertToastBounds(bounds);
      assert.equal(await page.locator("#toast .kd-toast-message").textContent(), message);
      assert.equal(await page.locator("#toast use").getAttribute("href"), `/icons.svg#icon-notification-${kind}`);
      assert.equal(await page.locator("#toast svg").getAttribute("aria-hidden"), "true");
      assert.equal(await page.locator("#toast svg").getAttribute("focusable"), "false");
      assert.equal(await page.locator("#toast").getAttribute("aria-atomic"), "true");
      assert.equal(await page.locator("#toast").getAttribute("role"), kind === "error" ? "alert" : "status");
      const iconBox = await page.locator("#toast svg").boundingBox();
      assert.equal(iconBox.width, 18);
      assert.equal(iconBox.height, 18);
      // External SVG symbols can finish loading after the toast transition.
      await page.waitForFunction(() => document.querySelector("#toast use")?.getBBox().width > 0,
        null, { timeout: 5000 });
      assert.equal(await page.locator(".kd-toast-message").evaluate(node => getComputedStyle(node).userSelect), "text");
      await page.screenshot({ path: path.join(output, `${width}-${colorScheme}-${kind}.png`) });
      observations.push({ width, colorScheme, kind, bounds });
    }
    await page.evaluate(() => {
      toast.show("obsolete", "error");
      toast.hide();
      toast.show('<img src=x onerror="throw 1">', "success");
    });
    await page.waitForFunction(() => document.querySelector("#toast").classList.contains("is-visible"));
    assert.equal(await page.locator("#toast img").count(), 0);
    assert.equal(await page.locator("#toast svg").count(), 1);
    assert.equal(await page.locator("#toast span").textContent(), '<img src=x onerror="throw 1">');
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.ok(await page.locator("#toast").evaluate(node => getComputedStyle(node).transitionDuration.split(",").every(value => parseFloat(value) <= 0.001)));
    await page.evaluate(() => toast.hide());
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${width} ${colorScheme}: notification icons, semantics, literal text and wrapping OK`);
  }
  await fs.writeFile(path.join(output, "browser-summary.json"), JSON.stringify({ passed: true, observations }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
