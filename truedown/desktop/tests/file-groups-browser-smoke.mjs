import assert from "node:assert/strict";
import { readUIFixtureAsset } from "./ui-fixture-assets.mjs";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const assets = new URL("../../web/", import.meta.url);
const screenshots = path.resolve(process.argv[2] || "../dist/file-group-review");
await fs.mkdir(screenshots, { recursive: true });
const defaults = [
  ["image", "\u56fe\u7247", [".png", ".jpg"]], ["video", "\u89c6\u9891", [".mp4"]], ["audio", "\u97f3\u4e50", [".mp3"]],
  ["archive", "\u538b\u7f29\u5305", [".zip"]], ["application", "\u5e94\u7528", [".exe"]], ["document", "\u6587\u6863", [".pdf"]],
  ["project", "\u5de5\u7a0b", [".psd", ".blend"]], ["other", "\u5176\u4ed6", []],
].map(([id, name, extensions]) => ({ id, name, extensions, icon: { image: "image", video: "video", audio: "music", archive: "archive", application: "app-window", document: "logs", project: "settings", other: "file" }[id] }));
const names = ["Sunset.png", "Ocean.mp4", "Piano.mp3", "References.zip", "Installer.exe", "Guide.pdf", "Cover.PSD", "Scene.blend", "Unknown.bin"];
let groups, tasks, detailWrites = 0, groupWrites = 0, taskNotModified = 0;
function reset() {
  groups = { icons: [{ id: "star", name: "Star" }, { id: "folder", name: "Folder" }], revision: 0, groups: structuredClone(defaults) };
  tasks = names.map((name, index) => ({ id: index + 1, name, outputName: name, folder: "C:\\Downloads", link: `https://example.test/${name}`, status: index === 1 ? "downloading" : index === 2 ? "done" : "paused", totalLength: 104857600, completedLength: 41943040, downloadSpeed: 1048576, progress: "40% - 1 MiB/s", createdAt: "2026-09-08T08:00:00Z", settingsRevision: `revision-${index}`, settings: { connections: 16, maxSpeedBps: 0, maxTries: 5, retryWait: 3 } }));
}
function category(task) { return groups.groups.find(group => group.extensions.some(ext => task.name.toLowerCase().endsWith(ext)))?.id || "other"; }
async function body(request) { let value = ""; for await (const part of request) value += part; return JSON.parse(value); }
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const json = (value, code = 200) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
  if (url.pathname === "/tasks") {
    const filtered = tasks.filter(task => (!url.searchParams.get("category") || category(task) === url.searchParams.get("category")) && (!url.searchParams.get("search") || task.name.toLowerCase().includes(url.searchParams.get("search").toLowerCase())) && ([null, "all"].includes(url.searchParams.get("status")) || task.status === url.searchParams.get("status")));
    const etag = JSON.stringify(`${groups.revision}:${filtered.map(task => `${task.id}:${task.settingsRevision}`).join(",")}`);
    response.setHeader("ETag", etag);
    if (request.headers["if-none-match"] === etag) { taskNotModified++; response.writeHead(304).end(); return; }
    return json({ tasks: filtered.map(task => ({ ...task, category: category(task) })), total: filtered.length, groups, summary: { total: tasks.length, downloading: 1, done: 1, paused: 7 } });
  }
  if (url.pathname === "/settings/task-defaults") return json({ revision: 1, values: {} });
  if (url.pathname === "/settings/download-rules") return json({ enabled: false, dropboxMode: "direct", excludedExtensions: [] });
  if (url.pathname === "/settings/file-groups/order") {
    const next = await body(request);
    if (next.revision !== groups.revision) return json("conflict", 409);
    groups = { ...groups, revision: groups.revision + 1, groups: next.ids.map(id => groups.groups.find(group => group.id === id)) };
    return json(groups);
  }
  if (url.pathname === "/settings/file-groups") {
    if (request.method === "POST") {
      const next = await body(request);
      // Keep autosave asynchronous even on fast local loopback connections.
      await new Promise(resolve => setTimeout(resolve, 50));
      if (next.revision !== groups.revision) return json("conflict", 409);
      groupWrites++;
      groups = { icons: groups.icons, revision: groups.revision + 1, groups: next.groups.map(group => ({ ...group, name: group.name.trim(), extensions: group.extensions.map(ext => ext.toLowerCase()) })) };
    }
    return json(groups);
  }
  if (url.pathname === "/tasks/detail") {
    const task = tasks.find(task => task.id === Number(url.searchParams.get("id")));
    if (!task) return json("missing", 404);
    if (request.method === "POST") {
      const next = await body(request);
      if (next.revision !== task.settingsRevision) return json("conflict", 409);
      task.settings = next.values;
      task.settingsRevision = `saved-${++detailWrites}`;
    }
    return json({ ...task, category: category(task), groups });
  }
  const name = url.pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    const mime = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" }[name.split(".").at(-1)];
    response.setHeader("Content-Type", `${mime}; charset=utf-8`); response.end(await readUIFixtureAsset(name, assets));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1200, 390]) for (const colorScheme of ["light", "dark"]) {
    reset();
    const page = await browser.newPage({ viewport: { width, height: 780 }, colorScheme, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // Save requests can coalesce while the previous write is in flight. Verify
    // each committed field before starting the next edit when counting writes.
    const commitGroupField = async (field, value) => {
      const previousWrites = groupWrites;
      await field.fill(value);
      await field.press("Tab");
      await page.waitForFunction(() => !fileGroupsSaving && !fileGroupsSaveQueued
        && document.querySelector("#file-groups-status").textContent.includes("已保存"));
      assert.equal(groupWrites, previousWrites + 1, "committing a group field saves once");
    };
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelectorAll("[data-task-category]").length === 8);
    for (const [id, icon] of [[1, "image"], [4, "archive"], [6, "logs"], [7, "settings"], [9, "file"]]) {
      const node = page.locator(`tr[data-task-id="${id}"] .task-file-cell > .icon`);
      assert.equal(await node.locator("use").getAttribute("href"), `/icons.svg#icon-${icon}`);
      assert.equal(await node.getAttribute("aria-hidden"), "true");
      assert.equal((await node.boundingBox()).width, 32);
    }
    assert.equal(await page.evaluate(() => taskCategoryMeta("missing-group").icon), "file");
    const writesBeforeMenu = groupWrites;
    // Right-click selects the group before opening its actions.
    await page.locator('[data-task-category="project"] .nav-label').dispatchEvent("contextmenu", { button: 2, clientX: 100, clientY: 100 });
    assert.equal(await page.evaluate(() => currentCategory), "project");
    assert.equal(await page.locator('[data-task-category="project"]').getAttribute("aria-current"), "page");
    assert.equal(await page.locator('[data-menu-action="group-show"]').count(), 0);
    await page.screenshot({ path: path.join(screenshots, `group-menu-${width}-${colorScheme}.png`) });
    await page.locator('[data-menu-action="group-edit"]').click();
    await page.waitForFunction(() => document.activeElement?.closest("[data-group-id]")?.dataset.groupId === "project");
    assert.equal(await page.evaluate(() => location.hash), "#settings/files");
    assert.equal(groupWrites, writesBeforeMenu, "opening group settings does not persist anything");
    await page.evaluate(() => { location.hash = "tasks"; });
    await page.waitForFunction(() => currentPage === "tasks");
    const image = page.locator('[data-task-category="image"]');
    const video = page.locator('[data-task-category="video"]');
    const start = await image.boundingBox(), end = await video.boundingBox();
    const beforeDrag = groups.revision;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height - 2, { steps: 8 });
    assert.equal(await page.locator(".group-drag-preview").count(), 1);
    await page.screenshot({ path: path.join(screenshots, `group-drag-${width}-${colorScheme}.png`) });
    await page.mouse.up();
    assert.equal(await page.locator(".group-drag-preview").count(), 0);
    await page.waitForFunction(revision => fileGroupsState.revision > revision && !fileGroupOrderSaving, beforeDrag);
    assert.deepEqual(groups.groups.slice(0, 2).map(group => group.id), ["video", "image"]);
    assert.equal(await page.evaluate(() => currentCategory), "project", "sorting must not activate the dragged group");
    await image.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await page.waitForFunction(() => !fileGroupOrderSaving);
    assert.deepEqual(groups.groups.slice(0, 2).map(group => group.id), ["image", "video"]);
    assert.equal(await image.evaluate(link => document.activeElement === link), true);
    const beforeCancel = groups.revision;
    const cancelStart = await image.boundingBox(), cancelEnd = await video.boundingBox();
    await page.mouse.move(cancelStart.x + 12, cancelStart.y + 12);
    await page.mouse.down();
    await page.mouse.move(cancelEnd.x + 12, cancelEnd.y + cancelEnd.height - 2, { steps: 4 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(groups.revision, beforeCancel, "Escape cancels sorting without saving");
    assert.deepEqual(await page.locator('[data-task-category]').evaluateAll(links => links.slice(0, 2).map(link => link.dataset.taskCategory)), ["image", "video"]);
    if (width === 1200 && colorScheme === "light") {
      await page.route("**/settings/file-groups/order", route => route.fulfill({ status: 503, body: "unavailable" }), { times: 1 });
      await image.focus();
      await page.keyboard.press("Alt+ArrowDown");
      await page.waitForFunction(() => !fileGroupOrderSaving);
      assert.equal(groups.revision, beforeCancel, "failed sorting keeps the confirmed order");
      groups.revision++;
      await image.focus();
      await page.keyboard.press("Alt+ArrowDown");
      await page.waitForFunction(revision => !fileGroupOrderSaving && fileGroupsState.revision === revision, groups.revision);
      assert.deepEqual(groups.groups.slice(0, 2).map(group => group.id), ["image", "video"], "conflicting sorting reloads without replaying the write");
    }
    assert.equal(await page.locator('[href="#settings/general"]').first().evaluate(link => getComputedStyle(link).webkitUserDrag), "none");
    await page.screenshot({ path: path.join(screenshots, `downloads-${width}-${colorScheme}.png`) });
    await page.locator('[data-task-category="project"]').click();
    await page.waitForFunction(() => document.querySelectorAll("tr[data-task-id]").length === 2);
    await page.locator("#task-search").fill("Cover");
    await page.waitForFunction(() => document.querySelectorAll("tr[data-task-id]").length === 1);
    for (const cached of [true, false]) {
      await page.waitForFunction(() => !loadTasksPromise && currentTasks.length === 1 && currentTasks[0].id === 7);
      const previousNotModified = taskNotModified;
      await page.locator('[data-action="details"][data-id="7"]').click();
      await page.waitForFunction(() => currentPage === "task" && taskDetailData?.id === 7 && document.querySelector("#task-detail-title").textContent === "Cover.PSD");
      if (!cached) await page.evaluate(() => taskPages.invalidate());
      const returnedTasks = page.waitForResponse(response => new URL(response.url()).pathname === "/tasks");
      await page.locator("#task-detail-back").click();
      await returnedTasks;
      await page.waitForFunction(() => document.activeElement?.dataset.action === "details" && document.activeElement.dataset.id === "7");
      if (cached) assert.ok(taskNotModified > previousNotModified, "returning uses the retained task page validator");
    }
    await page.locator('[data-action="details"][data-id="7"]').click();
    await page.waitForFunction(() => currentPage === "task" && taskDetailData?.id === 7 && document.querySelector("#task-detail-title").textContent === "Cover.PSD");
    assert.match(await page.locator("#task-info-grid").textContent(), /104|100/);
    await page.screenshot({ path: path.join(screenshots, `task-info-${width}-${colorScheme}.png`) });
    await page.locator("#task-settings-tab").click();
    await page.locator("#task-setting-connections").fill("8");
    await page.evaluate(() => loadTaskDetails());
    assert.equal(await page.locator("#task-setting-connections").inputValue(), "8", "polling preserves drafts");
    await page.locator("#task-settings-save").click();
    await page.waitForFunction(() => document.querySelector("#task-settings-status").textContent.includes("\u5df2\u4fdd\u5b58"));
    assert.equal(tasks[6].settings.connections, 8);
    await page.locator("#task-setting-tries").fill("9");
    tasks[6].settingsRevision = "external-write";
    await page.locator("#task-settings-save").click();
    await page.waitForFunction(() => document.querySelector("#task-settings-status").textContent.includes("\u8349\u7a3f"));
    assert.equal(await page.locator("#task-setting-tries").inputValue(), "9");
    await page.evaluate(() => { location.hash = "settings/groups"; });
    await page.waitForFunction(() => document.querySelectorAll("[data-group-id]").length === 8 && fileGroupsEditorRevision === fileGroupsState.revision && !fileGroupsNeedsSync);
    await page.locator('[data-group-id="project"] .group-suffix-chip').first().getByRole("button", { name: "删除后缀" }).click();
    await page.waitForFunction(() => !fileGroupsSaving && fileGroupsDraft.find(group => group.id === "project").extensions.length === 1);
    assert.deepEqual(groups.groups.find(group => group.id === "project").extensions, [".blend"]);
    await page.locator("#file-group-add").click();
    const custom = page.locator('[data-group-id^="group-"]');
    await commitGroupField(custom.locator(".group-name-field input"), "Design source");
    assert.equal(groups.groups.find(group => group.id.startsWith("group-")).name, "Design source");
    await commitGroupField(custom.locator("[data-group-directory]"), "Design Files");
    assert.equal(groups.groups.find(group => group.name === "Design source").directory, "Design Files");
    await custom.locator(".suffix-add").click();
    await commitGroupField(custom.locator("[data-group-suffix]"), ".PSD");
    assert.deepEqual(groups.groups.find(group => group.name === "Design source").extensions, [".psd"]);
    await custom.locator(".suffix-add").click();
    await custom.locator("[data-group-suffix]").last().fill(".clip, .SAI");
    await custom.locator("[data-group-suffix]").last().press("Enter");
    await page.waitForFunction(() => !fileGroupsSaving && !fileGroupsSaveQueued);
    assert.equal(await custom.locator("[data-group-suffix]").count(), 4, "paste creates separate chips and Enter preserves the next empty input");
    assert.equal(await page.evaluate(() => document.activeElement?.value), "");
    assert.deepEqual(groups.groups.find(group => group.name === "Design source").extensions, [".psd", ".clip", ".sai"]);
    for (const suffix of [".clip", ".sai"]) {
      await custom.locator(".group-suffix-chip").filter({ has: page.locator(`input`) }).evaluateAll((chips, suffix) => {
        chips.find(chip => chip.querySelector("input").value === suffix).querySelector("button").click();
      }, suffix);
      await page.waitForFunction(() => !fileGroupsSaving && !fileGroupsSaveQueued);
    }
    await custom.locator(".group-icon-trigger").click();
    await page.locator('[data-icon-choice="star"]').click();
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForFunction(() => document.querySelector("#file-groups-status").textContent.includes("\u5df2\u4fdd\u5b58"));
    assert.equal(groups.groups.find(group => group.name === "Design source").extensions[0], ".psd");
    assert.equal(groups.groups.find(group => group.name === "Design source").icon, "star");
    assert.equal(groups.groups.find(group => group.name === "Design source").directory, "Design Files");
    if (width === 1200 && colorScheme === "light") {
      const originalWrites = groupWrites;
      await custom.locator(".group-name-field input").fill("Local draft");
      groups.revision++;
      groups.groups.find(group => group.name === "Design source").directory = "Remote folder";
      await page.evaluate(() => document.activeElement.blur());
      await page.waitForFunction(() => document.querySelector("#file-groups-status").textContent.includes("已同步最新分组"));
      assert.equal(await custom.locator(".group-name-field input").inputValue(), "Local draft");
      assert.equal(await custom.locator("[data-group-directory]").inputValue(), "Remote folder");
      assert.equal(groupWrites, originalWrites, "recovery never submits the merged draft");
      await custom.locator(".group-name-field input").fill("Design source");
      await page.evaluate(() => document.activeElement.blur());
      await page.waitForFunction(() => document.querySelector("#file-groups-status").textContent.includes("已保存"));
      assert.equal(groups.groups.find(group => group.name === "Design source").directory, "Remote folder");
    }
    await page.screenshot({ path: path.join(screenshots, `groups-${width}-${colorScheme}.png`) });
    await page.locator('[data-task-category^="group-"]').click();
    await page.waitForFunction(() => document.querySelector("tr[data-task-id] .task-folder")?.textContent === "Design source");
    assert.equal(await page.locator('tr[data-task-id="7"] .task-file-cell > .icon use').getAttribute("href"), "/icons.svg#icon-star", "task icon follows the customized group");
    await page.screenshot({ path: path.join(screenshots, `group-task-icons-${width}-${colorScheme}.png`) });
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("[data-task-category]").length === 9);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${width} ${colorScheme}: groups, suffix editing, filters, details, retained drafts, persistence and conflicts OK`);
  }
  assert.equal(groupWrites, 33, "each field, paste, suffix removal and icon saves once; conflict recovery does not replay writes");
  assert.equal(detailWrites, 4);
  console.log(`Screenshots: ${screenshots}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
