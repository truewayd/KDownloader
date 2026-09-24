// Real layout, wheel, keyboard and settings interactions with an isolated API fixture.
import assert from "node:assert/strict";
import { readUIFixtureAsset } from "./ui-fixture-assets.mjs";
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
    response.end(await readUIFixtureAsset(name, assets));
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
      "/settings/file-groups": { revision: 1, groups: [
        { id: "image", name: "图片", extensions: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".svg", ".ico"], directory: "Pictures" },
        { id: "archive", name: "压缩包", extensions: [".zip", ".7z", ".rar", ".tar.gz"], directory: "Archives" },
        { id: "other", name: "其他", extensions: [], directory: "Other" },
      ] },
      "/settings/startup": { supported: true, enabled: false },
      "/settings/tracker-research": { enabled: false, engine: "stable" },
      "/auth/settings": { enabled: false, managed: false },
      "/system/storage": { dataDirectory: `C:\\Users\\${"LongProfileName".repeat(8)}\\AppData\\Local\\TrueDown`, paths: Object.fromEntries(["config", "data", "state", "logs", "cache"].map(role => [role, `C:\\Users\\Example\\AppData\\Local\\TrueDown\\${role}`])) },
      "/system/info": { product: "TrueDown", productVersion: "1.5.0", version: "truedown-build-42", buildNumber: "42", commit: "a".repeat(40) },
      "/system/logs": { content: "entry\n".repeat(300), updatedAt: "2026-09-08T05:35:34Z" },
      "/system/update": { trueDown: { version: "truedown-build-42", build: 42, supported: true, autoUpdate: true, lastCheckedAt: "2026-09-08T05:35:34Z" }, engine: { preference: "stable", active: "stable", activeVersion: "1.37.0", stableVersion: "1.37.0", nextInstalled: true, nextInstalledVersion: "2.7.2" } },
      "/modules": { modules: ["google-drive", "dropbox"].map(id => ({ id, name: id === "dropbox" ? "Dropbox" : "Google Drive", version: "1.0.0", installed: true, source: "baseline" })) },
    };
    let failSave = false, logReads = 0;
    let offline = native && colorScheme === "light";
    await context.route(/\/(settings\/|system\/|auth\/|modules)/, async route => {
      const endpoint = new URL(route.request().url()).pathname;
      if (!(endpoint in fixture)) throw new Error(`Unexpected settings API: ${endpoint}`);
      if (offline && route.request().method() === "GET") { await route.fulfill({ status: 503, body: "Fixture disconnected" }); return; }
      if (endpoint === "/system/logs") { logReads++; fixture[endpoint].content += `fresh ${logReads}\\n`; }
      if (route.request().method() === "POST") {
        if (failSave) { await route.fulfill({ status: 500, body: "Fixture persistence failure" }); return; }
        const value = route.request().postDataJSON();
        fixture[endpoint] = endpoint === "/settings/task-defaults" ? { revision: fixture[endpoint].revision + 1, values: value.values }
          : endpoint === "/settings/startup" ? { ...fixture[endpoint], ...value } : value;
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture[endpoint]) });
    });
    await context.addInitScript(platform => {
      window.__TRUEDOWN_PLATFORM__ = platform;
      window.trayFixture = { singleSupported: platform !== "linux", doubleSupported: platform === "windows", singleClick: platform === "windows" ? "main" : "menu", doubleClick: platform === "windows" ? "newTask" : "none" };
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command === "tray_settings") {
          if (args.preferences) {
            if (window.failTraySave) throw new Error("Fixture tray persistence failure");
            Object.assign(window.trayFixture, args.preferences);
          }
          return structuredClone(window.trayFixture);
        }
        if (command === "confirm_action") return window.confirmResult !== false;
        if (command === "apply_material") return true;
        if (command === "frame_state") return { maximized: false };
        if (command !== "core_request") return;
        const response = await fetch(args.request.path, { method: args.request.method, body: args.request.body || undefined });
        return { status: response.status, owned: true, headers: {}, body: await response.text() };
      } } };
    }, width === 1040 ? "windows" : width === 820 ? "macos" : "linux");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/${native ? "?window=settings" : ""}#settings/general`);
    if (offline) {
      await page.waitForFunction(() => document.querySelector("#settings-load-status").textContent.includes("自动重试"));
      offline = false;
      await page.waitForFunction(() => settingsReady.has("general"));
      assert.equal(await page.locator("#settings-load-status").textContent(), "");
      assert.equal(await page.locator("#settings-save-btn, #settings-footer, #file-groups-save, #tray-save").count(), 0);
    }
    assert.equal(await page.title(), "设置");
    if (native) {
      const navigation = await page.locator('.settings-search-field').boundingBox();
      assert.equal(navigation.y, navigation.x, `${name}: settings sidebar must have equal top and left spacing`);
      assert.equal(await page.locator(".native-window-title, .native-window-icon").count(), 0);
      assert.equal(await page.evaluate(() => {
        const link = document.querySelector('[data-settings-link="general"]');
        const bounds = link.getBoundingClientRect();
        return link.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      }), true, `${name}: native title drag area must not cover navigation`);
    }
    assert.equal(await page.locator("[data-settings-link]").count(), 8);
    const search = page.getByRole("searchbox", { name: "搜索设置" });
    await search.fill("自动更新");
    assert.equal(await page.locator(".settings-navigation-links").isVisible(), false);
    assert.ok(await page.locator(".settings-search-result").count() >= 2);
    await page.screenshot({ path: path.join(screenshots, `${name}-search.png`) });
    await page.locator(".settings-search-result").filter({ hasText: "关于" }).first().click();
    await page.waitForFunction(() => currentSettingsPage === "about" && document.querySelector(".settings-search-highlight"));
    assert.equal(await page.locator("#auto-update-truedown").isVisible(), true);
    assert.equal(await page.locator(".settings-navigation-links").isVisible(), true);
    for (const [query, title] of [["falloc", "文件预分配"], [".tar.gz", "文件分组"], ["浏览器扩展", "排除的文件后缀"], ["RPC", "额外 aria2 参数"], ["中间人解密", "Tracker 流量研究"], ["真实下载倍率区间", "真实下载倍率区间"]]) {
      await search.fill(query);
      await page.locator(".settings-search-result").filter({ hasText: title }).first().click();
      await page.waitForFunction(() => document.querySelector(".settings-search-highlight"));
      assert.equal(await page.locator(".settings-search-highlight").isVisible(), true, `${name}: authored help ${query} navigates to visible settings`);
    }
    await search.fill("Pictures");
    assert.equal(await page.locator("#settings-search-results").textContent(), "没有匹配的设置", "profile values must stay out of search");
    await search.press("Escape");
    assert.equal(await page.locator('.settings-section details').count(), 0, "settings help is readable without disclosure controls");
    await search.fill("代理地址");
    await page.locator(".settings-search-result").first().click();
    await page.waitForFunction(() => currentSettingsPage === "general" && document.querySelector(".settings-search-highlight"));
    assert.equal(await page.locator("#cfg-proxy-mode").inputValue(), "system", "search must not enable a conditional setting");
    assert.equal(await page.locator(".settings-search-highlight").evaluate(node => node.contains(document.querySelector("#cfg-proxy-mode"))), true, "hidden controls highlight their visible configuration group");
    await search.fill("不存在的选项");
    assert.equal(await page.locator("#settings-search-results").textContent(), "没有匹配的设置");
    await search.press("Escape");
    assert.equal(await search.inputValue(), "");
    assert.equal(await page.locator(".settings-navigation-links").isVisible(), true);
    for (const category of ["general", "files", "application", "engine", "advanced", "experimental", "logs", "about"]) {
      await page.locator(`[data-settings-link="${category}"]`).click();
      await page.waitForFunction(category => currentSettingsPage === category &&
        (settingsReady.has(category) || document.querySelector("#settings-load-status").textContent.includes("失败")), category);
      assert.equal(await page.evaluate(category => settingsReady.has(category), category), true, `${name}/${category}: ${await page.locator("#settings-load-status").textContent()}`);
      const geometry = await page.evaluate(() => {
        const content = document.querySelector(".settings-content");
        const bounds = content.getBoundingClientRect();
        const panel = document.querySelector(".settings-page"), form = document.querySelector("#settings-form");
        return { outerBorder: getComputedStyle(panel).borderTopWidth, radius: parseFloat(getComputedStyle(form).borderTopLeftRadius), rightInset: innerWidth - form.getBoundingClientRect().right, root: document.documentElement.scrollWidth, width: innerWidth, content: content.scrollWidth, client: content.clientWidth, bottom: bounds.bottom, footerTop: innerHeight, footerBottom: 0, height: innerHeight };
      });
      if (native) { assert.equal(geometry.outerBorder, "0px"); assert.equal(geometry.radius, 8); assert.equal(geometry.rightInset, 8); }
      assert.ok(geometry.root <= width && geometry.content <= geometry.client + 1, `${name}/${category}: horizontal overflow ${JSON.stringify(geometry)}`);
      assert.ok(geometry.bottom <= geometry.footerTop + 1 && geometry.footerBottom <= geometry.height, `${name}/${category}: footer overlap`);
      if (category === "files") {
        assert.equal(await page.locator('[data-download-extension]').first().getAttribute("role"), null, "extension selection remains a checkbox");
        assert.equal(await page.locator("#cfg-allocation").evaluate(element => element.closest("fieldset").querySelector("legend").textContent), "文件写入与校验");
        assert.equal(await page.locator("#cfg-dropbox-mode").evaluate(element => element.closest("fieldset").querySelector("legend").textContent), "Dropbox 目录展开与过滤");
        const layout = await page.evaluate(() => {
          const rect = node => node.getBoundingClientRect();
          const fields = [...document.querySelectorAll(".file-group-editor-row .field")].map(field => {
            const label = rect(field.querySelector("label")), control = rect(field.querySelector("input, textarea")), bounds = rect(field);
            return { label: { x: label.x, right: label.right, bottom: label.bottom, height: label.height }, control: { x: control.x, right: control.right, top: control.top }, right: bounds.right };
          });
          const extensions = document.querySelector(".extension-grid"), bounds = rect(extensions), title = rect(document.querySelector("#excluded-extensions-label"));
          const toggles = [...document.querySelectorAll('[data-settings-page="files"] .kd-switch')].map(node => rect(node).right);
          return { fields, extensions: { x: bounds.x, width: bounds.width, parentWidth: rect(extensions.parentElement).width, top: bounds.top, titleBottom: title.bottom }, toggles };
        });
        for (const field of layout.fields) {
          assert.ok(field.label.height <= 22, `${name}: group labels stay on one line`);
          assert.ok(field.control.top >= field.label.bottom + 4, `${name}: group controls sit below labels`);
          assert.ok(field.control.x >= field.label.x - 1 && field.control.right <= field.right + 1, `${name}: group fields stay within their columns`);
        }
        assert.ok(Math.abs(layout.extensions.width - layout.extensions.parentWidth) < 2 && layout.extensions.top > layout.extensions.titleBottom, `${name}: suffix choices span their own row`);
        assert.ok(Math.max(...layout.toggles) - Math.min(...layout.toggles) < 2, `${name}: file switches share one aligned column`);
        await page.locator("#file-groups-title").evaluate(element => element.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: path.join(screenshots, `${name}-file-groups.png`) });
      }
      if (category === "application") {
        const startup = page.getByRole("switch", { name: /开机启动/ });
        await startup.focus();
        await page.keyboard.press("Space");
        await page.waitForFunction(() => document.querySelector("#startup-status").textContent.includes("已开启"));
        assert.equal(await startup.isChecked(), true);
        assert.equal(fixture["/settings/startup"].enabled, true);
        failSave = true;
        await startup.focus();
        await page.keyboard.press("Space");
        await page.waitForFunction(() => document.querySelector("#startup-status").textContent.includes("失败"));
        assert.equal(await startup.isChecked(), true, "failed switch save restores persisted state");
        failSave = false;
        assert.equal(await page.locator("#tray-single").isVisible(), width !== 390);
        assert.equal(await page.locator("#tray-double").isVisible(), width === 1040);
        if (width !== 390) {
          await page.locator("#tray-single").selectOption("settings");
          await page.locator('[data-settings-link="files"]').click();
          await page.locator('[data-settings-link="application"]').click();
          assert.equal(await page.locator("#tray-single").inputValue(), "settings", "tray draft survives category changes");

          await page.waitForFunction(() => document.querySelector("#tray-status").textContent.includes("已保存"));
          assert.equal(await page.evaluate(() => trayFixture.singleClick), "settings");
          await page.evaluate(() => { window.failTraySave = true; });
          await page.locator("#tray-single").selectOption("none");

          await page.waitForFunction(() => document.querySelector("#tray-status").textContent.includes("失败"));
          assert.equal(await page.locator("#tray-single").inputValue(), "settings", "failed save restores persisted behavior");
          assert.equal(await page.locator("#tray-single").isEnabled(), true);
          await page.evaluate(() => { window.failTraySave = false; });
        }
      }
      if (category === "logs") {
        const followBox = await page.locator("#application-log-follow").boundingBox();
        assert.equal(followBox.width, 34, `${name}: log-follow switch keeps its track width`);
        assert.equal(followBox.height, 20, `${name}: log-follow switch keeps its track height`);
        await page.waitForFunction(() => document.querySelector("#application-log-output").textContent.includes("fresh"));
        assert.equal(await page.locator("#application-log-output").evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight < 2), true);
        if (native && colorScheme === "dark") { await page.waitForTimeout(3300); assert.ok(logReads >= 2); }
        if (native && colorScheme === "light") {
          const previous = await page.locator("#application-log-output").textContent();
          offline = true;
          await page.waitForFunction(() => document.querySelector("#application-log-status").textContent.includes("自动重试"));
          assert.equal(await page.locator("#application-log-output").textContent(), previous);
          offline = false;
          await page.waitForFunction(() => !document.querySelector("#application-log-status").textContent.includes("自动重试"));
        }
      }
      if (category === "engine") {
        assert.equal(await page.locator("#check-truedown-update-btn").isVisible(), false);
        assert.equal(await page.locator(".module-card-icon use").count(), 2);
        await page.locator('[data-module-toggle="dropbox"]').click();
        await page.waitForFunction(() => document.querySelector('[data-module-toggle="dropbox"]').getAttribute("aria-checked") === "false");
        assert.equal(await page.locator('[data-module-toggle="dropbox"]').getAttribute("aria-checked"), "false");
      }
      if (category === "about") {
        assert.equal(await page.locator("#check-truedown-update-btn").isVisible(), true);
        assert.equal(await page.locator("#auto-update-truedown").getAttribute("role"), "switch");
        assert.equal(await page.locator("#auto-update-truedown").isChecked(), true);
      }
      await page.locator(".settings-content").evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: path.join(screenshots, `${name}-${category}.png`) });
    }
    await page.locator('[data-settings-link="experimental"]').click();
    // Wheel-scroll the content without a bottom action bar covering the fields.
    const contentBox = await page.locator(".settings-content").boundingBox();
    await page.mouse.move(contentBox.x + contentBox.width / 2, contentBox.y + contentBox.height / 2);
    await page.mouse.wheel(0, 2000);
    await page.waitForFunction(() => { const e = document.querySelector(".settings-content"); return e.scrollTop > 0 || e.scrollHeight <= e.clientHeight; });
    assert.equal(await page.locator("#settings-reset-btn").getAttribute("aria-label"), "恢复当前分类默认设置");
    assert.equal(await page.locator(".settings-category-header").evaluate(element => element.parentElement.classList.contains("settings-content")), true, "category heading scrolls with settings");
    await page.locator("#settings-reset-btn").focus();
    assert.equal(await page.evaluate(() => document.activeElement.id), "settings-reset-btn");
    await page.locator('[data-settings-link="files"]').click();
    await page.locator('[data-group-id="other"] .group-name-field input').fill("");
    await page.locator("#cfg-allocation").selectOption("trunc");
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForFunction(() => !document.querySelector("#settings-form").inert && downloadSettings.allocation === "trunc");
    assert.equal(fixture["/settings/task-defaults"].values.allocation, "trunc", "an incomplete group draft must not block file-option saves");
    assert.equal(fixture["/settings/file-groups"].groups.find(group => group.id === "other").name, "其他", "file-option saves must not write group drafts");
    await page.evaluate(() => { window.confirmResult = false; });
    await page.locator("#settings-reset-btn").click();
    assert.equal(await page.locator("#dialog-overlay").getAttribute("aria-hidden"), "true");
    assert.equal(fixture["/settings/task-defaults"].values.allocation, "trunc", "cancelled reset must not write");
    await page.evaluate(() => { window.confirmResult = true; });
    await page.locator("#settings-reset-btn").click();
    await page.waitForFunction(() => !document.querySelector("#settings-form").inert && downloadSettings.allocation === DEFAULT_DOWNLOAD_SETTINGS.allocation);
    assert.equal(await page.locator('[data-group-id="other"] .group-name-field input').inputValue(), "", "file-option reset preserves group drafts");
    for (const [oldPage, newPage] of Object.entries({ network: "general", groups: "files", security: "application", modules: "engine" })) {
      await page.evaluate(oldPage => { location.hash = `settings/${oldPage}`; }, oldPage);
      await page.waitForFunction(newPage => currentSettingsPage === newPage && settingsReady.has(newPage), newPage);
      assert.equal(await page.locator(`[data-settings-link="${newPage}"]`).getAttribute("aria-current"), "page");
    }
    await page.locator('[data-settings-link="general"]').click();
    assert.equal(await page.locator("#cfg-proxy-mode").inputValue(), "system");
    await page.locator("#cfg-proxy-mode").selectOption("custom");
    await page.locator("#cfg-proxy").fill("http://127.0.0.1:7890");
    await page.locator('[data-settings-link="files"]').click();
    await page.locator('[data-settings-link="general"]').click();
    assert.equal(await page.locator("#cfg-proxy").inputValue(), "http://127.0.0.1:7890");
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForFunction(() => !document.querySelector("#settings-form").inert && downloadSettings.proxy === "http://127.0.0.1:7890");
    assert.equal(fixture["/settings/task-defaults"].values.proxy, "http://127.0.0.1:7890", "merged download page saves network defaults");
    assert.equal(fixture["/settings/task-defaults"].values.connections, 16, "merged download page saves transfer defaults together");
    failSave = true;
    await page.locator("#cfg-proxy").fill("http://127.0.0.1:7891");
    await page.evaluate(() => document.activeElement.blur());
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
