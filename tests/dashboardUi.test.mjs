import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = (await readFile(new URL("../truedown/web/app.js", import.meta.url), "utf8")).replace(/\r\n?/g, "\n");
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
  vm.runInContext(["submitTask", "setSubmitting"].map(declaration).join("\n"), context);
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
    els: { dialogOverlay: closedOverlay, settingsOverlay: overlay, overlay: closedOverlay },
    document: { activeElement: {} },
    event: { key: "Tab", shiftKey: true, preventDefault() { prevented = true; } },
  });
  vm.runInContext(declaration("onDocumentKeydown"), context);
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
    els: { dialogOverlay: closedOverlay, settingsOverlay: overlay, overlay: closedOverlay },
    event: { key: "Tab", preventDefault() { prevented = true; } },
  });
  vm.runInContext(declaration("onDocumentKeydown"), context);
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
      dialogOverlay: closedOverlay, overlay: closedOverlay,
      settingsOverlay: { classList: { contains: () => settingsOpen } },
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

test("opening settings coalesces clicks and waits for failed refresh siblings before exposing editable controls", async () => {
  const button = control();
  const requests = [];
  let opened = 0;
  let rendered = 0;
  const context = vm.createContext({
    els: {
      settingsBtn: button, settingsForm: { inert: false }, cfgFolder: { focus() {} },
      settingsOverlay: { classList: { contains: () => opened > 0, add() { opened++; } }, setAttribute() {}, removeAttribute() {} },
    },
    KDComponents: busyComponents,
    document: { body: { classList: { add() {} } } },
    renderDownloadSettings() { rendered++; }, renderResolverModules() {}, showToast() {},
  });
  for (const name of ["loadServerDownloadRules", "loadServerRuntimeSettings", "loadTrackerResearchSettings",
    "loadResolverModules", "loadSystemUpdateState", "loadApplicationLog"]) {
    context[name] = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
  }
  vm.runInContext(declaration("openSettingsModal"), context);
  const pending = context.openSettingsModal();
  await context.openSettingsModal();
  assert.equal(requests.length, 6);
  requests[0].reject(new Error("unavailable"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(opened, 0);
  assert.equal(button.getAttribute("aria-busy"), "true");
  requests.slice(1).forEach(({ resolve }) => resolve({}));
  await pending;
  assert.equal(opened, 1);
  assert.equal(rendered, 1);
  await context.openSettingsModal();
  assert.equal(requests.length, 6);
});

test("single-task removal preserves selection on failure and clears it before a successful refresh", async () => {
  const selectedTaskIDs = new Set([7]);
  const taskStatusByID = new Map([[7, "done"]]);
  let fail = true;
  let synced = 0;
  const context = vm.createContext({
    selectedTaskIDs, taskStatusByID,
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
    els: { tasksContainer: { contains: (element) => element === original, querySelectorAll: () => [replacement] } },
    currentTasks: [], selectedTaskIDs: new Set(), taskStatusByID: new Map(),
    currentOffset: 0, currentFilter: "all", currentSearch: "", currentSort: "status", currentSortOrder: "asc",
    lastTaskRenderSignature: "", syncSelectionControls() {}, taskRow: () => "", sortableHeading: () => "",
  });
  vm.runInContext(["renderTasks", "taskControlKey"].map(declaration).join("\n"), context);
  context.renderTasks([{ id: 7, status: "downloading", progress: "25%" }]);
  assert.equal(restored, true);
});
