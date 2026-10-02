import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright";

const assets = new URL("../../web/", import.meta.url);
const png = await readFile(new URL("empty-downloads.png", assets));
const wav = Buffer.alloc(44 + 44100 * 2 * 4);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
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
  const encoder = await browser.newPage();
  const video = await encoder.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext("2d"); context.fillStyle = "#487a7a"; context.fillRect(0, 0, 320, 180);
    const stream = canvas.captureStream(10), recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const ended = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 500)); recorder.stop(); await ended;
    stream.getTracks().forEach(track => track.stop());
    return btoa(String.fromCharCode(...new Uint8Array(await new Blob(chunks).arrayBuffer())));
  });
  await encoder.close();
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ image, audio, video }) => {
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
        const data = id === 1 ? atob(image) : id === 4 ? atob(audio) : id === 5 ? atob(video) : '<script>window.injected=true</script>\nplain text';
        const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(data, char => char.charCodeAt(0)));
        const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        return { status: 200, body: JSON.stringify({ name: id === 1 ? "preview.png" : id === 4 ? "sample.wav" : id === 5 ? "sample.webm" : "notes.txt", mime: id === 1 ? "image/png" : id === 4 ? "audio/wav" : id === 5 ? "video/webm" : "text/plain", size: data.length, sha256, version: "a".repeat(64), offset, data: btoa((id === 3 ? data.replace("plain", "other") : data).slice(offset, offset + 512 * 1024)) }) };
      } },
    };
  }, { image: png.toString("base64"), audio: wav.toString("base64"), video });
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
  if (process.env.TRUEDOWN_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.TRUEDOWN_PREVIEW_SCREENSHOT.replace(/\.png$/, "-narrow.png") });
  await page.locator("#preview-actual").click();
  assert.equal(await page.locator("#preview-scale").textContent(), "100%");
  await page.locator("#preview-in").click();
  assert.equal(await page.locator("#preview-scale").textContent(), "125%");
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.locator("#preview-actual").click();
  const canvas = page.locator("#preview-stage"), image = canvas.locator("img");
  const bounds = await canvas.boundingBox();
  const point = { x: bounds.x + bounds.width * .6, y: bounds.y + bounds.height * .6 };
  const imagePoint = () => image.evaluate((image, point) => {
    const rect = image.getBoundingClientRect();
    return { x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height, width: rect.width };
  }, point);
  const beforeWheel = await imagePoint();
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(width => document.querySelector("#preview-stage img").width > width, beforeWheel.width);
  const afterWheel = await imagePoint();
  assert.ok(Math.abs(beforeWheel.x - afterWheel.x) * afterWheel.width < 2, "wheel zoom preserves the point under the mouse horizontally");
  assert.ok(Math.abs(beforeWheel.y - afterWheel.y) * afterWheel.width < 2, "wheel zoom preserves the point under the mouse vertically");
  await page.mouse.wheel(0, 100);
  await page.waitForFunction(() => document.querySelector("#preview-scale").textContent === "100%");
  for (let i = 0; i < 4; i++) await page.locator("#preview-in").click();
  await page.mouse.move(point.x, point.y);
  const scroll = () => canvas.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
  const beforeDrag = await scroll();
  await page.mouse.down(); await page.mouse.move(point.x - 80, point.y - 60); await page.mouse.up();
  const afterDrag = await scroll();
  assert.ok(Math.abs(afterDrag.x - beforeDrag.x - 80) < 2 && Math.abs(afterDrag.y - beforeDrag.y - 60) < 2, `drag pans the enlarged image on both axes: ${JSON.stringify({ beforeDrag, afterDrag })}`);
  assert.equal(await canvas.evaluate(element => element.classList.contains("is-panning")), false);
  for (const deltaMode of [0, 1, 2]) {
    await page.locator("#preview-actual").click();
    await canvas.dispatchEvent("wheel", { deltaY: -1, deltaMode, clientX: point.x, clientY: point.y });
    assert.ok(await image.evaluate(element => element.width > element.naturalWidth), `wheel mode ${deltaMode} zooms without a modifier`);
  }
  await canvas.evaluate(element => {
    for (let i = 0; i < 40; i++) element.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, cancelable: true }));
  });
  assert.equal(await page.locator("#preview-scale").textContent(), "800%");
  await canvas.evaluate(element => {
    for (let i = 0; i < 40; i++) element.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));
  });
  assert.equal(await page.locator("#preview-scale").textContent(), "5%");
  await canvas.focus(); await page.keyboard.press("0");
  assert.equal(await page.locator("#preview-scale").textContent(), "100%");
  await page.keyboard.press("f");
  assert.equal(await page.locator("#preview-fit").getAttribute("aria-pressed"), "true");
  assert.equal(await canvas.evaluate(element => {
    const event = new WheelEvent("wheel", { deltaY: 0, deltaX: 20, cancelable: true });
    element.dispatchEvent(event); return event.defaultPrevented;
  }), false, "horizontal-only wheel input is not interpreted as zoom");
  assert.equal(await page.locator(".preview-toolbar svg:not([aria-hidden='true']), .preview-toolbar svg:not([focusable='false'])").count(), 0);
  for (const name of ["打开文件", "打开方式…", "打开目录", "适应窗口", "缩小", "放大"]) {
    const button = page.getByRole("button", { name, exact: true });
    assert.equal(await button.locator("svg use").count(), 1);
    assert.ok(await button.getAttribute("data-tooltip"));
  }
  await page.locator('[data-preview-action="open-with"]').click();
  assert.ok(await page.evaluate(() => previewRequests.some(request => request.method === "POST" && request.path === "/tasks/open-with?id=1")));
  await page.evaluate(() => previewEvents["truedown:task-preview"]({ payload: { id: 2, revision: 2, open: true } }));
  await page.waitForFunction(() => document.querySelector("#preview-stage pre")?.textContent.includes("<script>"));
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  assert.equal(await page.locator(".preview-zoom").isVisible(), false);
  assert.equal(await canvas.evaluate(element => {
    const event = new WheelEvent("wheel", { deltaY: 120, cancelable: true });
    element.dispatchEvent(event); return event.defaultPrevented;
  }), false, "text preview retains ordinary wheel scrolling");
  await page.locator("#preview-wrap").click();
  assert.equal(await page.locator("#preview-stage pre").evaluate(element => getComputedStyle(element).whiteSpace), "pre");
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
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.evaluate(() => previewEvents["truedown:task-preview"]({ payload: { id: 4, revision: 5, open: true } }));
  await page.waitForFunction(() => document.querySelector("audio")?.readyState >= 3);
  assert.equal(await page.locator("audio").evaluate(media => media.controls || !media.paused), false, "custom controls without autoplay");
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("audio").paused);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.locator(".preview-player").focus(); await page.keyboard.press("k");
  await page.waitForFunction(() => !document.querySelector("audio").paused);
  await page.keyboard.press("Space");
  assert.equal(await page.locator("audio").evaluate(media => media.paused), true);
  await page.getByRole("button", { name: "静音", exact: true }).click();
  assert.equal(await page.locator("audio").evaluate(media => media.muted), true);
  await page.getByRole("button", { name: "取消静音", exact: true }).click();
  await page.locator(".player-volume").evaluate(input => { input.value = ".35"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(await page.locator("audio").evaluate(media => media.volume), .35);
  await page.locator(".player-volume").evaluate(input => {
    // Two changes in one task reproduce a quick slider drag before volumechange.
    for (const value of ["0.35", "0"]) { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }
  });
  await page.getByRole("button", { name: "取消静音", exact: true }).click();
  assert.equal(await page.locator("audio").evaluate(media => !media.muted && media.volume === .35), true, "unmute restores the last audible volume");
  await page.locator(".player-rate").click();
  assert.equal(await page.locator("audio").evaluate(media => media.playbackRate), 1.25);
  await page.locator(".player-seek").evaluate(input => { input.value = "2"; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForFunction(() => Math.abs(document.querySelector("audio").currentTime - 2) < .1);
  await page.locator(".player-seek").focus(); await page.keyboard.press("ArrowRight");
  assert.ok(await page.locator("audio").evaluate(media => media.currentTime > 2 && media.currentTime < 3), "range arrow does not trigger the player's 10s shortcut");
  await page.getByRole("button", { name: "前进 10 秒" }).click();
  await page.waitForFunction(() => document.querySelector("audio").currentTime === document.querySelector("audio").duration);
  for (const size of [{width:620,height:480},{width:360,height:360}]) {
    await page.setViewportSize(size);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false);
    assert.ok(await page.locator(".player-controls").evaluate(element => element.scrollWidth <= element.clientWidth));
  }
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  assert.equal(await page.locator(".player-seek").evaluate(element => getComputedStyle(element).appearance), "auto");
  await page.emulateMedia({ forcedColors: "none" });
  await page.evaluate(() => { window.retiredMedia = document.querySelector("audio"); });
  await page.evaluate(() => previewEvents["truedown:task-preview"]({ payload: { id: 5, revision: 6, open: true } }));
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
  assert.equal(await page.evaluate(() => retiredMedia.paused && !retiredMedia.hasAttribute("src")), true);
  assert.equal(await page.locator("video").evaluate(media => media.controls), false);
  await page.setViewportSize({width:1000,height:760});
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains("preview-player"));
  await page.getByRole("button", { name: "退出全屏", exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.evaluate(() => previewEvents["truedown:task-preview"]({ payload: { id: 5, revision: 7, open: false } }));
  assert.equal(await page.locator(".preview-player").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Preview security, fit/zoom, inert text, custom media playback/seek/volume/rate/fullscreen, responsive controls and cleanup passed");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
