// Audit regressions use the real dashboard DOM and an isolated HTTP fixture.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import { chromium } from "playwright";

const assets = new URL("../../web/", import.meta.url);
const groupName = '<img data-audit-injected src="x">';
const groups = { revision: 1, groups: [{ id: "other", name: groupName, extensions: [], directory: "Other" }] };
const startupReason = "Registered, but disabled by Windows Task Manager.";
const fixture = {
  "/settings/task-defaults": { revision: 1, values: {} },
  "/settings/runtime": { concurrentDownloads: 3, globalDownloadLimitBps: 0 },
  "/settings/download-rules": { enabled: false, dropboxMode: "direct", excludedExtensions: [] },
  "/settings/file-groups": groups,
  "/auth/settings": { enabled: false, managed: false },
  "/settings/tracker-research": { enabled: false, minimumLeechers: 3, engine: "stable" },
  "/settings/startup": { supported: true, enabled: false },
  "/system/storage": { dataDirectory: "C:\\TestProfile" },
  "/system/update": { trueDown: { supported: true }, engine: { active: "stable", autoUpdateSupported: true } },
  "/modules": { modules: ["dropbox", "google-drive"].map(id => ({ id, name: id, installed: true, source: "updated" })) },
  "/tasks": {
    tasks: [{ id: 1, status: "paused", category: "other", name: "test.bin", link: "https://example.test/test.bin" }],
    total: 1, groups, summary: { total: 1, paused: 1 },
  },
};
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (pathname in fixture) {
    if (pathname === "/settings/startup" && request.method === "POST") fixture[pathname] = { supported: true, enabled: false, reason: startupReason };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(fixture[pathname]));
    return;
  }
  const name = pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", `${{ html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" }[name.split(".").at(-1)]}; charset=utf-8`);
    response.end(await fs.readFile(new URL(name, assets)));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, releaseModule;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 760 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelectorAll("tr[data-task-id]").length === 1);
  assert.equal(await page.locator("[data-audit-injected]").count(), 0, "group labels must not create HTML nodes");
  assert.equal(await page.locator(".task-file-cell .task-folder").textContent(), groupName, "group labels remain literal text");
  await page.locator('[data-settings-link="experimental"]').evaluate(element => { location.hash = element.hash; });
  await page.waitForFunction(() => settingsReady.has("experimental"));
  await page.locator("#tracker-minimum-leechers").fill("77");
  await page.locator('[data-settings-link="engine"]').click();
  await page.waitForFunction(() => settingsReady.has("engine"));
  await page.locator('[data-settings-link="experimental"]').click();
  await page.waitForFunction(() => currentSettingsPage === "experimental");
  assert.equal(await page.locator("#tracker-minimum-leechers").inputValue(), "77", "first engine visit must retain experimental drafts");
  await page.locator('[data-settings-link="general"]').click();
  await page.waitForFunction(() => settingsReady.has("general"));
  await page.locator("#cfg-proxy-mode").selectOption("custom");
  await page.locator("#cfg-proxy").fill("http://127.0.0.1:7890");
  await page.locator('[data-settings-link="files"]').click();
  await page.waitForFunction(() => settingsReady.has("files"));
  await page.locator('[data-settings-link="general"]').click();
  await page.waitForFunction(() => currentSettingsPage === "general");
  assert.equal(await page.locator("#cfg-proxy-mode").inputValue(), "custom");
  assert.equal(await page.locator("#cfg-proxy").inputValue(), "http://127.0.0.1:7890");
  assert.equal(await page.locator("#cfg-proxy").isVisible(), true, "retained custom proxy stays editable");
  assert.equal(await page.locator("#cfg-proxy").evaluate(element => element.required), true, "custom proxy validation follows the retained mode");
  await page.locator('[data-settings-link="application"]').click();
  await page.waitForFunction(() => settingsReady.has("application"));
  await page.locator("#startup-enabled").click();
  await page.waitForFunction(reason => startupSettings?.reason === reason && document.querySelector("#startup-enabled").getAttribute("aria-busy") !== "true", startupReason);
  assert.equal(await page.locator("#startup-enabled").isChecked(), false);
  assert.ok((await page.locator("#startup-status").textContent()).includes(startupReason), "OS disablement reason remains visible");
  assert.ok((await page.locator("#toast").textContent()).includes(startupReason), "startup feedback reports the applied OS state");
  assert.equal(await page.locator("#toast").evaluate(element => element.classList.contains("error")), true);
  const moduleWrites = [];
  let failModule = false;
  await page.route("**/modules", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const change = route.request().postDataJSON();
    moduleWrites.push(change);
    if (failModule) { await route.fulfill({ status: 500, body: "Fixture module save failed" }); return; }
    if (change.id === "dropbox") await new Promise(resolve => { releaseModule = resolve; });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...change, name: change.id }) });
  });
  await page.locator('[data-settings-link="engine"]').click();
  await page.waitForFunction(() => settingsReady.has("engine"));
  await page.locator('[data-module-toggle="dropbox"]').click();
  await page.waitForFunction(() => pendingResolverModuleActions.has("dropbox"));
  await page.locator('[data-module-toggle="google-drive"]').click();
  await page.waitForFunction(() => document.querySelector('[data-module-toggle="google-drive"]').dataset.installed === "false");
  for (const action of ["toggle", "update", "reset"]) {
    const button = page.locator(`[data-module-${action}="dropbox"]`);
    assert.equal(await button.isDisabled(), true, `re-render preserves pending ${action} state`);
    assert.equal(await button.getAttribute("aria-busy"), "true");
  }
  await page.evaluate(() => onModuleAction({ target: document.querySelector('[data-module-toggle="dropbox"]') }));
  assert.equal(moduleWrites.length, 2, "a second event cannot admit another pending module mutation");
  await page.waitForFunction(() => pendingResolverModuleActions.has("dropbox"));
  releaseModule();
  releaseModule = null;
  await page.waitForFunction(() => !pendingResolverModuleActions.has("dropbox"));
  assert.equal(await page.locator('[data-module-toggle="dropbox"]').isDisabled(), false);
  failModule = true;
  await page.locator('[data-module-toggle="dropbox"]').click();
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Fixture module save failed"));
  assert.equal(await page.locator('[data-module-update="dropbox"]').isDisabled(), false, "failed writes unlock all actions");
  await page.evaluate(() => { chooseModulePackageFile = () => new Promise(resolve => { globalThis.cancelModuleChoice = () => resolve(null); }); });
  await page.locator('[data-module-update="dropbox"]').click();
  await page.evaluate(() => renderResolverModules());
  assert.equal(await page.locator('[data-module-toggle="dropbox"]').isDisabled(), true, "file selection owns the module slot");
  await page.evaluate(() => cancelModuleChoice());
  await page.waitForFunction(() => !pendingResolverModuleActions.has("dropbox"));
  await page.locator('[data-module-reset="dropbox"]').click();
  assert.equal(await page.locator('[data-module-toggle="dropbox"]').isDisabled(), true, "confirmation owns the module slot");
  await page.locator("#dialog-cancel-btn").click();
  await page.waitForFunction(() => !pendingResolverModuleActions.has("dropbox"));
  assert.equal(await page.locator('[data-module-reset="dropbox"]').isDisabled(), false, "canceled workflows release the module slot");
  assert.deepEqual(errors, []);
  await page.close();
  console.log("Auxiliary UI: literal group labels, category drafts, OS startup feedback and module concurrency passed");
} finally {
  releaseModule?.();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
