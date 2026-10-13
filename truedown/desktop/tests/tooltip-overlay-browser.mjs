import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const assets = new URL("../../web/", import.meta.url);
const server = http.createServer(async (request, response) => {
  if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html data-native-window="main"><head><title>Tooltip test</title>
      <link rel="stylesheet" href="/ui-baseline.css"><link rel="stylesheet" href="/native-frame.css">
      <script src="/components.js"></script></head><body>
      <button id="anchor" style="position:fixed;right:16px;top:60px" data-tooltip="Caption overlap">Action</button>
      <script src="/native-frame.js"></script><script>KDComponents.installTooltips();</script></body></html>`);
    return;
  }
  const name = request.url.slice(1);
  if (!["components.js", "native-frame.js", "native-frame.css", "ui-baseline.css"].includes(name)) {
    response.writeHead(404).end(); return;
  }
  response.setHeader("Content-Type", name.endsWith("js") ? "text/javascript" : "text/css");
  response.end(await readFile(new URL(name, assets)));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch();
  for (const scale of [1, 1.25, 1.5, 2]) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: scale });
    await page.addInitScript(() => {
      window.__TRUEDOWN_PLATFORM__ = "windows";
      window.calls = [];
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command !== "frame_tooltip") return { maximized: false };
        calls.push(args);
        if (args.bounds && window.delayLayout) await new Promise(resolve => window.releaseLayout = resolve);
        if (args.bounds && window.failLayout) throw new Error("Fixture rejected layout");
        return 1;
      } } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.documentElement.dataset.nativeTooltip === "true");
    await page.locator("#anchor").hover();
    await page.waitForFunction(() => calls.some(call => call.bounds));
    const layout = await page.evaluate(() => calls.at(-1).bounds);
    assert.ok(layout.top < 40 && layout.left + layout.width > 800 - 144, "tooltip may overlap native caption controls");
    assert.equal(await page.locator("#anchor").getAttribute("aria-describedby"), "kd-tooltip");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => calls.at(-1).bounds === null);
    assert.equal(await page.locator("#kd-tooltip").isVisible(), false);

    // Keep layout measurable but invisible until native composition is ready.
    await page.evaluate(() => { window.delayLayout = true; });
    await page.locator("#anchor").focus();
    await page.waitForFunction(() => Boolean(window.releaseLayout));
    assert.equal(await page.locator("#kd-tooltip").isVisible(), false, "A pending native reveal must not paint a clipped first frame");
    assert.ok((await page.evaluate(() => document.getElementById("kd-tooltip").getBoundingClientRect().width)) > 0, "Pending tooltips retain measurable layout");
    await page.evaluate(() => { window.delayLayout = false; window.releaseLayout(); window.releaseLayout = null; });
    await page.locator("#kd-tooltip").waitFor({ state: "visible" });
    assert.equal(await page.locator("#kd-tooltip").textContent(), "Caption overlap");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => calls.at(-1).bounds === null);

    // Dismissal while waiting must prevent a late acknowledgement from showing.
    await page.evaluate(() => { window.delayLayout = true; document.activeElement.blur(); });
    await page.locator("#anchor").focus();
    await page.waitForFunction(() => Boolean(window.releaseLayout));
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.delayLayout = false; window.releaseLayout(); });
    await page.waitForFunction(() => calls.at(-1).bounds === null);
    assert.equal(await page.locator("#kd-tooltip").isVisible(), false);
    const revisions = await page.evaluate(() => calls.map(call => call.revision));
    assert.ok(revisions.every((value, index) => index === 0 || value > revisions[index - 1]));

    // Native failures close the tooltip and restore the caption-safe placement.
    await page.evaluate(() => { window.failLayout = true; document.activeElement.blur(); });
    await page.locator("#anchor").focus();
    await page.waitForFunction(() => !document.documentElement.dataset.nativeTooltip);
    assert.equal(await page.locator("#kd-tooltip").isVisible(), false);
    assert.equal(await page.evaluate(() => calls.at(-1).bounds), null);
    await page.evaluate(() => document.activeElement.blur());
    await page.locator("#anchor").focus();
    await page.locator("#kd-tooltip").waitFor({ state: "visible" });
    assert.ok((await page.locator("#kd-tooltip").boundingBox()).y >= 48, "failed native adapter retains usable caption-safe tooltips");
    await page.close();
  }
  console.log("Caption tooltip placement, composition readiness, accessibility, delayed dismissal and failure recovery OK at 100/125/150/200% scale");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
