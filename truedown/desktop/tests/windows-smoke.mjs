import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { readToastPlacement, assertToastBounds } from "./toast-layout.mjs";

if (process.platform !== "win32") throw new Error("This acceptance test requires Windows WebView2");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.argv[2] || path.join(desktop, "target/debug"));
const shellName = process.argv[3] || "TrueDown.exe";
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "truedown-window-review-")));
const installation = path.join(fixture, "Application with spaces");
const profile = path.join(fixture, "Profile with spaces");
await fs.mkdir(installation);
for (const name of [shellName, "truedown-core.exe", "truedown-cli.exe", "aria2c.exe"]) {
  await fs.copyFile(path.join(source, name), path.join(installation, name));
}
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function waitUntil(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Native acceptance test timed out");
}
const port = await freePort(), debugPort = await freePort();
function launchDesktop() { return spawn(path.join(installation, shellName), ["--background", "--data-dir", profile], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env, TRUEDOWN_DESKTOP_TEST: "1", TRUEDOWN_ADDR: `127.0.0.1:${port}`,
    TRUEDOWN_DESKTOP_TEST_SMALL_WORK_AREA: "1",
    TRUEDOWN_DESKTOP_TEST_DEBUG_PORT: String(debugPort),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "",
    TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "",
  },
}); }
const child = launchDesktop();
let launchError;
child.on("error", error => { launchError = error; });
child.stdout.resume(); child.stderr.resume();
let browser, main, downloadFixture;
const invoke = (page, command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
const isNavigationContextError = error => /\bExecution context was destroyed\b|\bCannot find context with specified id\b/.test(error?.message || "");
// Hidden WebView2 windows may suspend animation frames and page timers. Poll
// from the driver, with one evaluation at a time and a fixed overall deadline.
async function waitForNativeCondition(page, predicate, arg) {
  let deadlineTimer, pollTimer, finishPoll, stopped = false, evaluating = false;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      const error = new Error("Native condition timed out after 10000ms");
      error.name = "TimeoutError";
      error.conditionFailure = "deadline";
      error.evaluationPending = evaluating;
      reject(error);
    }, 10000);
  });
  const poll = async () => {
    while (!stopped) {
      let ready;
      evaluating = true;
      try { ready = await page.evaluate(predicate, arg); }
      catch (error) {
        if (stopped) return;
        // Initial navigation replaces the execution context. Only this known
        // transient error may retry; closed pages and script errors must fail.
        if (page.isClosed() || !isNavigationContextError(error)) throw error;
      }
      finally { evaluating = false; }
      if (stopped) return;
      if (ready) return ready;
      await new Promise(resolve => {
        finishPoll = resolve;
        pollTimer = setTimeout(() => { finishPoll = undefined; resolve(); }, 100);
      });
    }
  };
  try {
    return await Promise.race([poll(), deadline]);
  } finally {
    stopped = true;
    clearTimeout(deadlineTimer);
    clearTimeout(pollTimer);
    finishPoll?.();
  }
}
const api = async (page, method, route, body) => {
  const response = await invoke(page, "core_request", { request: { method, path: route, ...(body ? { body: JSON.stringify(body) } : {}) } });
  assert.equal(response.status, 200, response.body);
  return JSON.parse(response.body);
};
async function waitForNativeTaskForm(page, kind) {
  try {
    await waitForNativeCondition(page, () => typeof nativeTaskFormReady !== "undefined" && nativeTaskFormReady);
  } catch (error) {
    let timer;
    try {
      const diagnostic = error.evaluationPending ? { unavailable: "evaluation-pending" } : await Promise.race([
        page.evaluate(() => {
          const state = typeof nativeTaskPreferences === "undefined" ? null : nativeTaskPreferences;
          const message = document.getElementById("modal-msg");
          const text = message?.textContent || "";
          // Classify the status locally; never return error text, drafts or credentials.
          const modalStatus = !message ? "missing" : !text ? "empty"
            : text.startsWith("正在读取下载默认值") ? "loading"
            : text.startsWith("读取默认值失败") ? "initial-read-failed"
            : text.startsWith("读取当前下载选项失败") ? "refresh-failed" : "other";
          return {
            documentState: document.readyState, hidden: document.hidden,
            ready: typeof nativeTaskFormReady === "undefined" ? null : nativeTaskFormReady,
            initializationPending: typeof nativeTaskFormLoad === "undefined" ? null : Boolean(nativeTaskFormLoad),
            disposed: state?.disposed ?? null, requested: state?.requested ?? null,
            pending: state ? Boolean(state.pending) : null,
            formInert: document.getElementById("download-form")?.inert ?? null, modalStatus,
          };
        }).catch(() => ({ unavailable: page.isClosed() ? "page-closed" : "evaluation-failed" })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: "diagnostic-timeout" }), 2000); }),
      ]);
      throw new Error(`Native task form ${kind} readiness failed: ${JSON.stringify(diagnostic)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
const errors = [];
function childrenOf(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | Select-Object ProcessId,Name | ConvertTo-Json -Compress`], { windowsHide: true, encoding: "utf8" });
  return output.trim() ? [JSON.parse(output)].flat() : [];
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function nativeWindows() {
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(desktop, "tests/windows-native-state.ps1"), "-ProcessId", String(child.pid)], {
    windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(output);
}
async function appearance(page, kind) {
  return page.evaluate(kind => {
    const color = selector => {
      const value = getComputedStyle(document.querySelector(selector)).backgroundColor;
      const channels = value.match(/[\d.]+/g).map(Number);
      return { value, alpha: channels[3] ?? 1, brightness: channels.slice(0, 3).reduce((sum, value) => sum + value, 0) / 3 };
    };
    const working = { main: "#tasks-page", settings: "#settings-form", logs: "#logs-page", about: "body > main", "new-task": "#overlay > .modal", "batch-task": "#overlay > .modal" }[kind];
    const chrome = { main: [".sidebar", ".app-shell", ".dashboard"], settings: [".settings-page", ".settings-nav", ".app-shell", ".dashboard"], logs: [".app-shell", ".dashboard"], about: [], "new-task": ["#overlay"], "batch-task": ["#overlay"] }[kind];
    return {
      scheme: getComputedStyle(document.documentElement).colorScheme,
      material: document.documentElement.dataset.material,
      reducedTransparency: matchMedia("(prefers-reduced-transparency: reduce)").matches,
      root: color("html"), body: color("body"), working: color(working),
      chrome: chrome.map(selector => ({ selector, ...color(selector) })),
      inset: kind === "about" ? parseFloat(getComputedStyle(document.querySelector(working)).marginLeft) : parseFloat(getComputedStyle(document.querySelector(kind.endsWith("-task") ? "#overlay" : ".dashboard")).paddingLeft),
    };
  }, kind);
}
async function verifyAppearance(pages, scheme, forcedColors = "none", reducedTransparency = false) {
  const mediaSessions = [];
  for (const page of Object.values(pages)) {
    await page.emulateMedia({ colorScheme: scheme, forcedColors, reducedMotion: "reduce" });
    if (reducedTransparency) {
      const media = await page.context().newCDPSession(page);
      mediaSessions.push(media);
      await media.send("Emulation.setEmulatedMedia", { features: [
        { name: "prefers-color-scheme", value: scheme },
        { name: "forced-colors", value: forcedColors },
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-reduced-transparency", value: "reduce" },
      ] });
    }
  }
  const titles = await main.evaluate(async () => Promise.all((await window.__TAURI__.window.getAllWindows()).map(async window => ({ label: window.label, title: await window.title() }))));
  let states;
  await waitUntil(async () => {
    states = nativeWindows();
    for (const { label, title } of titles) {
      const state = states.find(state => state.title === title);
      if (!state || state.darkResult !== 0 || Boolean(state.dark) !== (scheme === "dark")) return false;
      const material = await pages[label].evaluate(() => document.documentElement.dataset.material);
      if (!material || ((forcedColors === "active" || reducedTransparency) && material !== "solid")) return false;
      const native = state.backdropResult === 0 ? state.backdrop === 2 : state.legacyMicaResult === 0 && state.legacyMica === 1;
      if ((material === "native") !== native) return false;
    }
    return true;
  }).catch(error => { throw new Error(`${error.message}: ${scheme}/${forcedColors}/reduce=${reducedTransparency} native states ${JSON.stringify(states)}`); });
  const suffix = forcedColors === "active" ? `${scheme}-forced-colors` : reducedTransparency ? `${scheme}-reduced-transparency` : scheme;
  const evidence = { scheme, forcedColors, reducedTransparency, windows: states, pages: {} };
  for (const [kind, page] of Object.entries(pages)) {
    const state = states.find(state => state.title === titles.find(window => window.label === kind).title);
    assert.equal(state.clientTopInset, 0, `${kind} must extend the entire top edge for DWM caption painting`);
    assert.deepEqual(state.captionHits, [8, 9, 20], `${kind} must expose genuine minimize, maximize and close hit targets`);
    assert.equal(state.captionExcludedFromWebView, true, `${kind} WebView must not obscure native caption controls`);
    assert.ok(state.resizable && state.minimizable && state.maximizable, `${kind} must retain OS window operations`);
    assert.equal(state.iconWidth, 256, `${kind} must supply a full-resolution native icon`);
    assert.equal(state.iconHeight, 256);
    assert.equal((await invoke(page, "frame_state")).decorated, true);
    assert.equal(await page.locator(".native-titlebar").count(), 1);
    assert.equal(await page.locator("[data-window-action]").count(), 0);
    assert.equal(state.visible, false, `${kind} must remain hidden during appearance acceptance`);
    const view = await appearance(page, kind);
    evidence.pages[kind] = view;
    if (reducedTransparency) assert.equal(view.reducedTransparency, true);
    if (forcedColors !== "active") {
      assert.equal(view.scheme, scheme);
      assert.ok(view.working.alpha === 1 || (view.material === "solid" && view.body.alpha === 1), `${kind} working surface must be opaque`);
      const working = view.working.alpha === 1 ? view.working : view.body;
      assert.equal(working.brightness > 128, scheme === "light", `${kind} working surface must match the native frame theme`);
      assert.equal(view.inset, kind === "settings" ? 0 : 8, `${kind} must retain an outer material inset`);
    }
    if (view.material === "native") {
      assert.equal(view.root.alpha, 0);
      assert.equal(view.body.alpha, 0);
      for (const chrome of view.chrome) assert.equal(chrome.alpha, 0, `${kind} ${chrome.selector} must expose native material`);
    } else {
      assert.equal(view.body.alpha, 1, `${kind} fallback must cover the native backdrop`);
    }
    // CDP captures WebView pixels; native geometry is checked separately above.
    // Rust tests inspect caption backing pixels. Hidden captures cannot prove
    // visible glyphs in DWM's final composition.
    await page.screenshot({ path: path.join(fixture, `${kind}-${suffix}.png`), omitBackground: true });
  }
  await fs.writeFile(path.join(fixture, `appearance-${suffix}.json`), JSON.stringify(evidence, null, 2) + "\n");
  for (const media of mediaSessions) await media.detach();
}
try {
  await waitUntil(async () => {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Desktop exited before WebView readiness (code=${child.exitCode}, signal=${child.signalCode})`);
    return fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2500) }).then(response => response.ok, () => false);
  // The core handshake itself allows 60 seconds. Cold CI WebView2 initialization
  // starts only after it completes, so readiness must cover both phases.
  }, 90000).catch(async error => {
    const coreReady = await fetch(`http://127.0.0.1:${port}/system/info`, { signal: AbortSignal.timeout(2500) }).then(response => response.ok, () => false);
    throw new Error(`Native startup failed: ${error.message}; coreHTTPReady=${coreReady}; fixture=${fixture}`, { cause: error });
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 15000 });
  const context = browser.contexts()[0];
  main = await waitUntil(() => context.pages()[0]);
  const observe = page => {
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
  };
  context.pages().forEach(observe); context.on("page", observe);
  try {
    await waitForNativeCondition(main, () => Boolean(window.__TAURI__ && document.querySelector("#task-count")));
  } catch (error) {
    let timer;
    try {
      const diagnostic = error.evaluationPending ? { unavailable: "evaluation-pending" } : await Promise.race([
        main.evaluate(() => ({
          documentState: document.readyState,
          tauriAvailable: Boolean(window.__TAURI__),
          taskCountPresent: Boolean(document.querySelector("#task-count")),
        })).catch(() => ({ unavailable: main.isClosed() ? "page-closed" : "evaluation-failed" })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: "diagnostic-timeout" }), 2000); }),
      ]);
      const current = new URL(main.url() || "about:blank");
      const conditionFailure = error.conditionFailure === "deadline" ? "deadline"
        : main.isClosed() ? "page-closed"
          : isNavigationContextError(error) ? "context-destroyed" : "evaluation-failed";
      const errorName = ["Error", "TimeoutError", "TargetClosedError", "ProtocolError", "TypeError", "ReferenceError", "SyntaxError"].includes(error.name)
        ? error.name : "OtherError";
      // Only fixed categories leave the driver; errors may contain task data.
      const pageErrorCategories = [...new Set(errors.map(message =>
        /not allowed by ACL|Permissions associated with this command/.test(message) ? "acl-denied"
          : /content security policy/i.test(message) ? "content-security-policy"
          : /ReferenceError|is not defined/.test(message) ? "reference-error"
          : /SyntaxError|Unexpected token|Invalid or unexpected token/.test(message) ? "syntax-error"
          : /TypeError|is not a function/.test(message) ? "type-error" : "other"))];
      throw new Error(`Native main window readiness failed: ${JSON.stringify({
        ...diagnostic, conditionFailure, errorName, origin: current.origin, path: current.pathname,
        pageCount: context.pages().length, pageErrorCount: errors.length, pageErrorCategories,
      })}`);
    } finally {
      clearTimeout(timer);
    }
  }
  // Require the native ACL rejection; reaching a missing-file error is a failure.
  await assert.rejects(invoke(main, "plugin:image|from_path", { path: path.join(profile, "__acl_image_must_not_exist__.png") }),
    /image\.from_path not allowed\. Permissions associated with this command: [^\r\n]*core:image:allow-from-path|Command plugin:image\|from_path not allowed by ACL/);
  await api(main, "GET", "/system/info");
  for (const request of [
    { method: "GET", path: "/tasks?search=\u0000" },
    { method: "POST", path: "/settings/startup", body: '{"enabled":true}' },
    { method: "POST", path: "/auth/settings", body: '{"enabled":true}' },
    { method: "GET", path: "/tasks", headers: { "Content-Type": "application/json", "content-type": "text/plain" } },
  ]) await assert.rejects(invoke(main, "core_request", { request }));
  assert.equal((await api(main, "GET", "/system/info")).product, "TrueDown", "Rejected requests must not disconnect the private pipe");
  assert.equal(await main.evaluate(() => window.__TRUEDOWN_PLATFORM__), "windows");
  await main.locator('[data-route="settings"]').click();
  const settings = await waitUntil(() => context.pages().find(page => page.url().includes("window=settings")));
  await waitUntil(() => context.pages().length === 2);
  const storage = await api(main, "GET", "/system/storage");
  assert.equal(storage.layoutVersion, 1);
  assert.equal(storage.paths.cache.toLowerCase(), path.join(profile, "cache").toLowerCase());
  await fs.access(path.join(storage.paths.cache, "webview", "EBWebView"));
  assert.equal((await fs.readdir(installation)).some(name => name.includes("WebView")), false);
  await waitForNativeCondition(settings, () => currentSettingsPage === "general");
  for (const kind of ["logs", "about"]) {
    await invoke(main, "open_auxiliary", { kind });
    await waitForNativeCondition(settings, kind => currentSettingsPage === kind, kind);
    if (kind === "logs") {
      await settings.evaluate(() => loadApplicationLog());
      await waitForNativeCondition(settings, () => document.querySelector("#application-log-output").textContent.includes("starting"));
    } else await waitForNativeCondition(settings, () => document.querySelector("#about-version").textContent !== "正在读取…");
    assert.equal(context.pages().length, 2);
  }
  await invoke(main, "open_auxiliary", { kind: "settings" });
  await waitForNativeCondition(settings, () => currentSettingsPage === "general");
  assert.equal(new URL(main.url()).hash, "");
  await settings.locator('[data-settings-link="general"]').click();
  await waitForNativeCondition(settings, () => !document.querySelector('[data-settings-page="general"]').inert);
  await settings.locator("#cfg-conns").fill("8");
  await settings.locator("#settings-save-btn").click();
  await waitForNativeCondition(settings, () => document.querySelector("#settings-save-status").textContent === "本页设置已保存。");
  assert.equal((await api(main, "GET", "/settings/task-defaults")).values.connections, 8);
  await settings.locator("#cfg-conns").fill("7");
  await invoke(settings, "close_auxiliary");
  await invoke(main, "open_auxiliary", { kind: "settings" });
  assert.equal(await settings.locator("#cfg-conns").inputValue(), "7");
  assert.equal(context.pages().length, 2);
  const previousCore = childrenOf(child.pid).find(process => process.Name === "truedown-core.exe");
  assert.ok(previousCore, "Native package must own one core");
  const previousEngine = childrenOf(previousCore.ProcessId).find(process => process.Name === "aria2c.exe");
  assert.ok(previousEngine, "Core must own its engine");
  process.kill(previousCore.ProcessId);
  await waitUntil(() => !alive(previousEngine.ProcessId), 5000);
  await waitUntil(async () => {
    try { return (await api(main, "GET", "/settings/task-defaults")).values.connections === 8; }
    catch { return false; }
  });
  const recoveredCores = childrenOf(child.pid).filter(process => process.Name === "truedown-core.exe");
  assert.equal(recoveredCores.length, 1);
  assert.notEqual(recoveredCores[0].ProcessId, previousCore.ProcessId);
  assert.equal(await settings.locator("#cfg-conns").inputValue(), "7");
  // Long forms are singleton windows with independent drafts and read-only
  // preference access. Their shared app script must never poll task pages.
  const taskForms = {};
  for (const [kind, button] of [["new-task", "#new-task-btn"], ["batch-task", "#batch-task-btn"]]) {
    await main.locator(button).click();
    const form = await waitUntil(() => context.pages().find(page => page.url().includes(`window=${kind}`)));
    taskForms[kind] = form;
    await waitForNativeTaskForm(form, kind);
    assert.equal(await form.locator('#overlay [role="dialog"]').count(), 0);
    assert.equal(await form.locator('#overlay [role="main"]').isVisible(), true);
    await form.locator("#m-link").fill(`http://127.0.0.1/draft-${kind}`);
    await form.locator("#overlay .advanced-options summary").click();
    await form.locator("#m-headers").fill('{"X-Draft":"retained"}');
    await form.keyboard.press("Escape");
    await invoke(main, "open_auxiliary", { kind });
    assert.equal(await form.locator("#m-link").inputValue(), `http://127.0.0.1/draft-${kind}`);
    assert.equal(await form.locator("#m-headers").inputValue(), '{"X-Draft":"retained"}');
    assert.equal(context.pages().filter(page => page.url().includes(`window=${kind}`)).length, 1);
    const state = await form.evaluate(async () => {
      let reads = 0;
      const original = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = (...args) => { if (args[0] === "core_request") reads++; return original(...args); };
      try { await refreshAndSchedule(true); return { reads, timer: pollTimer, page: currentPage }; }
      finally { window.__TAURI__.core.invoke = original; }
    });
    assert.deepEqual(state, { reads: 0, timer: 0, page: kind });
    await assert.rejects(invoke(form, "core_request", { request: { method: "GET", path: "/tasks?limit=1" } }));
    await assert.rejects(invoke(form, "core_request", { request: { method: "POST", path: "/settings/task-defaults", body: "{}" } }));
  }
  assert.equal(context.pages().length, 4);
  for (const page of [main, settings, ...Object.values(taskForms)]) {
    await assert.rejects(invoke(page, "confirm_action", { options: {
      title: "Confirm", message: "Remove this fixture?", confirmLabel: "Remove", cancelLabel: "Cancel", danger: true,
    } }), /suppressed during hidden acceptance/);
  }
  await assert.rejects(invoke(main, "finish_task_window"));
  for (const page of [main]) {
    await assert.rejects(invoke(page, "choose_download_directory"), /only from settings or a task form/);
  }
  for (const page of [settings, ...Object.values(taskForms)]) {
    // Exercise the actual role boundary without showing an OS dialog during
    // hidden acceptance. Cancellation and path bounds have native unit tests.
    await assert.rejects(invoke(page, "choose_download_directory"), /suppressed during hidden acceptance/);
    await assert.rejects(invoke(page, "plugin:dialog|open", { options: { directory: true } }), /not allowed|denied|forbidden/i);
  }
  downloadFixture = http.createServer((_request, response) => response.end("TrueDown native task-form acceptance\n"));
  await new Promise(resolve => downloadFixture.listen(0, "127.0.0.1", resolve));
  const downloadOrigin = `http://127.0.0.1:${downloadFixture.address().port}`;
  const savedDefaults = await api(settings, "GET", "/settings/task-defaults");
  await api(settings, "POST", "/settings/task-defaults", { revision: savedDefaults.revision, values: { ...savedDefaults.values, connections: 9 } });
  for (const [kind, links, total] of [["new-task", ["single.txt"], 1], ["batch-task", ["batch-a.txt", "batch-b.txt"], 3]]) {
    const form = taskForms[kind];
    await form.locator("#m-link").fill(links.map(name => `${downloadOrigin}/${name}`).join("\n"));
    await form.locator("#submit-task-btn").click();
    await waitForNativeCondition(form, () => !document.querySelector("#download-form").inert && document.querySelector("#m-link").value === "");
    await waitForNativeCondition(main, total => Number(document.querySelector("#task-count").textContent) === total, total);
    assert.equal(await form.evaluate(() => downloadSettings.connections), 9);
    assert.equal(await main.locator("#toast").textContent(), "下载任务已添加");
    assertToastBounds(await waitForNativeCondition(main, readToastPlacement));
    assert.equal((await api(main, "GET", "/tasks?limit=100")).total, total);
  }
  await settings.locator('[data-settings-link="files"]').click();
  await waitForNativeCondition(settings, () => document.querySelectorAll("[data-group-id]").length === 8 && !document.querySelector('[data-settings-page="files"]').inert);
  await settings.locator('[data-group-id="document"] .group-name-field input').fill("Documents review");
  await settings.locator("#file-groups-save").click();
  await waitForNativeCondition(settings, () => document.querySelector("#file-groups-status").textContent.includes("\u5df2\u4fdd\u5b58"));
  assert.equal((await api(settings, "GET", "/settings/file-groups")).groups.find(group => group.id === "document").name, "Documents review");
  await main.evaluate(() => refreshAndSchedule(true));
  await waitForNativeCondition(main, () => document.querySelector('[data-task-category="document"]')?.textContent.includes("Documents review"));
  const completed = await waitUntil(async () => {
    const page = await api(main, "GET", "/tasks?limit=100");
    return page.tasks.find(task => task.status === "done");
  });
  await main.locator(`[data-action="details"][data-id="${completed.id}"]`).click();
  await waitForNativeCondition(main, () => document.querySelector("#task-info-grid").textContent.includes("Documents review"));
  await main.locator("#task-settings-tab").click();
  await waitForNativeCondition(main, () => document.querySelector("#task-setting-connections").value === "9");
  assert.equal(await main.locator("#task-settings-save").isDisabled(), true);
  await main.evaluate(() => { location.hash = "tasks"; });
  await settings.locator('[data-settings-link="general"]').click();
  const auth = await api(settings, "POST", "/auth/settings", { enabled: true });
  assert.equal(auth.enabled, true);
  assert.equal(Object.hasOwn(auth, "token"), false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/tasks?limit=1`)).status, 401);
  assert.equal((await api(main, "GET", "/system/info")).product, "TrueDown");
  const session = await context.newCDPSession(settings);
  for (const [width, height, deviceScaleFactor] of [[640, 480, 1.25], [1020, 760, 2], [1280, 900, 3]]) {
    await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
    const layout = await settings.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, footer: document.querySelector(".settings-footer").getBoundingClientRect().bottom, height: innerHeight }));
    assert.equal(layout.overflow, false);
    assert.ok(layout.footer <= layout.height);
  }
  await session.send("Emulation.clearDeviceMetricsOverride");
  const pages = { main, settings, ...taskForms };
  for (const scheme of ["light", "dark"]) await verifyAppearance(pages, scheme);
  await verifyAppearance(pages, "light", "active");
  for (const scheme of ["light", "dark"]) await verifyAppearance(pages, scheme, "none", true);
  const windows = await main.evaluate(async () => Promise.all((await window.__TAURI__.window.getAllWindows()).map(async window => ({ label: window.label, visible: await window.isVisible() }))));
  assert.equal(windows.length, 4);
  assert.ok(windows.every(window => !window.visible), "Acceptance tests must never show native windows");
  const geometry = await main.evaluate(async () => {
    const monitors = await window.__TAURI__.window.availableMonitors();
    const windows = await Promise.all((await window.__TAURI__.window.getAllWindows()).map(async entry => ({ label: entry.label, position: await entry.outerPosition(), size: await entry.outerSize() })));
    return { monitors, windows };
  });
  for (const entry of geometry.windows) {
    const viewport = await pages[entry.label].evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }));
    assert.ok(geometry.monitors.some(({ workArea: area }) => entry.position.x >= area.position.x - 1 && entry.position.y >= area.position.y - 1 && entry.position.x + entry.size.width <= area.position.x + Math.min(area.size.width, 1024) + 1 && entry.position.y + entry.size.height <= area.position.y + Math.min(area.size.height, 720) + 1), `Window escaped its 1024x720 acceptance work area: ${JSON.stringify({ window: entry, viewport, monitors: geometry.monitors })}`);
  }
  assert.deepEqual(errors, []);
  // An authenticated external client exit must stop the desktop, not trigger
  // crash recovery. Read this isolated fixture's key only in the test driver.
  const token = (await fs.readFile(path.join(storage.paths.config, "truedown.token"), "utf8")).trim();
  assert.equal((await fetch(`http://127.0.0.1:${port}/system/exit`, { method: "POST", headers: { "X-Api-Key": token } })).status, 202);
  await waitUntil(() => child.exitCode !== null, 20000);
  console.log("native_windows=ok native_task_forms=ok task_form_drafts=ok task_form_permissions=ok task_creation_refresh=ok shared_cache=ok shared_settings=ok retained_drafts=ok private_auth=ok scale_layout=ok native_theme=ok material_surfaces=ok forced_colors=ok reduced_transparency=ok core_recovery=ok orphan_cleanup=ok external_exit=ok all_windows_hidden=ok");
} finally {
  if (main && child.exitCode === null) await invoke(main, "core_request", { request: { method: "POST", path: "/system/exit" } }).catch(() => {});
  await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 20000).catch(() => child.kill());
  await browser?.close().catch(() => {});
  if (downloadFixture) await new Promise(resolve => downloadFixture.close(resolve));
  console.log(`fixture=${fixture}`);
}
assert.equal(child.exitCode, 0);

const shellCrash = launchDesktop();
shellCrash.stdout.resume(); shellCrash.stderr.resume();
let crashCore, crashEngine;
try {
  crashCore = await waitUntil(() => childrenOf(shellCrash.pid).find(process => process.Name === "truedown-core.exe"));
  crashEngine = await waitUntil(() => childrenOf(crashCore.ProcessId).find(process => process.Name === "aria2c.exe"));
  shellCrash.kill();
  await waitUntil(() => !alive(crashCore.ProcessId) && !alive(crashEngine.ProcessId), 20000);
  console.log("shell_crash_cleanup=ok");
} finally {
  if (shellCrash.exitCode === null && shellCrash.signalCode === null) shellCrash.kill();
  if (crashCore && alive(crashCore.ProcessId)) process.kill(crashCore.ProcessId);
}
