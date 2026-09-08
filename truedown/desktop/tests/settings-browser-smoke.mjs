// Real layout, wheel, keyboard and settings interactions with an isolated API fixture.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const assets = new URL("../../web/", import.meta.url);
const screenshots = process.argv[2] || await fs.mkdtemp(path.join(os.tmpdir(), "truedown-settings-"));
await fs.mkdir(screenshots, { recursive: true });
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", `${{ html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" }[name.split(".").at(-1)]}; charset=utf-8`);
    response.end(await fs.readFile(new URL(name, assets)));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1040, 820, 390]) for (const colorScheme of ["light", "dark"]) {
    const native = width === 1040;
    const name = `${native ? "native" : "browser"}-${width}-${colorScheme}`;
    const context = await browser.newContext({ viewport: { width, height: 760 }, colorScheme, reducedMotion: "reduce" });
    const fixture = {
      "/settings/task-defaults": { revision: 1, values: {} },
      "/settings/runtime": { concurrentDownloads: 3, globalDownloadLimitBps: 0 },
      "/settings/download-rules": { enabled: true, dropboxMode: "direct", excludedExtensions: [".psd", ".clip", ".sai", ".sai2", ".kra", ".xcf", ".procreate", ".afphoto", ".afdesign", ".blend"] },
      "/settings/startup": { supported: true, enabled: false },
      "/settings/tracker-research": { enabled: false, engine: "stable" },
      "/auth/settings": { enabled: false, managed: false },
      "/system/storage": { dataDirectory: "C:\\Users\\Example\\AppData\\Local\\TrueDown", paths: Object.fromEntries(["config", "data", "state", "logs", "cache"].map(role => [role, `C:\\Users\\Example\\AppData\\Local\\TrueDown\\${role}`])) },
      "/system/info": { product: "TrueDown", productVersion: "1.5.0", version: "truedown-build-42", buildNumber: "42", commit: "a".repeat(40) },
      "/system/logs": { content: "entry\n".repeat(300), updatedAt: "2026-09-08T05:35:34Z" },
      "/system/update": { trueDown: { version: "truedown-build-42", build: 42, supported: true, autoUpdate: true, lastCheckedAt: "2026-09-08T05:35:34Z" }, engine: { preference: "stable", active: "stable", activeVersion: "1.37.0", stableVersion: "1.37.0", nextInstalled: true, nextInstalledVersion: "2.7.2" } },
      "/modules": { modules: ["google-drive", "dropbox"].map(id => ({ id, name: id === "dropbox" ? "Dropbox" : "Google Drive", version: "1.0.0", installed: true, source: "baseline" })) },
    };
    let failSave = false, logReads = 0;
    await context.route(/\/(settings\/|system\/|auth\/|modules)/, async route => {
      const endpoint = new URL(route.request().url()).pathname;
      if (!(endpoint in fixture)) throw new Error(`Unexpected settings API: ${endpoint}`);
      if (endpoint === "/system/logs") { logReads++; fixture[endpoint].content += `fresh ${logReads}\\n`; }
      if (route.request().method() === "POST") {
        if (failSave) { await route.fulfill({ status: 500, body: "Fixture persistence failure" }); return; }
        const value = route.request().postDataJSON();
        fixture[endpoint] = endpoint === "/settings/task-defaults" ? { revision: fixture[endpoint].revision + 1, values: value.values } : value;
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture[endpoint]) });
    });
    if (native) await context.addInitScript(() => {
      window.__TRUEDOWN_PLATFORM__ = "windows";
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command === "apply_material") return true;
        if (command === "frame_state") return { maximized: false };
        if (command !== "core_request") return;
        const response = await fetch(args.request.path, { method: args.request.method, body: args.request.body || undefined });
        return { status: response.status, owned: true, headers: {}, body: await response.text() };
      } } };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/${native ? "?window=settings" : ""}#settings/general`);
    assert.equal(await page.title(), "设置");
    if (native) {
      const navigation = await page.locator('[data-settings-link="general"]').boundingBox();
      assert.equal(navigation.y, 18, `${name}: settings navigation must start near the window top`);
      assert.equal(await page.evaluate(() => {
        const link = document.querySelector('[data-settings-link="general"]');
        const bounds = link.getBoundingClientRect();
        return link.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      }), true, `${name}: native title drag area must not cover navigation`);
    }
    for (const category of ["general", "network", "files", "application", "modules", "engine", "security", "advanced", "experimental", "logs", "about"]) {
      await page.locator(`[data-settings-link="${category}"]`).click();
      await page.waitForFunction(category => settingsReady.has(category) || document.querySelector("#settings-load-status").textContent.includes("失败"), category);
      assert.equal(await page.evaluate(category => settingsReady.has(category), category), true, `${name}/${category}: ${await page.locator("#settings-load-status").textContent()}`);
      const geometry = await page.evaluate(() => {
        const content = document.querySelector(".settings-content"), footer = document.querySelector(".settings-footer");
        const bounds = content.getBoundingClientRect();
        const panel = document.querySelector(".settings-page"), form = document.querySelector("#settings-form");
        return { outerBorder: getComputedStyle(panel).borderTopWidth, radius: parseFloat(getComputedStyle(form).borderTopLeftRadius), rightInset: innerWidth - form.getBoundingClientRect().right, root: document.documentElement.scrollWidth, width: innerWidth, content: content.scrollWidth, client: content.clientWidth, bottom: bounds.bottom, footerTop: footer.hidden ? innerHeight : footer.getBoundingClientRect().top, footerBottom: footer.hidden ? 0 : footer.getBoundingClientRect().bottom, height: innerHeight };
      });
      if (native) { assert.equal(geometry.outerBorder, "0px"); assert.equal(geometry.radius, 8); assert.equal(geometry.rightInset, 8); }
      assert.ok(geometry.root <= width && geometry.content <= geometry.client + 1, `${name}/${category}: horizontal overflow ${JSON.stringify(geometry)}`);
      assert.ok(geometry.bottom <= geometry.footerTop + 1 && geometry.footerBottom <= geometry.height, `${name}/${category}: footer overlap`);
      if (category === "files" && width > 720) {
        const tops = await page.locator("#cfg-dropbox-mode, #cfg-allocation").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
        assert.ok(Math.abs(tops[0] - tops[1]) <= 1, `${name}: file selectors are misaligned`);
      }
      if (category === "logs") {
        await page.waitForFunction(() => document.querySelector("#application-log-output").textContent.includes("fresh"));
        assert.equal(await page.locator("#application-log-output").evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight < 2), true);
        if (native && colorScheme === "dark") { await page.waitForTimeout(3300); assert.ok(logReads >= 2); }
      }
      if (category === "modules") {
        assert.equal(await page.locator(".module-card-icon use").count(), 2);
        await page.locator('[data-module-toggle="dropbox"]').click();
        await page.waitForFunction(() => document.querySelector('[data-module-toggle="dropbox"]').getAttribute("aria-pressed") === "false");
        assert.equal(await page.locator('[data-module-toggle="dropbox"]').getAttribute("aria-pressed"), "false");
      }
      await page.screenshot({ path: path.join(screenshots, `${name}-${category}.png`) });
    }
    await page.locator('[data-settings-link="experimental"]').click();
    // Reach the last editable experimental field with wheel input, then Tab to
    // the persistent actions without locator scrolling concealing a layout bug.
    const contentBox = await page.locator(".settings-content").boundingBox();
    await page.mouse.move(contentBox.x + contentBox.width / 2, contentBox.y + contentBox.height / 2);
    await page.mouse.wheel(0, 2000);
    await page.waitForFunction(() => { const e = document.querySelector(".settings-content"); return e.scrollTop > 0 || e.scrollHeight <= e.clientHeight; });
    await page.locator("#tracker-pretend-seed").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "settings-reset-btn");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "settings-save-btn");
    await page.locator('[data-settings-link="network"]').click();
    assert.equal(await page.locator("#cfg-proxy-mode").inputValue(), "system");
    await page.locator("#cfg-proxy-mode").selectOption("custom");
    await page.locator("#cfg-proxy").fill("http://127.0.0.1:7890");
    await page.locator('[data-settings-link="files"]').click();
    await page.locator('[data-settings-link="network"]').click();
    assert.equal(await page.locator("#cfg-proxy").inputValue(), "http://127.0.0.1:7890");
    await page.locator("#settings-save-btn").click();
    await page.waitForFunction(() => document.querySelector("#settings-save-status").textContent.includes("已保存"));
    failSave = true;
    await page.locator("#cfg-proxy").fill("http://127.0.0.1:7891");
    await page.locator("#settings-save-btn").click();
    await page.waitForFunction(() => document.querySelector("#settings-save-status").textContent.includes("未保存"));
    assert.equal(await page.locator("#cfg-proxy").inputValue(), "http://127.0.0.1:7891");
    assert.deepEqual(errors, [], `${name}: JavaScript errors`);
    console.log(`${name}: all categories, alignment, overflow, wheel, keyboard, drafts and save feedback OK`);
    await context.close();
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
