import assert from "node:assert/strict";
import { dashboardSource as source } from "./helpers/truedownSource.mjs";
import test from "node:test";
import vm from "node:vm";

function declaration(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}
function control(value = "") {
  const attributes = new Map();
  return {
    value, inert: false, textContent: "", files: [],
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    classList: { toggle() {} },
  };
}
const busyComponents = { setBusyState(button, busy) { button.setAttribute("aria-busy", busy); } };

test("task speed zero overrides a nonzero default while blank inherits it", () => {
  const fields = { mSpeed: control("0"), mConns: control("64"), mTries: control("5"), mWait: control("3"), mExtra: control("") };
  const context = vm.createContext({
    els: fields, downloadSettings: { connections: 16, maxTries: 5, retryWait: 3 },
    settingsSpeedBps: () => 1024, settingsExtraArgs: () => [],
  });
  vm.runInContext(["buildOpts", "optionalInt", "optionalIntAllowZero", "lines"].map(declaration).join("\n"), context);
  assert.equal(vm.runInContext("buildOpts('m').maxSpeedBps", context), 0);
  assert.equal(vm.runInContext("buildOpts('m').connections", context), 64);
  fields.mSpeed.value = "";
  assert.equal(vm.runInContext("buildOpts('m').maxSpeedBps", context), 1024);
});

test("refresh keeps one pending operation and never announces success after load failure", async () => {
  let complete;
  let loads = 0;
  const messages = [];
  const button = control();
  const context = vm.createContext({
    els: { refreshTasksBtn: button }, KDComponents: busyComponents,
    loadTasks: () => { loads++; return new Promise((resolve) => { complete = resolve; }); },
    showToast: (text) => messages.push(text), schedulePoll() {},
  });
  vm.runInContext(declaration("refreshTasks"), context);
  const pending = vm.runInContext("refreshTasks()", context);
  await vm.runInContext("refreshTasks()", context);
  assert.equal(loads, 1);
  assert.equal(button.getAttribute("aria-busy"), "true");
  complete(false);
  await pending;
  assert.deepEqual(messages, []);
  assert.equal(button.getAttribute("aria-busy"), "false");
});

test("task submission locks the form once and closes immediately after successful dispatch", async () => {
  let complete;
  let dispatches = 0;
  let closed = 0;
  const messages = [];
  const fields = Object.fromEntries([
    "downloadForm", "submitTaskBtn", "mTorrentFile", "mLink", "mHeaders", "mReferer", "mFolder", "mName",
  ].map((name) => [name, control()]));
  const context = vm.createContext({
    els: fields, KDComponents: busyComponents, modalMode: "single", downloadSettings: {},
    parseLinks: () => ["https://example.test/file.zip"], parseHeaders: () => ({}), mergeHeaders: () => ({}),
    emptyToUndefined: () => undefined, optionalInt: () => 0, buildOpts: () => ({}), buildModuleOptions: () => ({}),
    mapLimitSettled: () => { dispatches++; return new Promise((resolve) => { complete = resolve; }); },
    loadTasks: async () => true, closeModal: () => { closed++; },
    showToast: (text) => messages.push(text), showModalMsg: (text) => { throw new Error(text); },
    formatStartOutcome: () => "Created", schedulePoll() {},
    window: { setTimeout() { assert.fail("success must not schedule a close against a future dialog"); } },
  });
  vm.runInContext(["isNativeTaskWindow", "submitTask", "setSubmitting"].map(declaration).join("\n"), context);
  const pending = vm.runInContext("submitTask({preventDefault(){}})", context);
  assert.equal(fields.downloadForm.inert, true);
  assert.equal(fields.downloadForm.getAttribute("aria-busy"), "true");
  await vm.runInContext("submitTask({preventDefault(){}})", context);
  assert.equal(dispatches, 1);
  complete([{ status: "fulfilled", value: "OK 1" }]);
  await pending;
  assert.equal(closed, 1);
  assert.deepEqual(messages, ["Created"]);
  assert.equal(fields.downloadForm.inert, false);
  assert.equal(fields.downloadForm.getAttribute("aria-busy"), "false");
});

test("modal errors and normal status messages have distinct live-region semantics", () => {
  const message = control();
  const context = vm.createContext({ els: { modalMsg: message } });
  vm.runInContext(declaration("showModalMsg"), context);
  vm.runInContext("showModalMsg('Failed', true)", context);
  assert.equal(message.getAttribute("role"), "alert");
  assert.equal(message.getAttribute("aria-live"), "assertive");
  vm.runInContext("showModalMsg('Ready')", context);
  assert.equal(message.getAttribute("role"), "status");
  assert.equal(message.getAttribute("aria-live"), "polite");
});

test("modal keyboard navigation recovers focus that starts outside the active dialog", () => {
  let focused = "";
  let prevented = false;
  const first = { focus() { focused = "first"; }, getClientRects: () => [1], closest: () => null };
  const last = { focus() { focused = "last"; }, getClientRects: () => [1], closest: () => null };
  const closedOverlay = { classList: { contains: () => false } };
  const overlay = { classList: { contains: () => true }, querySelectorAll: () => [first, last] };
  const context = vm.createContext({
    els: { dialogOverlay: closedOverlay, settingsOverlay: closedOverlay, overlay },
    document: { activeElement: {} },
    event: { key: "Tab", shiftKey: true, preventDefault() { prevented = true; } },
  });
  vm.runInContext(["isNativeTaskWindow", "onDocumentKeydown"].map(declaration).join("\n"), context);
  vm.runInContext("onDocumentKeydown(event)", context);
  assert.equal(focused, "last");
  assert.equal(prevented, true);
});

test("busy modal keyboard navigation keeps focus on the overlay while its form is inert", () => {
  let focused = false;
  let prevented = false;
  const inertInput = { getClientRects: () => [1], closest: () => ({ inert: true }) };
  const closedOverlay = { classList: { contains: () => false } };
  const overlay = {
    classList: { contains: () => true }, querySelectorAll: () => [inertInput],
    focus() { focused = true; },
  };
  const context = vm.createContext({
    els: { dialogOverlay: closedOverlay, settingsOverlay: closedOverlay, overlay },
    event: { key: "Tab", preventDefault() { prevented = true; } },
  });
  vm.runInContext(["isNativeTaskWindow", "onDocumentKeydown"].map(declaration).join("\n"), context);
  vm.runInContext("onDocumentKeydown(event)", context);
  assert.equal(focused, true);
  assert.equal(prevented, true);
});

test("closing a nested dialog preserves the scroll lock of an underlying modal", () => {
  let locked = false;
  let settingsOpen = true;
  const closedOverlay = { classList: { contains: () => false } };
  const context = vm.createContext({
    els: {
      dialogOverlay: closedOverlay, settingsOverlay: closedOverlay,
      overlay: { classList: { contains: () => settingsOpen } },
    },
    document: { body: { classList: { toggle(name, active) { assert.equal(name, "modal-open"); locked = active; } } } },
  });
  vm.runInContext(declaration("syncModalScrollLock"), context);
  vm.runInContext("syncModalScrollLock()", context);
  assert.equal(locked, true);
  settingsOpen = false;
  vm.runInContext("syncModalScrollLock()", context);
  assert.equal(locked, false);
});

test("settings navigation stays immediate and a late category read never overwrites another page", async () => {
  let complete;
  let loads = 0;
  let rendered = 0;
  const panels = { general: { inert: false }, advanced: { inert: false } };
  const fields = Object.fromEntries(["settingsFooter", "settingsSaveStatus", "settingsReloadBtn", "settingsSaveBtn", "settingsResetBtn", "settingsLoadStatus"].map((name) => [name, control()]));
  const context = vm.createContext({
    els: fields, currentPage: "settings", currentSettingsPage: "general", routeEpoch: 1,
    settingsLoads: new Map(), settingsReady: new Set(), settingsRendered: new Set(), settingsMessages: new Map(),
    EDITABLE_SETTINGS_PAGES: new Set(["general", "advanced"]),
    document: { querySelectorAll: () => [] },
    settingsPanels: (page) => [panels[page]],
    loadServerRuntimeSettings: () => { loads++; return new Promise((resolve) => { complete = resolve; }); },
    loadServerTaskDefaults() {}, loadServerDownloadRules() {}, loadSettingsOverview() {}, loadStartupSettings() {},
    loadFileGroupsEditor() {}, loadResolverModules() {}, loadAuthSettings() {}, loadTrackerResearchSettings() {},
    renderSettingsCategory() { rendered++; }, renderSettingsOverview() {},
  });
  vm.runInContext(declaration("initializeSettingsCategory") + "\n" + declaration("loadSettingsPage"), context);
  const first = context.loadSettingsPage();
  const second = context.loadSettingsPage();
  await Promise.resolve();
  assert.equal(loads, 1);
  assert.equal(panels.general.inert, true);
  context.currentSettingsPage = "advanced";
  context.routeEpoch++;
  await context.loadSettingsPage();
  assert.equal(rendered, 1);
  assert.equal(panels.advanced.inert, false);
  complete();
  await Promise.all([first, second]);
  assert.equal(rendered, 1, "late runtime settings must not reset an advanced draft");
  assert.equal(context.settingsReady.has("general"), true);
});

test("single-task removal preserves selection on failure and clears it before a successful refresh", async () => {
  const selectedTaskIDs = new Set([7]);
  const taskStatusByID = new Map([[7, "done"]]);
  let fail = true;
  let synced = 0;
  const context = vm.createContext({
    currentPage: "tasks", selectedTaskIDs, taskStatusByID,
    requestJSON: async () => fail ? { failed: [{ error: "database unavailable" }] } : { succeeded: [7] },
    syncSelectionControls() { synced++; }, showToast() {},
    loadTasks: async () => { assert.equal(selectedTaskIDs.size, 0); assert.equal(taskStatusByID.size, 0); },
  });
  vm.runInContext(declaration("runTaskAction"), context);
  await assert.rejects(context.runTaskAction("remove", 7, "Removed"), /database unavailable/);
  assert.equal(selectedTaskIDs.has(7), true);
  assert.equal(taskStatusByID.get(7), "done");
  assert.equal(synced, 0);
  fail = false;
  await context.runTaskAction("remove", 7, "Removed");
  assert.equal(synced, 1);
});

test("a pending row operation stays busy after polling and cannot be dispatched twice", async () => {
  const button = control();
  button.dataset = { action: "pause", id: "7" };
  let complete;
  let writes = 0;
  const context = vm.createContext({
    els: { tasksContainer: { querySelectorAll: () => [button] } },
    activeTaskActions: new Set(), KDComponents: busyComponents,
    runTaskAction: () => { writes++; return new Promise((resolve) => { complete = resolve; }); },
    iconMarkup: () => "", showToast() {},
  });
  vm.runInContext(["onTaskAction", "setTaskActionBusy", "actionButton"].map(declaration).join("\n"), context);
  const event = { target: { closest: () => button } };
  const pending = context.onTaskAction(event);
  await context.onTaskAction(event);
  assert.equal(writes, 1);
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.match(context.actionButton("pause", 7, "Pause"), /disabled aria-busy="true"/);
  complete();
  await pending;
  assert.equal(context.activeTaskActions.size, 0);
  assert.doesNotMatch(context.actionButton("pause", 7, "Pause"), /disabled/);
});

test("a changed task page preserves keyboard focus on the same row control", () => {
  const row = { dataset: { taskId: "7" } };
  const original = { dataset: { selectTask: "" }, closest: () => row };
  let restored = false;
  const replacement = { dataset: { selectTask: "" }, closest: () => row, focus() { restored = true; } };
  const context = vm.createContext({
    document: { activeElement: original },
    els: { tasksContainer: { contains: (element) => element === original, querySelectorAll: () => [replacement], querySelector: () => ({ dataset: { sort: "status:asc" }, querySelector: () => ({}) }) } },
    currentTasks: [], selectedTaskIDs: new Set(), taskStatusByID: new Map(),
    fileGroupsState: { revision: 0 }, taskDetailReturnID: 0, currentCategory: "", currentOffset: 0, currentFilter: "all", currentSearch: "", currentSort: "status", currentSortOrder: "asc",
    lastTaskRenderSignature: "", syncSelectionControls() {}, taskRow: () => "", sortableHeading: () => "",
    reconcileTaskRows() { context.document.activeElement = null; },
  });
  vm.runInContext(["renderTasks", "taskControlKey"].map(declaration).join("\n"), context);
  context.renderTasks([{ id: 7, status: "downloading", progress: "25%" }]);
  assert.equal(restored, true);
});

test("progress polling retains every row control and changes only its progress label", () => {
  const task = { id: 7, status: "downloading", name: "file.zip", progress: "25%" };
  const progress = { textContent: "20%", title: "20%" };
  const ordinal = { textContent: "1" };
  const checkbox = { checked: true };
  const row = {
    dataset: { taskId: "7" },
    taskShape: JSON.stringify([task.status, task.outputName, task.name, task.folder, task.link, task.error, task.category, "Other", "file"]),
    querySelector: (query) => query === ".progress-line" ? progress : query === ".task-index" ? ordinal : checkbox,
  };
  const body = { children: [row], insertBefore() { assert.fail("unchanged rows must not be moved"); } };
  const context = vm.createContext({
    document: { createElement() { assert.fail("progress-only refresh must not parse replacement HTML"); } },
    currentOffset: 0, selectedTaskIDs: new Set([7]),
    taskCategoryMeta: () => ({ label: "Other", icon: "file" }), taskProgressLabel: task => task.progress,
    taskProgressPercent: () => 25, taskBytes: () => "-", taskSpeed: () => "-", taskRemaining: () => "-", taskDate: () => "-",
  });
  vm.runInContext(declaration("reconcileTaskRows"), context);
  context.reconcileTaskRows(body, [task]);
  assert.equal(body.children[0], row);
  assert.equal(progress.textContent, "25%");
  assert.equal(progress.title, "25%");
  assert.equal(checkbox.checked, true);
});

test("a settings read started before a mutation cannot overwrite its persisted result", async () => {
  let complete;
  let value = "saved";
  const context = vm.createContext({
    settingReadVersions: new Map(), settingReadRequests: new Map(), settingSnapshotsKnown: new Set(),
    requestJSON: () => new Promise((resolve) => { complete = resolve; }),
  });
  vm.runInContext(["invalidateSettingRead", "readSettingSnapshot"].map(declaration).join("\n"), context);
  const pending = context.readSettingSnapshot("runtime", "/settings/runtime", (next) => { value = next; });
  context.invalidateSettingRead("runtime");
  complete("stale");
  await pending;
  assert.equal(value, "saved");
});
test("legacy defaults import never overwrites an already configured profile", async () => {
  let reads = 0, writes = 0, removed = false;
  const context = vm.createContext({
    DEFAULT_DOWNLOAD_SETTINGS: { connections: 16 }, taskDefaultsRevision: 0, taskDefaultsLoad: null,
    DOWNLOAD_DEFAULTS_KEY: "legacy", downloadSettings: {},
    localStorage: { getItem: () => '{"connections":8}', removeItem: () => { removed = true; } },
    loadDownloadSettings: () => ({ connections: 8 }),
    requestJSON: async (_path, options) => {
      if (options?.method === "POST") { writes++; throw Object.assign(new Error("conflict"), { status: 409 }); }
      reads++;
      return reads === 1 ? { revision: 0, values: { connections: 16 } } : { revision: 2, values: { connections: 4 } };
    },
  });
  vm.runInContext(["applyTaskDefaults", "loadServerTaskDefaults"].map(declaration).join("\n"), context);
  await Promise.all([context.loadServerTaskDefaults(), context.loadServerTaskDefaults()]);
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.equal(context.downloadSettings.connections, 4);
  assert.equal(removed, true);
  context.applyTaskDefaults({ revision: 1, values: { connections: 32 } });
  assert.equal(context.downloadSettings.connections, 4, "late reads must not regress persisted preferences");
});

test("failed legacy preferences import retains local data for retry", async () => {
  let removed = false;
  const context = vm.createContext({
    DEFAULT_DOWNLOAD_SETTINGS: {}, taskDefaultsRevision: 0, taskDefaultsLoad: null,
    DOWNLOAD_DEFAULTS_KEY: "legacy", downloadSettings: {},
    localStorage: { getItem: () => '{}', removeItem: () => { removed = true; } },
    loadDownloadSettings: () => ({}),
    requestJSON: async (_path, options) => {
      if (options?.method === "POST") throw new Error("disk full");
      return { revision: 0, values: {} };
    },
  });
  vm.runInContext(["applyTaskDefaults", "loadServerTaskDefaults"].map(declaration).join("\n"), context);
  await assert.rejects(context.loadServerTaskDefaults(), /disk full/);
  assert.equal(removed, false);
  assert.equal(context.taskDefaultsLoad, null);
});
