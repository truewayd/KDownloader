import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dashboardSource } from "./helpers/truedownSource.mjs";

function declarations(...names) {
  return names.map(name => {
    const found = dashboardSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(found, name);
    return found[0];
  }).join("\n");
}

test("settings loaded after navigation initialize once on return and retain later drafts", async () => {
  let finish;
  const renders = [];
  const context = vm.createContext({
    currentSettingsPage: "general", currentPage: "settings", routeEpoch: 1,
    settingsReady: new Set(), settingsRendered: new Set(), settingsLoads: new Map(), settingsMessages: new Map(),
    EDITABLE_SETTINGS_PAGES: new Set(["general"]),
    els: Object.fromEntries(["settingsFooter", "settingsSaveStatus", "settingsReloadBtn", "settingsSaveBtn", "settingsResetBtn", "settingsLoadStatus"].map(id => [id, {}])),
    document: { querySelectorAll: () => [] }, settingsPanels: () => [],
    loadServerTaskDefaults: () => new Promise(resolve => { finish = resolve; }),
    loadServerRuntimeSettings: async () => {}, loadServerDownloadRules() {}, loadFileGroupsEditor() {},
    loadStartupSettings() {}, loadStorageLocation() {}, loadResolverModules() {}, loadSystemUpdateState() {},
    loadTrackerResearchSettings() {}, loadAuthSettings() {}, renderTrackerResearchSettings() {},
    renderSettingsCategory: page => renders.push(page),
  });
  vm.runInContext(declarations("loadSettingsPage", "initializeSettingsCategory"), context);
  const pending = context.loadSettingsPage();
  await Promise.resolve();
  context.currentSettingsPage = "network";
  context.routeEpoch++;
  finish();
  await pending;
  assert.equal(context.settingsReady.has("general"), true);
  assert.deepEqual(renders, []);
  context.currentSettingsPage = "general";
  context.routeEpoch++;
  await context.loadSettingsPage();
  assert.deepEqual(renders, ["general"]);
  await context.loadSettingsPage();
  assert.deepEqual(renders, ["general"], "returning again preserves edited controls");
});

test("log cancellation releases busy UI and an old completion cannot clear a newer read", async () => {
  const completions = [], busy = [];
  const context = vm.createContext({
    applicationLogRequest: 0, applicationLogAbort: null, applicationLogTimer: 0,
    currentPage: "settings", currentSettingsPage: "logs", routeEpoch: 1,
    document: { hidden: false }, els: { refreshApplicationLogBtn: {} },
    AbortController, AbortSignal, clearTimeout, setTimeout,
    KDComponents: { setBusyState: (_, value) => busy.push(value) },
    requestJSON: () => new Promise(resolve => completions.push(resolve)),
  });
  vm.runInContext(declarations("isApplicationLogPage", "stopApplicationLog", "loadApplicationLog"), context);
  const first = context.loadApplicationLog();
  context.stopApplicationLog();
  assert.deepEqual(busy, [true, false]);
  const second = context.loadApplicationLog();
  completions[0]({});
  await first;
  assert.deepEqual(busy, [true, false, true]);
  context.stopApplicationLog();
  completions[1]({});
  await second;
  assert.equal(busy.at(-1), false);
});

test("late native subscription completion is disposed exactly once after page closure", async () => {
  let complete, receive, disposals = 0, delivered = 0;
  const window = new EventTarget();
  window.__TAURI__ = { event: { listen: (_name, callback) => {
    receive = callback;
    return new Promise(resolve => { complete = resolve; });
  } } };
  const context = vm.createContext({ window });
  vm.runInContext(declarations("listenNativeEvent"), context);
  const pending = context.listenNativeEvent("truedown:tasks-created", () => delivered++);
  window.dispatchEvent(new Event("pagehide"));
  complete(() => disposals++);
  await pending;
  receive({});
  window.dispatchEvent(new Event("pagehide"));
  assert.equal(disposals, 1);
  assert.equal(delivered, 0);
});

test("native reads have a deadline, normalize methods and never retry an uncertain request", async () => {
  const deadlines = [], calls = [];
  const timeout = new AbortController();
  const context = vm.createContext({
    Headers, Response, DOMException, nativeDesktopState: null,
    AbortSignal: { timeout: ms => { deadlines.push(ms); return timeout.signal; } },
    invokeNative: (command, args) => {
      calls.push({ command, args });
      return new Promise(() => {});
    },
  });
  vm.runInContext(declarations("apiRequestSignal", "nativeFetch"), context);
  const pending = context.nativeFetch("/tasks", { method: "get" });
  timeout.abort(new DOMException("Timed out", "TimeoutError"));
  await assert.rejects(pending, { name: "TimeoutError" });
  assert.deepEqual(deadlines, [15000]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.request.method, "GET");
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(context.nativeFetch("/tasks", { signal: cancelled.signal }), { name: "AbortError" });
  assert.equal(calls.length, 1);
});

test("a completed save from another task cannot clear the current task's busy state", async () => {
  const controls = new Map();
  const requests = [];
  const context = vm.createContext({
    taskDetailID: 1, currentPage: "task", routeEpoch: 1, taskDetailData: { id: 1, status: "paused" },
    taskDetailDrafts: new Map([1, 2].map(id => [id, { revision: `r${id}`, values: { connections: 8 } }])),
    document: { getElementById: id => {
      if (!controls.has(id)) controls.set(id, { disabled: false });
      return controls.get(id);
    } },
    KDComponents: { setBusyState: (button, busy) => { button.busy = busy; } },
    stopTaskDetails() {}, loadTaskDetails() {},
    requestJSON: () => new Promise(resolve => requests.push(resolve)),
  });
  vm.runInContext(declarations("saveTaskDetails", "syncTaskSettingsBusy"), context);
  const first = context.saveTaskDetails({ preventDefault() {} });
  context.taskDetailID = 2;
  context.taskDetailData = { id: 2, status: "paused" };
  context.routeEpoch++;
  context.syncTaskSettingsBusy();
  const second = context.saveTaskDetails({ preventDefault() {} });
  requests[0]({ settingsRevision: "saved1", settings: { connections: 8 } });
  await first;
  assert.equal(controls.get("task-settings-save").busy, true);
  assert.equal(controls.get("task-settings-save").disabled, true);
  assert.equal(controls.get("task-settings-reload").disabled, true);
  requests[1]({ settingsRevision: "saved2", settings: { connections: 8 } });
  await second;
  assert.equal(controls.get("task-settings-save").busy, false);
  assert.equal(controls.get("task-settings-reload").disabled, false);
});
