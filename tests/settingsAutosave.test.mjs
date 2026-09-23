import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dashboardSource } from "./helpers/truedownSource.mjs";

function declarations(...names) {
  return names.map(name => dashboardSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]).join("\n");
}

test("reset requires confirmation, ignores stale navigation and immediately persists only the selected category", async () => {
  let answer, saves = 0;
  const rendered = [];
  const context = vm.createContext({
    currentSettingsPage: "files", routeEpoch: 1, settingsReady: new Set(["files"]),
    settingsDirtyControls: new Map(), settingsPanels: () => [],
    EDITABLE_SETTINGS_PAGES: new Set(["files"]), traySaving: false, updatePreferenceSaving: false,
    pendingResolverModuleActions: new Set(), els: { settingsForm: { inert: false, querySelector: () => null } },
    confirmAction: () => new Promise(resolve => { answer = resolve; }),
    DEFAULT_DOWNLOAD_SETTINGS: {}, DEFAULT_DOWNLOAD_RULES: {}, DEFAULT_RUNTIME_SETTINGS: {},
    renderSettingsCategory: page => rendered.push(page), saveDownloadSettings: async () => { saves++; },
  });
  vm.runInContext(declarations("resetDownloadSettings"), context);
  let pending = context.resetDownloadSettings();
  answer(false); await pending;
  assert.equal(saves, 0);
  pending = context.resetDownloadSettings();
  context.routeEpoch++; answer(true); await pending;
  assert.equal(saves, 0);
  pending = context.resetDownloadSettings();
  answer(true); await pending;
  assert.equal(saves, 1);
  assert.deepEqual(rendered, ["files"]);
});

test("an older group save cannot replace newer edits and queued changes use the acknowledged revision", async () => {
  const requests = [], completed = [], status = {};
  let renders = 0;
  const panel = { querySelectorAll: () => [] };
  const context = vm.createContext({
    structuredClone, queueMicrotask,
    fileGroupsDraft: [{ id: "other", name: "First", extensions: [] }],
    fileGroupsSaving: false, fileGroupsSaveQueued: false, fileGroupsMutationVersion: 1,
    fileGroupsReadVersion: 0, fileGroupsEditorRevision: 4, fileGroupsNeedsSync: false,
    currentPage: "settings", currentSettingsPage: "files",
    document: { getElementById: id => id === "file-groups-editor" ? { closest: () => panel } : status },
    captureFileGroupsDraft() {}, applyFileGroups() {}, cancelReadRetry() {},
    renderFileGroupsEditor() { renders++; },
    requestJSON: async (_path, options) => {
      requests.push(JSON.parse(options.body));
      return new Promise(resolve => completed.push(resolve));
    },
  });
  vm.runInContext(declarations("saveFileGroups", "scheduleFileGroupsSave"), context);
  const first = context.saveFileGroups();
  context.fileGroupsDraft[0].name = "Newer";
  context.fileGroupsMutationVersion++;
  status.textContent = "editing";
  context.scheduleFileGroupsSave();
  completed[0]({ revision: 5, groups: requests[0].groups });
  await first;
  await Promise.resolve();
  assert.equal(context.fileGroupsDraft[0].name, "Newer");
  assert.equal(renders, 0);
  assert.equal(status.textContent, "editing", "an older response cannot report newer input as saved");
  assert.equal(requests[1].revision, 5);
  assert.equal(requests[1].groups[0].name, "Newer");
  completed[1]({ revision: 6, groups: requests[1].groups });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(context.fileGroupsEditorRevision, 6);
  assert.equal(context.fileGroupsSaving, false);
  assert.equal(renders, 1);
});

test("a defaults conflict preserves edited controls and adopts unrelated remote values", async () => {
  const fields = new Map();
  const els = new Proxy({}, { get(_target, key) {
    if (!fields.has(key)) fields.set(key, { value: "", checked: false, inert: false });
    return fields.get(key);
  } });
  els.cfgConns.value = "8";
  els.cfgTries.value = "5";
  const context = vm.createContext({
    els, document: {}, currentPage: "settings", currentSettingsPage: "general",
    settingsReady: new Set(["general"]), settingsMessages: new Map(),
    settingsDirtyControls: new Map([["general", new Set([els.cfgConns])]]),
    EDITABLE_SETTINGS_PAGES: new Set(["general"]), settingsPanels: () => [],
    taskDefaultsRevision: 1, downloadSettings: {}, DEFAULT_DOWNLOAD_SETTINGS: {},
    optionalInt: key => Number(els[key].value), parseHeaders() {}, validateSettingsSpeed() {},
    invalidateSettingRead() {}, displaySpeed: () => ({ value: 0, unit: 1048576 }),
    normalizeServerRuntimeSettings: value => value, showToast() {},
    loadServerTaskDefaults: async () => { context.taskDefaultsRevision = 2; },
    renderSettingsCategory() { els.cfgConns.value = "16"; els.cfgTries.value = "9"; },
    requestJSON: async path => {
      if (path === "/settings/task-defaults") throw Object.assign(new Error("conflict"), { status: 409 });
      return { concurrentDownloads: 3, globalDownloadLimitBps: 0 };
    },
  });
  vm.runInContext(declarations("saveDownloadSettings"), context);
  await context.saveDownloadSettings({ preventDefault() {} });
  assert.equal(els.cfgConns.value, "8");
  assert.equal(els.cfgTries.value, "9");
  assert.equal(context.taskDefaultsRevision, 2);
  assert.match(context.settingsMessages.get("general"), /继续编辑后自动保存/);
});

test("About reset changes only the program update preference", async () => {
  const writes = [];
  const context = vm.createContext({
    els: { settingsForm: {}, settingsSaveStatus: {} }, currentSettingsPage: "about",
    updatePreferenceSaving: false, settingsMessages: new Map(), invalidateSettingRead() {},
    normalizeSystemUpdateState: value => value, renderSystemUpdateState() {},
    requestJSON: async (path, options) => { writes.push({ path, value: JSON.parse(options.body) }); return {}; },
  });
  vm.runInContext(declarations("resetImmediateSettings"), context);
  await context.resetImmediateSettings("about");
  assert.deepEqual(writes, [{ path: "/settings/updates", value: { autoUpdateTrueDown: true } }]);
  assert.equal(context.els.settingsForm.inert, false);
  assert.equal(context.updatePreferenceSaving, false);
});
