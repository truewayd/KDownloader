// Layout and keyboard acceptance against real Chromium. The native bridge is
// stubbed so this check never starts an engine or writes a user's profile.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const assets = new URL("../../web/", import.meta.url);
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    const types = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" };
    response.setHeader("Content-Type", `${types[name.split(".").at(-1)]}; charset=utf-8`);
    response.end(await fs.readFile(new URL(name, assets)));
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const screenshots = process.argv[2];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  if (screenshots) await fs.mkdir(screenshots, { recursive: true });
  for (const role of ["new-task", "batch-task"]) {
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 640, height: 500 }, deviceScaleFactor: 2, colorScheme });
      await context.addInitScript(() => {
        window.__TRUEDOWN_PLATFORM__ = "windows";
        window.nativeCalls = [];
        window.nativeTestPreferences = {
          rules: { enabled: false, dropboxMode: "direct", excludedExtensions: [] },
          modules: { modules: [] },
        };
        window.__TAURI__ = {
          core: { invoke: async (command, args) => {
            window.nativeCalls.push({ command, args });
            if (command === "apply_material") return true;
            if (command === "frame_state") return { maximized: false };
            if (command === "choose_download_directory") return window.directoryChoice ?? null;
            if (command !== "core_request") return;
            const { path, method } = args.request;
            let body;
            if (path === "/settings/task-defaults" && method === "GET") body = { revision: 1, values: {} };
            else if (path === "/settings/download-rules" && method === "GET") body = window.nativeTestPreferences.rules;
            else if (path === "/modules" && method === "GET") body = window.nativeTestPreferences.modules;
            else if (path === "/start-headless-download" && method === "POST") body = "OK 1";
            else throw Error(`Unexpected native form request: ${method} ${path}`);
            return { status: 200, owned: true, body: typeof body === "string" ? body : JSON.stringify(body), headers: {} };
          } },
        };
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/index.html?window=${role}`);
      await page.waitForFunction(() => nativeTaskFormReady);
      assert.equal(await page.locator('#overlay [role="dialog"]').count(), 0);
      assert.equal(await page.locator("#overlay [role=main]").isVisible(), true);
      const layout = await page.evaluate(() => {
        const bounds = (selector) => {
          const { x, y, width, height, bottom } = document.querySelector(selector).getBoundingClientRect();
          return { x, y, width, height, bottom };
        };
        return { header: bounds(".native-titlebar"), form: bounds("#overlay"), footer: bounds("#overlay .modal-footer"), body: bounds("#overlay .modal-body"), height: innerHeight };
      });
      assert.ok(layout.form.y >= layout.header.bottom, JSON.stringify(layout));
      assert.ok(layout.footer.bottom <= layout.height, JSON.stringify(layout));
      assert.ok(layout.body.height > 80, JSON.stringify(layout));
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `${role}-${colorScheme}.png`) });
      const preferencesReads = () => page.evaluate(() => nativeCalls.filter(({ command, args }) => command === "core_request" && args.request.method === "GET").length);
      const beforeInputFocus = await preferencesReads();
      await page.locator("#m-link").fill("https://example.test/draft.zip");
      assert.equal(await preferencesReads(), beforeInputFocus, "input focus never starts native activation reads");
      await page.evaluate(() => {
        nativeTestPreferences.rules = { enabled: true, dropboxMode: "expand", excludedExtensions: [] };
        nativeTestPreferences.modules = { modules: [{ id: "dropbox", name: "Dropbox", installed: true }] };
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForFunction(() => !nativeTaskPreferences.pending && !els.mDropboxOption.hidden);
      assert.equal(await page.locator("#m-dropbox-mode").inputValue(), "expand");
      assert.equal(await page.locator("#m-dropbox-filter").isChecked(), true);
      await page.evaluate(() => {
        els.mDropboxMode.value = "direct";
        els.mDropboxMode.dispatchEvent(new Event("change", { bubbles: true }));
        els.mDropboxFilter.checked = false;
        els.mDropboxFilter.dispatchEvent(new Event("change", { bubbles: true }));
        nativeTestPreferences.modules.modules[0].installed = false;
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForFunction(() => !nativeTaskPreferences.pending && els.mDropboxOption.hidden);
      await page.evaluate(() => {
        nativeTestPreferences.modules.modules[0].installed = true;
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForFunction(() => !nativeTaskPreferences.pending && !els.mDropboxOption.hidden);
      assert.equal(await page.locator("#m-dropbox-mode").inputValue(), "direct");
      assert.equal(await page.locator("#m-dropbox-filter").isChecked(), false);
      assert.equal(await page.locator("#m-link").inputValue(), "https://example.test/draft.zip");
      if (role === "new-task") {
        const chooser = page.waitForEvent("filechooser");
        await page.locator("#choose-torrent-btn").click();
        await (await chooser).setFiles({ name: "native-review.torrent", mimeType: "application/x-bittorrent", buffer: Buffer.from("fixture") });
        assert.equal(await page.locator("#torrent-file-name").textContent(), "native-review.torrent");
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.waitForFunction(() => !nativeTaskPreferences.pending);
        assert.equal(await page.locator("#m-torrent-file").evaluate((input) => input.files[0]?.name), "native-review.torrent");
        await page.locator("#clear-torrent-btn").click();
        assert.equal(await page.locator("#m-torrent-file").evaluate((input) => input.files.length), 0);
        assert.equal(await page.locator("#torrent-file-name").textContent(), "未选择文件");
      } else {
        assert.equal(await page.locator("#choose-torrent-btn").isVisible(), false);
      }
      const directoryButton = page.locator('[data-directory-input="m-folder"]');
      await page.locator("#m-folder").fill("C:\\Draft");
      await directoryButton.click();
      assert.equal(await page.locator("#m-folder").inputValue(), "C:\\Draft");
      await page.evaluate(() => { window.directoryChoice = "C:\\Selected"; });
      await directoryButton.click();
      assert.equal(await page.locator("#m-folder").inputValue(), "C:\\Selected");
      await page.evaluate(() => { window.directoryChoice = new Promise((resolve) => { window.resolveDirectory = resolve; }); });
      await directoryButton.click();
      await page.locator("#m-folder").fill("C:\\Newer draft");
      await page.evaluate(() => window.resolveDirectory("C:\\Late choice"));
      await page.waitForFunction(() => document.querySelector('[data-directory-input="m-folder"]').getAttribute("aria-busy") !== "true");
      assert.equal(await page.locator("#m-folder").inputValue(), "C:\\Newer draft");
      assert.equal(await page.locator("#m-folder").evaluate((input) => input === document.activeElement), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => nativeCalls.filter(({ command }) => command === "close_auxiliary").length), 1);
      assert.equal(await page.locator("#m-link").inputValue(), "https://example.test/draft.zip");
      await page.mouse.move(layout.body.x + 100, layout.body.y + 50);
      await page.mouse.wheel(0, 3000);
      await page.waitForFunction(() => document.querySelector("#overlay .modal-body").scrollTop > 0);
      const advanced = await page.locator("#overlay .advanced-options summary").boundingBox();
      assert.ok(advanced.y >= layout.body.y && advanced.y + advanced.height <= layout.body.y + layout.body.height);
      await page.locator("#overlay .advanced-options summary").click();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.matches("input, textarea, select") && Boolean(document.activeElement.closest(".advanced-body"))), true);
      await page.keyboard.press("End");
      await page.locator("#submit-task-btn").click();
      await page.waitForFunction(() => nativeCalls.some(({ command }) => command === "finish_task_window"));
      assert.equal(await page.locator("#m-link").inputValue(), "");
      assert.equal(await page.evaluate(() => nativeCalls.some(({ command, args }) => command === "core_request" && args.request.path.startsWith("/tasks"))), false);
      assert.deepEqual(errors, []);
      console.log(`${role} ${colorScheme}: DPI=200% frame/form boundaries, wheel, keyboard, file/directory selection, live defaults/modules, draft hide, submission OK`);
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
