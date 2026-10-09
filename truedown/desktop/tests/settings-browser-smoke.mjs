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
    const context = await browser.newContext({ viewport: { width, height: 760 }, colorScheme, reducedMotion: colorScheme === "light" ? "reduce" : "no-preference" });
    const fixture = {
      "/settings/task-defaults": { revision: 1, values: {} },
      "/settings/runtime": { concurrentDownloads: 3, globalDownloadLimitBps: 0 },
      "/settings/download-rules": { enabled: true, filterMode: "project", dropboxMode: "direct", excludedExtensions: null },
      "/settings/file-groups": { revision: 1, groups: [
        { id: "image", name: "图片", icon: "image", extensions: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".svg", ".ico"], directory: "Pictures" },
        { id: "archive", name: "压缩包", icon: "archive", extensions: [".zip", ".7z", ".rar", ".tar.gz"], directory: "Archives" },
        { id: "project", name: "工程", icon: "settings", extensions: [".psd", ".clip", ".work.project"], directory: "Projects" },
        { id: "other", name: "其他", icon: "file", extensions: [], directory: "Other" },
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
    let finishRuntimeRead;
    const runtimeReadGate = offline ? null : new Promise(resolve => { finishRuntimeRead = resolve; });
    let finishAboutRead;
    const aboutReadGate = new Promise(resolve => { finishAboutRead = resolve; });
    await context.route(/\/(settings\/|system\/|auth\/|modules)/, async route => {
      const endpoint = new URL(route.request().url()).pathname;
      if (!(endpoint in fixture)) throw new Error(`Unexpected settings API: ${endpoint}`);
      if (offline && route.request().method() === "GET") { await route.fulfill({ status: 503, body: "Fixture disconnected" }); return; }
      if (endpoint === "/settings/runtime" && route.request().method() === "GET") await runtimeReadGate;
      if (endpoint === "/system/info") await aboutReadGate;
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
    if (runtimeReadGate) {
      await page.waitForFunction(() => document.querySelector(".settings-content").dataset.loading === "true");
      assert.equal(await page.locator('[data-settings-page="general"]').first().evaluate(node => getComputedStyle(node).opacity), "0", "partially loaded controls stay concealed");
      assert.equal(await page.locator('[data-settings-page="general"]').first().evaluate(node => node.inert), true);
      assert.equal(await page.locator('[data-settings-link="files"]').isVisible(), true, "navigation remains available during reads");
      assert.equal(await page.locator(".settings-content").getAttribute("aria-busy"), "true");
      assert.equal(await page.locator(".settings-content > .kd-page-placeholder").isVisible(), true);
      await page.evaluate(() => KDComponents.setPageLoading(document.querySelector(".settings-content"), true));
      assert.equal(await page.locator(".settings-content > .kd-page-placeholder > span").count(), 4, "repeated loading keeps one placeholder structure");
      assert.equal(await page.locator(".settings-content > .kd-page-placeholder > span").first().evaluate(node => getComputedStyle(node).animationName), colorScheme === "light" ? "none" : "kd-placeholder-pulse");
      await page.screenshot({ path: path.join(screenshots, `${name}-loading.png`) });
      finishRuntimeRead();
    }
    if (offline) {
      await page.waitForFunction(() => document.querySelector("#settings-load-status").textContent.includes("自动重试"));
      offline = false;
      await page.waitForFunction(() => settingsReady.has("general"));
      assert.equal(await page.locator("#settings-load-status").textContent(), "");
      assert.equal(await page.locator("#settings-save-btn, #settings-footer, #file-groups-save, #tray-save").count(), 0);
    }
    await page.waitForFunction(() => settingsReady.has("general"));
    assert.equal(await page.locator(".settings-content").getAttribute("aria-busy"), "false");
    assert.equal(await page.locator(".settings-content > .kd-page-placeholder").isVisible(), false);
    assert.equal(await page.locator('[data-settings-page="general"]').first().isVisible(), true);
    assert.equal(await page.locator('[data-settings-page="general"]').first().evaluate(node => getComputedStyle(node).animationName), colorScheme === "light" ? "none" : "kd-settings-reveal");
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.animationName === "kd-settings-reveal").map(animation => animation.finished.catch(() => {}))));
    assert.equal(await page.title(), "设置");
    const noticeCount = await page.locator(".kd-notice").count();
    await page.evaluate(() => KDComponents.prepareNotices());
    assert.equal(await page.locator(".kd-notice").count(), noticeCount, "notice preparation is idempotent");
    assert.equal(await page.locator("#settings-save-status").evaluate(node => node.closest(".kd-notice").checkVisibility()), false, "empty feedback leaves no notice surface");
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
    assert.equal(await page.locator("[data-settings-link]").count(), 7);
    assert.equal(await page.locator('[data-settings-link="general"] span').textContent(), "下载与网络");
    const search = page.getByRole("searchbox", { name: "搜索设置" });
    await search.fill("保存位置");
    await page.locator(".settings-search-result").first().click();
    await page.waitForFunction(() => currentSettingsPage === "files" && settingsReady.has("files"));
    assert.equal(await page.locator("#cfg-folder").isVisible(), true);
    await search.fill("自动更新");
    assert.equal(await page.locator(".settings-navigation-links").isVisible(), false);
    assert.ok(await page.locator(".settings-search-result").count() >= 2);
    await page.screenshot({ path: path.join(screenshots, `${name}-search.png`) });
    await page.locator(".settings-search-result").filter({ hasText: "关于" }).first().click();
    await page.waitForFunction(() => currentSettingsPage === "about" && document.querySelector(".settings-content").dataset.loading === "true");
    assert.equal(await page.locator(".settings-content > .kd-page-placeholder").isVisible(), true, "About waits for system information, not only update information");
    assert.equal(await page.locator("#about-version").isVisible(), false);
    finishAboutRead();
    await page.waitForFunction(() => currentSettingsPage === "about" && document.querySelector(".settings-search-highlight"));
    assert.equal(await page.locator("#auto-update-truedown").isVisible(), true);
    assert.equal(await page.locator(".settings-navigation-links").isVisible(), true);
    for (const [query, title] of [["falloc", "文件预分配"], [".tar.gz", "文件分组"], ["工程分组", "文件过滤"], ["RPC", "额外 aria2 参数"], ["中间人解密", "Tracker 流量研究"], ["真实下载倍率区间", "真实下载倍率区间"]]) {
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
    for (const category of ["general", "files", "application", "engine", "experimental", "logs", "about"]) {
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
      if (native) { assert.equal(geometry.outerBorder, "0px"); assert.equal(geometry.radius, 16); assert.equal(geometry.rightInset, 8); }
      assert.ok(geometry.root <= width && geometry.content <= geometry.client + 1, `${name}/${category}: horizontal overflow ${JSON.stringify(geometry)}`);
      assert.ok(geometry.bottom <= geometry.footerTop + 1 && geometry.footerBottom <= geometry.height, `${name}/${category}: footer overlap`);
      const notices = await page.locator(".kd-notice:visible").evaluateAll(nodes => nodes.map(node => {
        const bounds = node.getBoundingClientRect(), icon = node.querySelector(".kd-notice-icon");
        return { width: bounds.width, scroll: node.scrollWidth, client: node.clientWidth, decorative: icon.getAttribute("aria-hidden"), radius: getComputedStyle(node).borderRadius };
      }));
      for (const notice of notices) {
        assert.ok(notice.scroll <= notice.client + 1, `${name}/${category}: notice content wraps`);
        assert.equal(notice.decorative, "true");
        assert.equal(notice.radius, "16px");
      }
      if (category === "files") {
        await page.locator("#cfg-folder").fill("D:\\Downloads");
        await page.locator("#cfg-folder").press("Tab");
        await page.waitForFunction(() => downloadSettings.folder === "D:\\Downloads" && !document.querySelector("#settings-form").inert);
        assert.equal(fixture["/settings/task-defaults"].values.folder, "D:\\Downloads", "file management owns directory autosave");
        assert.equal(await page.locator("#dropbox-settings").isVisible(), false);
        assert.equal(await page.locator("#cfg-allocation").evaluate(element => element.closest("fieldset").querySelector("legend").textContent), "文件写入与校验");
        const layout = await page.evaluate(() => {
          const rect = node => node.getBoundingClientRect();
          const fields = [...document.querySelectorAll(".file-group-editor-row .field")].map(field => {
            const label = rect(field.querySelector("label, .field-label")), control = rect(field.querySelector(".group-suffixes, input")), bounds = rect(field);
            return { label: { x: label.x, right: label.right, bottom: label.bottom, height: label.height }, control: { x: control.x, right: control.right, top: control.top }, right: bounds.right };
          });
          const toggles = [...document.querySelectorAll('[data-settings-page="files"] .kd-switch')].map(node => rect(node).right);
          return { fields, toggles };
        });
        for (const field of layout.fields) {
          assert.ok(field.label.height <= 22, `${name}: group labels stay on one line`);
          assert.ok(field.control.top >= field.label.bottom + 4, `${name}: group controls sit below labels`);
          assert.ok(field.control.x >= field.label.x - 1 && field.control.right <= field.right + 1, `${name}: group fields stay within their columns`);
        }
        assert.ok(Math.max(...layout.toggles) - Math.min(...layout.toggles) < 2, `${name}: file switches share one aligned column`);
        await page.locator("#file-groups-title").evaluate(element => element.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: path.join(screenshots, `${name}-file-groups.png`) });
      }
      if (category === "engine") {
        assert.equal(await page.locator('#dropbox-settings').evaluate(node => node.closest('[data-module-id]')?.dataset.moduleId), "dropbox");
        assert.equal(await page.locator('#cfg-filter-mode').isDisabled(), true, "archive mode preserves but disables filtering");
        await page.locator('#cfg-dropbox-mode').selectOption("expand");
        await page.waitForFunction(() => downloadRules.dropboxMode === "expand" && !document.querySelector("#settings-form").inert);
        assert.equal(await page.locator('#cfg-filter-mode').inputValue(), "project");
        assert.equal(await page.locator('#dropbox-filter-extensions').isVisible(), false);
        assert.equal(await page.locator('#dropbox-suffix-editor input').count(), 0, "project suffixes are shown only in their group");
        await page.locator('#dropbox-project-link').evaluate(node => node.scrollIntoView({ block: "center" }));
        await page.screenshot({ path: path.join(screenshots, `${name}-dropbox-project.png`) });
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.locator('#dropbox-project-link a').click();
        await page.waitForFunction(() => document.activeElement.closest('[data-group-id="project"]'));
        await page.waitForFunction(() => {
          const row = document.querySelector('[data-group-id="project"]').getBoundingClientRect();
          return row.top >= 0 && row.top < innerHeight - 40;
        });
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await page.evaluate(() => location.hash), "#settings/files", "group intent is consumed");
        await page.locator('[data-settings-link="engine"]').click();
        assert.equal(await page.locator("#cfg-dropbox-mode").evaluate(element => element.closest("fieldset").querySelector("legend").textContent), "Dropbox 下载选项");
        const ruleSaved = mode => page.waitForFunction(mode => downloadRules.filterMode === mode && !document.querySelector("#settings-form").inert, mode);
        await page.locator("#cfg-filter-mode").selectOption("off");
        await ruleSaved("off");
        await page.evaluate(() => { dropboxCustomSuffixes = null; renderDropboxFilter(normalizeServerDownloadRules(downloadRules)); });
        await page.locator("#cfg-filter-mode").selectOption("custom");
        await ruleSaved("custom");
        assert.deepEqual(fixture["/settings/download-rules"].excludedExtensions, [".psd", ".clip", ".work.project"], "custom starts from the current project suffixes");
        await page.locator("#dropbox-suffix-add").click();
        const lastSuffix = page.locator("#dropbox-suffix-editor input").last();
        await lastSuffix.fill(".TAR.GZ .blend");
        await lastSuffix.press("Tab");
        await page.waitForFunction(() => downloadRules.excludedExtensions.includes(".blend") && !document.querySelector("#settings-form").inert);
        assert.deepEqual(fixture["/settings/download-rules"].excludedExtensions, [".psd", ".clip", ".work.project", ".tar.gz", ".blend"]);
        await page.locator("#dropbox-suffix-editor .group-suffix-chip button").first().click();
        await page.waitForFunction(() => !downloadRules.excludedExtensions.includes(".psd") && !document.querySelector("#settings-form").inert);
        await page.locator("#dropbox-suffix-editor input").first().fill(".draft");
        await page.evaluate(() => {
          const state = structuredClone(fileGroupsState);
          state.revision++;
          state.groups.find(group => group.id === "project").extensions = [".kra"];
          applyFileGroups(state);
        });
        assert.deepEqual(await page.locator("#dropbox-suffix-editor input").evaluateAll(nodes => nodes.map(node => node.value)), [".draft", ".work.project", ".tar.gz", ".blend"], "project updates preserve unsaved custom suffix drafts");
        await page.locator("#dropbox-suffix-editor input").first().fill(".clip");
        await page.locator("#cfg-filter-mode").selectOption("off");
        await ruleSaved("off");
        assert.equal(fixture["/settings/download-rules"].enabled, false);
        assert.equal(await page.locator("#dropbox-filter-extensions").isVisible(), false);
        await page.locator("#cfg-filter-mode").selectOption("custom");
        await ruleSaved("custom");
        assert.equal(await page.locator("#dropbox-suffix-editor input").count(), 4, "off retains custom suffixes");
        failSave = true;
        const editedSuffix = page.locator("#dropbox-suffix-editor input").first();
        await editedSuffix.fill(".custom");
        await editedSuffix.press("Tab");
        await page.waitForFunction(() => document.querySelector("#settings-save-status").textContent.includes("未保存") && !document.querySelector("#settings-form").inert);
        assert.equal(await editedSuffix.inputValue(), ".custom", "failed saves retain the suffix draft");
        assert.equal(fixture["/settings/download-rules"].excludedExtensions[0], ".clip", "failed saves do not replace persisted rules");
        failSave = false;
        await editedSuffix.fill(".clip");
        await editedSuffix.press("Tab");
        await page.waitForFunction(() => !document.querySelector("#settings-save-status").textContent && !document.querySelector("#settings-form").inert);
        await page.locator("#cfg-filter-mode").evaluate(element => element.scrollIntoView({ block: "center" }));
        await page.screenshot({ path: path.join(screenshots, `${name}-dropbox-custom.png`) });
        await page.locator("#cfg-filter-mode").selectOption("project");
        await ruleSaved("project");
        assert.equal(await page.locator("#dropbox-suffix-editor input").count(), 0, "project mode hides duplicate suffixes");
        assert.equal(await page.locator("#dropbox-project-link").isVisible(), true);
        await page.evaluate(() => { dropboxCustomSuffixes = null; renderDropboxFilter(normalizeServerDownloadRules(downloadRules)); });
        await page.locator("#cfg-filter-mode").selectOption("custom");
        await ruleSaved("custom");
        assert.deepEqual(fixture["/settings/download-rules"].excludedExtensions, [".clip", ".work.project", ".tar.gz", ".blend"], "saved custom rules survive returning to project mode and reinitialization");
        await page.locator("#cfg-filter-mode").selectOption("project");
        await ruleSaved("project");
        await page.evaluate(() => {
          const state = structuredClone(fileGroupsState);
          state.revision++;
          state.groups = state.groups.filter(group => group.id !== "project");
          applyFileGroups(state);
        });
        assert.equal(await page.locator("#cfg-filter-mode").inputValue(), "off");
        assert.equal(await page.locator('#cfg-filter-mode option[value="project"]').isDisabled(), true);
        assert.equal(await page.locator("#dropbox-project-link").isVisible(), false);
        assert.equal(await page.locator("#dropbox-filter-extensions").isVisible(), false);
        await page.locator("#cfg-filter-mode").selectOption("custom");
        await ruleSaved("custom");
        assert.equal(await page.locator("#dropbox-suffix-editor input").count(), 4, "automatic fallback preserves custom suffixes");
      }
      if (category === "application") {
        const startup = page.getByRole("switch", { name: /开机启动/ });
        await startup.focus();
        await page.keyboard.press("Space");
        await page.waitForFunction(() => document.querySelector("#startup-enabled").checked && !document.querySelector("#startup-enabled").disabled);
        assert.equal(await page.locator("#startup-status").isVisible(), false, "normal startup state needs no duplicate explanation");
        assert.equal(await page.locator("#startup-status").evaluate(node => node.closest(".kd-notice").checkVisibility()), false);
        assert.equal(await startup.isChecked(), true);
        assert.equal(fixture["/settings/startup"].enabled, true);
        failSave = true;
        await startup.focus();
        await page.keyboard.press("Space");
        await page.waitForFunction(() => document.querySelector("#startup-status").textContent.includes("失败"));
        assert.equal(await page.locator("#startup-status").isVisible(), true, "startup save failures stay visible");
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
        assert.equal(await page.locator("#cfg-extra").isVisible(), true);
        await page.locator("#cfg-extra").fill("--min-split-size=2M");
        await page.locator("#cfg-extra").press("Tab");
        await page.waitForFunction(() => downloadSettings.extra === "--min-split-size=2M" && !document.querySelector("#settings-form").inert);
        assert.equal(fixture["/settings/task-defaults"].values.extra, "--min-split-size=2M");
        assert.equal(await page.locator("#check-truedown-update-btn").isVisible(), false);
        assert.equal(await page.locator(".module-card-icon use").count(), 2);
        await page.locator('[data-module-toggle="dropbox"]').click();
        await page.waitForFunction(() => document.querySelector('[data-module-toggle="dropbox"]').getAttribute("aria-checked") === "false");
        assert.equal(await page.locator('[data-module-toggle="dropbox"]').getAttribute("aria-checked"), "false");
        assert.equal(await page.locator("#cfg-dropbox-mode").isDisabled(), true);
        assert.equal(await page.locator("#dropbox-suffix-editor input").first().isDisabled(), true);
        await page.locator('[data-module-toggle="dropbox"]').click();
        await page.waitForFunction(() => document.querySelector('[data-module-toggle="dropbox"]').getAttribute("aria-checked") === "true");
        assert.equal(await page.locator("#cfg-dropbox-mode").isEnabled(), true);
        assert.equal(await page.locator("#dropbox-suffix-editor input").count(), 4, "module toggles preserve custom rules");
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
    assert.equal(fixture["/settings/task-defaults"].values.folder, "D:\\Downloads");
    await page.evaluate(() => { window.confirmResult = true; });
    await page.locator("#settings-reset-btn").click();
    await page.waitForFunction(() => !document.querySelector("#settings-form").inert && downloadSettings.allocation === DEFAULT_DOWNLOAD_SETTINGS.allocation);
    assert.equal(fixture["/settings/task-defaults"].values.folder, "", "file reset clears the default directory");
    assert.equal(fixture["/settings/task-defaults"].values.extra, "--min-split-size=2M", "file reset preserves engine defaults");
    assert.equal(fixture["/settings/download-rules"].filterMode, "custom", "file reset preserves module preferences");
    assert.equal(await page.locator('[data-group-id="other"] .group-name-field input').inputValue(), "", "file-option reset preserves group drafts");
    for (const [oldPage, newPage] of Object.entries({ network: "general", groups: "files", security: "application", modules: "engine", advanced: "engine" })) {
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
