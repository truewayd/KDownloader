import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dashboardSource as source } from "./helpers/truedownSource.mjs";

function declarations(...names) {
  return names.map((name) => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
}

function control(value = "") {
  const attributes = new Map();
  const listeners = new Map();
  return {
    value, files: [], inert: false, textContent: "", isConnected: true,
    classList: { contains: () => true, toggle() {}, add() {} },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute: (name) => attributes.get(name),
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    emit(name) { for (const callback of listeners.get(name) || []) callback(); },
    focus() {},
  };
}
const busyComponents = { setBusyState(button, busy) { button.setAttribute("aria-busy", busy); } };

test("desktop add actions open separate native forms without loading preferences in the main window", async () => {
  const opened = [];
  const context = vm.createContext({
    nativeWindowRole: "main", KDComponents: busyComponents,
    els: { downloadForm: control(), newTaskBtn: control(), batchTaskBtn: control() },
    invokeNative: async (command, args) => opened.push([command, args.kind]),
    showToast: assert.fail,
  });
  vm.runInContext(declarations("openModal"), context);
  await context.openModal("single");
  await context.openModal("batch");
  assert.deepEqual(opened, [["open_auxiliary", "new-task"], ["open_auxiliary", "batch-task"]]);
  assert.equal(context.els.newTaskBtn.getAttribute("aria-busy"), "false");
});

test("hiding a native form retains every draft and delegates window shortcuts to the native frame", async () => {
  const actions = [];
  const fields = { overlay: control(), dialogOverlay: control(), mLink: control("https://example.test/draft.zip"), mHeaders: control('{"X-Test":"draft"}') };
  fields.dialogOverlay.classList.contains = () => false;
  const context = vm.createContext({
    nativeWindowRole: "new-task", els: fields,
    invokeNative: async (command) => actions.push(command), showModalMsg: assert.fail,
  });
  vm.runInContext(declarations("isNativeTaskWindow", "closeModal", "onDocumentKeydown"), context);
  context.closeModal();
  context.onDocumentKeydown({ key: "Tab", preventDefault: assert.fail });
  context.onDocumentKeydown({ key: "Escape", preventDefault: assert.fail });
  assert.deepEqual(actions, ["close_auxiliary"]);
  assert.equal(fields.mLink.value, "https://example.test/draft.zip");
  assert.equal(fields.mHeaders.value, '{"X-Test":"draft"}');
});

test("native task completion confirms in the main window without changing the selected task filter", async () => {
  let receive;
  const messages = [];
  const refreshes = [];
  const context = vm.createContext({
    currentPage: "tasks", currentFilter: "done",
    window: {
      __TAURI__: { event: { listen: async (_event, callback) => { receive = callback; return () => {}; } } },
      addEventListener() {},
    },
    refreshAndSchedule: (force) => refreshes.push(force), showToast: (message) => messages.push(message),
  });
  vm.runInContext(declarations("subscribeToCreatedTasks"), context);
  await context.subscribeToCreatedTasks();
  receive();
  assert.deepEqual(refreshes, [true]);
  assert.deepEqual(messages, ["下载任务已添加"]);
  assert.equal(context.currentFilter, "done");
});

test("native form startup reads only its permitted preferences and retries without polling tasks", async () => {
  const actions = [];
  let fail = true;
  const surface = control();
  const form = control();
  form.closest = () => surface;
  const shell = {};
  const context = vm.createContext({
    nativeWindowRole: "batch-task", nativeTaskFormLoad: null, nativeTaskFormReady: false,
    currentPage: "tasks", KDComponents: busyComponents,
    els: { downloadForm: form, overlay: control(), modalCloseBtn: control(), modalCancelBtn: control(), submitTaskBtn: control(), mLink: control("draft") },
    document: { querySelector: () => shell },
    refreshNativeTaskPreferences: async () => { actions.push("preferences"); if (fail) throw Error("offline"); },
    configureTaskForm: (mode) => actions.push(mode), showModalMsg() {},
  });
  vm.runInContext(declarations("initNativeTaskForm"), context);
  await context.initNativeTaskForm();
  assert.equal(context.nativeTaskFormReady, false);
  assert.equal(context.els.submitTaskBtn.textContent, "重新读取默认值");
  assert.equal(context.currentPage, "batch-task");
  assert.equal(context.els.mLink.value, "draft");
  assert.equal(surface.getAttribute("role"), "main");
  fail = false;
  await context.initNativeTaskForm();
  assert.equal(context.nativeTaskFormReady, true);
  assert.equal(shell.hidden, true);
  assert.deepEqual(actions, ["preferences", "preferences", "batch"]);
});

test("a submitted native task never fetches task pages or reports a window-close failure as failed dispatch", async () => {
  const actions = [];
  const messages = [];
  const fields = Object.fromEntries([
    "downloadForm", "submitTaskBtn", "mTorrentFile", "mLink", "mHeaders", "mReferer", "mFolder", "mName",
  ].map((name) => [name, control()]));
  fields.mLink.value = "https://example.test/download.zip";
  const context = vm.createContext({
    nativeWindowRole: "new-task", nativeTaskFormReady: true,
    els: fields, KDComponents: busyComponents, modalMode: "single", downloadSettings: {},
    refreshNativeTaskPreferences: async () => {},
    parseLinks: () => [fields.mLink.value], parseHeaders: () => ({}), mergeHeaders: () => ({}),
    emptyToUndefined: () => undefined, optionalInt: () => 0, buildOpts: () => ({}), buildModuleOptions: () => ({}),
    mapLimitSettled: async () => [{ status: "fulfilled", value: "OK 1" }],
    loadTasks: assert.fail, closeModal: assert.fail, showToast: assert.fail,
    showModalMsg: (message) => messages.push(message), formatStartOutcome: () => "Task created",
    invokeNative: async (command) => { actions.push(command); throw Error("focus failed"); },
    schedulePoll() {},
  });
  vm.runInContext(declarations("isNativeTaskWindow", "submitTask", "setSubmitting", "finishNativeTaskForm"), context);
  await context.submitTask({ preventDefault() {} });
  assert.deepEqual(actions, ["finish_task_window"]);
  assert.equal(fields.mLink.value, "");
  assert.equal(fields.downloadForm.inert, false);
  assert.ok(messages.every((message) => message.startsWith("Task created")));
  assert.ok(messages.at(-1).includes("focus failed"));
});

test("native submission refreshes inherited preferences, preserves explicit drafts, and blocks dispatch on a failed read", async () => {
  const fields = Object.fromEntries([
    "downloadForm", "submitTaskBtn", "mTorrentFile", "mLink", "mHeaders", "mReferer", "mFolder", "mName",
  ].map((name) => [name, control()]));
  fields.mLink.value = "https://example.test/download.zip";
  fields.mFolder.value = "/explicit draft";
  const outcomes = [];
  const requests = [];
  let readFails = false;
  let completeRead;
  let holdRead = true;
  const context = vm.createContext({
    nativeWindowRole: "new-task", nativeTaskFormReady: true,
    els: fields, KDComponents: busyComponents, modalMode: "single", downloadSettings: { folder: "/old default", connections: 16 },
    refreshNativeTaskPreferences: async () => {
      requests.push("preferences");
      if (readFails) throw Error("offline");
      if (holdRead) await new Promise((resolve) => { completeRead = resolve; });
      Object.assign(context.downloadSettings, { folder: "/new default", connections: 8 });
    },
    parseLinks: () => [fields.mLink.value], parseHeaders: () => ({}), mergeHeaders: () => ({}),
    emptyToUndefined: (value) => value || undefined, optionalInt: () => 0,
    buildOpts: () => ({ connections: context.downloadSettings.connections }), buildModuleOptions: () => ({}),
    isBitTorrentLink: () => false,
    buildStartBody: (link, body) => { outcomes.push({ link, ...body }); return {}; },
    requestText: async () => "OK 1",
    mapLimitSettled: async (links, _limit, submit) => [{ status: "fulfilled", value: await submit(links[0]) }],
    loadTasks: assert.fail, showModalMsg() {}, formatStartOutcome: () => "created",
    finishNativeTaskForm() {}, schedulePoll() {},
  });
  vm.runInContext(declarations("isNativeTaskWindow", "submitTask", "setSubmitting"), context);
  const firstSubmission = context.submitTask({ preventDefault() {} });
  assert.equal(fields.downloadForm.inert, true);
  await context.submitTask({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(outcomes.length, 0);
  holdRead = false;
  completeRead();
  await firstSubmission;
  assert.equal(outcomes[0].folder, "/explicit draft");
  assert.equal(outcomes[0].opts.connections, 8);
  fields.mLink.value = "https://example.test/second.zip";
  fields.mFolder.value = "";
  await context.submitTask({ preventDefault() {} });
  assert.equal(outcomes[1].folder, "/new default");
  readFails = true;
  fields.mLink.value = "https://example.test/retry.zip";
  await context.submitTask({ preventDefault() {} });
  assert.equal(outcomes.length, 2);
  assert.equal(fields.mLink.value, "https://example.test/retry.zip");
  assert.equal(fields.downloadForm.inert, false);
  assert.deepEqual(requests, Array(3).fill("preferences"));
});

function preferencesContext(requestJSON) {
  const events = new Map();
  const context = vm.createContext({
    nativeWindowRole: "new-task", nativeTaskFormReady: true,
    nativeTaskPreferences: { pending: null, requested: false, disposed: false, modeDirty: false, filterDirty: false },
    downloadRules: { enabled: false, dropboxMode: "direct" }, resolverModules: [], downloadSettings: {},
    els: Object.fromEntries(["mDropboxMode", "mDropboxFilter", "mDropboxOption", "mGoogleDriveOption", "mResolverOptions", "mLink", "mTorrentFile"].map((name) => [name, control()])),
    requestJSON, normalizeServerDownloadRules: (rules) => rules, normalizeResolverModules: (result) => result.modules,
    applyTaskDefaults: (defaults) => { context.downloadSettings = defaults.values; },
    showModalMsg: assert.fail, document: { hidden: false },
    window: {
      addEventListener: (name, callback) => events.set(name, callback),
      removeEventListener: (name) => events.delete(name),
    },
  });
  vm.runInContext(declarations("isNativeTaskWindow", "isModuleInstalled", "bindNativeTaskPreferences", "refreshNativeTaskFormOnActivation", "refreshNativeTaskPreferences", "renderModuleAvailability", "updateDropboxOptions"), context);
  context.bindNativeTaskPreferences();
  return { context, events };
}

test("native form activation updates enabled modules and untouched rules while retaining explicit drafts", async () => {
  let installed = false, mode = "direct", filter = false;
  const calls = [];
  const { context, events } = preferencesContext(async (url) => {
    calls.push(url);
    if (url === "/settings/task-defaults") return { values: { folder: "/latest" } };
    if (url === "/settings/download-rules") return { dropboxMode: mode, enabled: filter };
    if (url === "/modules") return { modules: [{ id: "dropbox", installed }] };
    assert.fail(url);
  });
  const fields = context.els;
  fields.mLink.value = "https://example.test/draft.zip";
  fields.mTorrentFile.value = "draft.torrent";
  const file = { name: "draft.torrent" };
  fields.mTorrentFile.files = [file];
  await context.refreshNativeTaskPreferences();
  assert.equal(fields.mDropboxOption.hidden, true);
  installed = true; mode = "expand"; filter = true;
  context.document.hidden = true;
  events.get("focus")();
  assert.equal(calls.length, 3, "hidden forms never refresh on focus");
  context.document.hidden = false;
  events.get("focus")();
  await context.nativeTaskPreferences.pending;
  assert.equal(fields.mDropboxOption.hidden, false);
  assert.equal(fields.mDropboxMode.value, "expand");
  assert.equal(fields.mDropboxFilter.checked, true);
  fields.mDropboxMode.emit("change"); // An explicit same-value choice remains a draft.
  fields.mDropboxFilter.checked = false;
  fields.mDropboxFilter.emit("change");
  mode = "direct";
  events.get("focus")();
  await context.nativeTaskPreferences.pending;
  assert.equal(fields.mDropboxMode.value, "expand");
  assert.equal(fields.mDropboxFilter.checked, false);
  installed = false;
  events.get("focus")();
  await context.nativeTaskPreferences.pending;
  assert.equal(fields.mDropboxOption.hidden, true);
  installed = true;
  events.get("focus")();
  await context.nativeTaskPreferences.pending;
  assert.equal(fields.mDropboxOption.hidden, false);
  assert.equal(fields.mLink.value, "https://example.test/draft.zip");
  assert.equal(fields.mTorrentFile.value, "draft.torrent");
  assert.equal(fields.mTorrentFile.files[0], file);
  assert.equal(fields.mDropboxMode.value, "expand");
  assert.equal(fields.mDropboxFilter.checked, false);
  assert.equal(calls.length, 15);
});

test("overlapping activations discard an older whole snapshot and protect edits made during reads", async () => {
  const pending = [];
  const { context } = preferencesContext((url) => new Promise((resolve) => pending.push({ url, resolve })));
  const first = context.refreshNativeTaskPreferences();
  const second = context.refreshNativeTaskPreferences();
  assert.equal(pending.length, 3, "only one three-request cohort is active");
  pending.shift().resolve({ values: { folder: "/stale" } });
  pending.shift().resolve({ dropboxMode: "expand", enabled: true });
  pending.shift().resolve({ modules: [{ id: "dropbox", installed: true }] });
  await new Promise(setImmediate);
  assert.equal(pending.length, 3);
  assert.equal(context.downloadSettings.folder, undefined, "the old snapshot was never applied");
  context.els.mDropboxMode.value = "direct";
  context.els.mDropboxMode.emit("change");
  pending.shift().resolve({ values: { folder: "/current" } });
  pending.shift().resolve({ dropboxMode: "expand", enabled: true });
  pending.shift().resolve({ modules: [{ id: "dropbox", installed: false }] });
  await Promise.all([first, second]);
  assert.equal(context.downloadSettings.folder, "/current");
  assert.equal(context.els.mDropboxMode.value, "direct");
  assert.equal(context.els.mDropboxFilter.checked, true);
  assert.equal(context.els.mDropboxOption.hidden, true);
  assert.equal(context.nativeTaskPreferences.pending, null);
});

test("failed preference cohorts leave the entire previous snapshot intact and can retry", async () => {
  let completeModules;
  let fail = true;
  const { context } = preferencesContext(async (url) => {
    if (url === "/settings/task-defaults") return { values: { folder: "/new" } };
    if (url === "/settings/download-rules") { if (fail) throw Error("rules unavailable"); return { dropboxMode: "expand", enabled: true }; }
    if (fail) await new Promise((resolve) => { completeModules = resolve; });
    return { modules: [{ id: "dropbox", installed: true }] };
  });
  context.downloadSettings.folder = "/old";
  const failed = context.refreshNativeTaskPreferences();
  await new Promise(setImmediate);
  assert.equal(context.downloadSettings.folder, "/old");
  assert.notEqual(context.nativeTaskPreferences.pending, null, "failed cohorts drain their outstanding reads");
  completeModules();
  await assert.rejects(failed, /rules unavailable/);
  assert.equal(context.downloadSettings.folder, "/old");
  assert.equal(context.downloadRules.dropboxMode, "direct");
  assert.equal(context.resolverModules.length, 0);
  fail = false;
  await context.refreshNativeTaskPreferences();
  assert.equal(context.downloadSettings.folder, "/new");
  assert.equal(context.els.mDropboxMode.value, "expand");
});

test("native page teardown removes activation subscription and discards pending preference results", async () => {
  const pending = [];
  const { context, events } = preferencesContext(() => new Promise((resolve) => pending.push(resolve)));
  const refresh = context.refreshNativeTaskPreferences();
  events.get("pagehide")();
  assert.equal(events.has("focus"), false);
  pending[0]({ values: { folder: "/late" } });
  pending[1]({ dropboxMode: "expand", enabled: true });
  pending[2]({ modules: [] });
  await refresh;
  assert.equal(context.downloadSettings.folder, undefined);
  assert.equal(context.nativeTaskPreferences.pending, null);
});
