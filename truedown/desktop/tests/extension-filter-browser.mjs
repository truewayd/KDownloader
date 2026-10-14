import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = await fs.mkdtemp(path.join(os.tmpdir(), "kdownloader-filter-"));
const key = "f".repeat(32);
const requests = [];
let unauthorized = false;
let projectExtensions = [".work.project", ".blend"];
const server = http.createServer((request, response) => {
  requests.push({ method: request.method, path: request.url, key: request.headers["x-api-key"], cookie: request.headers.cookie });
  if (unauthorized) { response.writeHead(401).end(`private ${key}`); return; }
  if (request.headers["x-api-key"] !== key) { response.writeHead(401).end("Unauthorized"); return; }
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/settings/download-rules") {
    response.end(JSON.stringify({ enabled: true, filterMode: "project", excludedExtensions: null, dropboxMode: "expand", megaMode: "expand" }));
  } else if (request.url === "/settings/file-groups") {
    response.end(JSON.stringify({ revision: 1, groups: [{ id: "project", extensions: projectExtensions }] }));
  } else { response.writeHead(404).end("{}"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, "profile"), { channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  for (const width of [1040, 390]) for (const colorScheme of ["light", "dark"]) {
    unauthorized = false;
    projectExtensions = [".work.project", ".blend"];
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto(`chrome-extension://${extensionId}/settings.html`);
    await page.waitForFunction(() => settingsLoaded);
    await page.evaluate(async ({ port, key }) => {
      await sendMessage({ action: "backend.setConfig", config: { enabled: true, backendType: "abdm", protocol: "http", host: "127.0.0.1", port, apiKey: key } });
      await sendMessage({ action: "downloadRules.setConfig", config: { filterMode: "off", syncFromTrueDown: true } }, 20000, { retries: 0 });
      await loadAll();
    }, { port, key });
    const mode = page.locator("#download-filter-mode");
    const source = page.locator("#download-filter-sync-truedown");
    const custom = page.locator("#download-filter-extensions");
    const sync = page.locator("#download-filter-sync-now");
    assert.equal(await mode.inputValue(), "project");
    assert.equal(await mode.isDisabled(), true);
    assert.match(await page.locator("#download-filter-project-extensions").textContent(), /\.work\.project/);
    await mode.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `${width}-${colorScheme}-project.png`) });
    await source.uncheck();
    await mode.selectOption("custom");
    assert.match(await custom.inputValue(), /\.work\.project/);
    await custom.fill("PSD, .work.project, .clip");
    await page.locator("#save-settings").click();
    await page.waitForFunction(() => !settingsOperationPending && downloadFilterConfig?.filterMode === "custom" && downloadFilterConfig.syncFromTrueDown === false);
    const saved = await worker.evaluate(async () => (await chrome.storage.sync.get("downloadRulesConfig")).downloadRulesConfig);
    assert.deepEqual(saved.excludedExtensions, [".psd", ".work.project", ".clip"]);
    assert.equal(Object.hasOwn(saved, "syncToTrueDown"), false);
    await custom.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${width}-${colorScheme}-custom.png`) });
    projectExtensions = [".kra", ".design.project"];
    await source.check();
    await page.locator("#backend-port").fill(String(port === 65535 ? port - 1 : port + 1));
    await sync.scrollIntoViewIfNeeded();
    await sync.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !settingsOperationPending && downloadFilterConfig?.filterMode === "project" && downloadFilterConfig.projectExtensions.includes(".design.project"));
    assert.equal((await worker.evaluate(async () => (await chrome.storage.sync.get("backendConfig")).backendConfig)).port, port, "manual rule sync cannot save unrelated backend drafts");
    await page.locator("#backend-port").fill(String(port));
    const before = await page.locator("#download-filter-project-extensions").textContent();
    unauthorized = true;
    await sync.click();
    await page.waitForFunction(() => !settingsOperationPending && document.getElementById("download-filter-sync-status").textContent.includes("HTTP 401"));
    assert.equal(await page.locator("#download-filter-project-extensions").textContent(), before);
    assert.equal((await page.textContent("body")).includes(key), false, "backend diagnostics cannot expose credentials");
    unauthorized = false;
    projectExtensions = [];
    await sync.click();
    await page.waitForFunction(() => !settingsOperationPending && downloadFilterConfig.projectExtensions.length === 0);
    await source.uncheck();
    await mode.selectOption("custom");
    await custom.fill("");
    await page.locator("#save-settings").click();
    await page.waitForFunction(() => !settingsOperationPending && downloadFilterConfig.filterMode === "custom" && downloadFilterConfig.excludedExtensions.length === 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.method === "GET" && request.key === key && request.cookie === undefined));
  console.log(`Real extension filters passed in both themes and viewports. Screenshots: ${output}`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
