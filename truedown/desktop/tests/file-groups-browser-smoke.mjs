import assert from "node:assert/strict";
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
].map(([id, name, extensions]) => ({ id, name, extensions }));
const names = ["Sunset.png", "Ocean.mp4", "Piano.mp3", "References.zip", "Installer.exe", "Guide.pdf", "Cover.PSD", "Scene.blend", "Unknown.bin"];
let groups, tasks, detailWrites = 0, groupWrites = 0;
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
    return json({ tasks: filtered.map(task => ({ ...task, category: category(task) })), total: filtered.length, groups, summary: { total: tasks.length, downloading: 1, done: 1, paused: 7 } });
  }
  if (url.pathname === "/settings/file-groups") {
    if (request.method === "POST") {
      const next = await body(request);
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
    response.setHeader("Content-Type", `${mime}; charset=utf-8`); response.end(await fs.readFile(new URL(name, assets)));
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
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelectorAll("[data-task-category]").length === 8);
    await page.screenshot({ path: path.join(screenshots, `downloads-${width}-${colorScheme}.png`) });
    await page.locator('[data-task-category="project"]').click();
    await page.waitForFunction(() => document.querySelectorAll("tr[data-task-id]").length === 2);
    await page.locator("#task-search").fill("Cover");
    await page.waitForFunction(() => document.querySelectorAll("tr[data-task-id]").length === 1);
    await page.locator('[data-action="details"][data-id="7"]').click();
    await page.waitForFunction(() => document.querySelector("#task-detail-title").textContent === "Cover.PSD");
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
    await page.waitForFunction(() => document.querySelectorAll("[data-group-id]").length === 8);
    await page.locator('[data-group-id="project"] textarea').fill(".blend");
    await page.locator("#file-group-add").click();
    const custom = page.locator('[data-group-id^="group-"]');
    await custom.locator("input").fill("Design source");
    await custom.locator("textarea").fill(".PSD");
    await custom.locator(".group-icon-trigger").click();
    await page.locator('[data-icon-choice="star"]').click();
    await page.locator("#file-groups-save").click();
    await page.waitForFunction(() => document.querySelector("#file-groups-status").textContent.includes("\u5df2\u4fdd\u5b58"));
    assert.equal(groups.groups.find(group => group.name === "Design source").extensions[0], ".psd");
    assert.equal(groups.groups.find(group => group.name === "Design source").icon, "star");
    await page.screenshot({ path: path.join(screenshots, `groups-${width}-${colorScheme}.png`) });
    await page.locator('[data-task-category^="group-"]').click();
    await page.waitForFunction(() => document.querySelector("tr[data-task-id] .task-folder")?.textContent === "Design source");
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("[data-task-category]").length === 9);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${width} ${colorScheme}: groups, suffix editing, filters, details, retained drafts, persistence and conflicts OK`);
  }
  assert.equal(groupWrites, 4);
  assert.equal(detailWrites, 4);
  console.log(`Screenshots: ${screenshots}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
