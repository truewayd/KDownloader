import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright";

const assets = new URL("../../web/", import.meta.url);
const png = await readFile(new URL("empty-downloads.png", assets));
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1);
  if (!/^[a-z0-9-]+\.(html|css|js|svg)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", { html: "text/html", css: "text/css", js: "text/javascript", svg: "image/svg+xml" }[name.split(".").at(-1)]);
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src blob:; object-src 'none'; frame-src 'none'");
    response.end(await readFile(new URL(name, assets)));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ image }) => {
    window.__TRUEDOWN_PLATFORM__ = "windows";
    window.previewEvents = {}; window.previewRequests = [];
    window.__TAURI__ = {
      event: { listen: async (event, callback) => { window.previewEvents[event] = callback; return () => {}; } },
      core: { invoke: async (command, args) => {
        if (command === "task_preview_state") return { id: 1, revision: 1, open: true };
        if (command === "frame_state") return { maximized: false };
        if (command === "frame_tooltip") return 1;
        if (command === "apply_material") return false;
        if (command !== "core_request") return;
        window.previewRequests.push(args.request);
        const url = new URL(args.request.path, location.origin);
        if (url.pathname !== "/tasks/preview") return { status: 200, body: "OK" };
        const id = Number(url.searchParams.get("id"));
        const offset = Number(url.searchParams.get("offset"));
        const data = id === 1 ? atob(image) : '<script>window.injected=true</script>\nplain text';
        const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(data, char => char.charCodeAt(0)));
        const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        return { status: 200, body: JSON.stringify({ name: id === 1 ? "preview.png" : "notes.txt", mime: id === 1 ? "image/png" : "text/plain", size: data.length, sha256, version: "a".repeat(64), offset, data: btoa((id === 3 ? data.replace("plain", "other") : data).slice(offset, offset + 512 * 1024)) }) };
      } },
    };
  }, { image: png.toString("base64") });
  await page.goto(`http://127.0.0.1:${server.address().port}/task-preview.html?window=task-preview`);
  await page.waitForFunction(() => document.querySelector("#preview-stage img")?.naturalWidth > 0);
  if (process.env.TRUEDOWN_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.TRUEDOWN_PREVIEW_SCREENSHOT });
  assert.ok((await page.evaluate(() => previewRequests.filter(request => request.path.startsWith("/tasks/preview")).length)) > 1, "images use bounded chunks");
  for (const size of [{ width: 1000, height: 760 }, { width: 620, height: 480 }, { width: 360, height: 360 }]) {
    await page.setViewportSize(size);
    await page.locator("#preview-fit").click();
    await page.waitForFunction(() => {
      const stage = document.getElementById("preview-stage"), image = stage.querySelector("img");
      return image.width <= stage.clientWidth && image.height <= stage.clientHeight;
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), false);
  }
  await page.locator("#preview-actual").click();
  assert.equal(await page.locator("#preview-scale").textContent(), "100%");
  await page.locator("#preview-in").click();
  assert.equal(await page.locator("#preview-scale").textContent(), "125%");
  await page.locator('[data-preview-action="open-with"]').click();
  assert.ok(await page.evaluate(() => previewRequests.some(request => request.method === "POST" && request.path === "/tasks/open-with?id=1")));
  await page.evaluate(() => previewEvents["truedown:task-preview"]({ payload: { id: 2, revision: 2, open: true } }));
  await page.waitForFunction(() => document.querySelector("#preview-stage pre")?.textContent.includes("<script>"));
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  assert.equal(await page.evaluate(async () => {
    try { await fetch("https://example.invalid/blocked-by-preview-csp"); return false; } catch { return true; }
  }), true, "preview CSP prevents external network access");
  await page.evaluate(() => previewEvents["truedown:task-preview"]({ payload: { id: 1, revision: 1, open: true } }));
  assert.equal(await page.locator("#preview-stage pre").count(), 1, "old snapshots cannot replace the new preview");
  await page.evaluate(() => previewEvents["truedown:task-preview"]({ payload: { id: 2, revision: 3, open: false } }));
  assert.equal(await page.locator("#preview-stage > *").count(), 0, "hiding releases content");
  await page.evaluate(() => previewEvents["truedown:task-preview"]({ payload: { id: 3, revision: 4, open: true } }));
  await page.waitForFunction(() => document.querySelector("#preview-status").textContent.includes("发生变化"));
  assert.equal(await page.locator("#preview-stage > *").count(), 0, "tampered chunks must never reach a decoder");
  assert.deepEqual(errors, []);
  console.log("Preview chunks, responsive fit/zoom, open-with, inert text, stale targets and close cleanup passed");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
