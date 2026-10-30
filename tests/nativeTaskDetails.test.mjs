import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dashboardSource as source } from "./helpers/truedownSource.mjs";

function declarations(...names) {
  return names.map(name => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
}

test("draft capacity reclaims clean entries but preserves edits and pending saves", () => {
  const controls = new Map();
  const context = vm.createContext({
    taskDetailID: 1, taskDetailData: null, taskDetailDrafts: new Map(),
    taskSettingControls: { connections: "connections" },
    document: { getElementById(id) { if (!controls.has(id)) controls.set(id, {}); return controls.get(id); } },
    KDComponents: { setBusyState() {} }, reconcileReadDraft: (_base, values) => values,
  });
  vm.runInContext(declarations("renderTaskSettings", "syncTaskSettingsBusy"), context);
  const visit = id => {
    context.taskDetailID = id;
    context.taskDetailData = { id, settings: { connections: 16 }, settingsRevision: "1", status: "paused" };
    context.renderTaskSettings(context.taskDetailData);
  };
  visit(1);
  Object.assign(context.taskDetailDrafts.get(1), { dirty: true, values: { connections: "23" } });
  visit(2);
  context.taskDetailDrafts.get(2).saving = true;
  for (let id = 3; id <= 100; id++) visit(id);
  assert.equal(context.taskDetailDrafts.size, 32);
  assert.equal(context.taskDetailDrafts.get(2).saving, true);
  visit(1);
  assert.equal(controls.get("connections").value, "23");
  for (const draft of context.taskDetailDrafts.values()) draft.dirty = true;
  visit(101);
  assert.equal(context.taskDetailDrafts.size, 32);
  assert.equal(context.taskDetailDrafts.has(101), false);
  assert.equal(controls.get("task-settings-fields").disabled, true);
  assert.equal(controls.get("task-settings-fields").hidden, true);
  assert.equal(controls.get("task-settings-save").disabled, true);
  assert.match(controls.get("task-settings-status").textContent, /32/);
  assert.equal(controls.get("connections").value, "");
  context.taskDetailDrafts.get(2).dirty = false;
  visit(101);
  assert.equal(context.taskDetailDrafts.has(2), true, "even a clean pending save is retained");
  context.taskDetailDrafts.get(2).saving = false;
  visit(101);
  assert.equal(context.taskDetailDrafts.has(101), true);
  assert.equal(controls.get("task-settings-save").disabled, false);
  assert.equal(controls.get("task-settings-fields").hidden, false);
  assert.equal(context.taskDetailDrafts.get(1).values.connections, "23");
});

test("opening native details preserves the main task route and rejects invalid IDs", async () => {
  const calls = [];
  const context = vm.createContext({
    nativeWindowRole: "main", currentPage: "tasks", location: { hash: "#tasks" },
    invokeNative: async (command, args) => calls.push([command, args.id]), showToast: assert.fail,
  });
  vm.runInContext(declarations("openTaskDetails"), context);
  for (const id of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) await context.openTaskDetails(id);
  await context.openTaskDetails(7);
  assert.deepEqual(calls, [["open_task_details", 7]]);
  assert.equal(context.location.hash, "#tasks");
  assert.equal(context.currentPage, "tasks");
});

test("detail target revisions reject stale startup snapshots and preserve the selected tab on reopen", () => {
  const shown = [], stopped = [], routes = [];
  const context = vm.createContext({
    nativeDetailDisposed: false, nativeDetailRevision: -1, nativeDetailOpen: false,
    taskDetailID: 0, taskDetailTab: "info", routeEpoch: 0,
    stopTaskDetails: () => stopped.push(true),
    history: { replaceState: (_state, _title, route) => routes.push(route) },
    document: { getElementById: () => ({ focus() {} }) },
    showTaskDetails(id, tab) { shown.push([id, tab]); context.taskDetailID = id; context.taskDetailTab = tab; },
  });
  vm.runInContext(declarations("applyNativeTaskDetails"), context);
  context.applyNativeTaskDetails({ id: 2, open: true, revision: 2 });
  context.applyNativeTaskDetails({ id: 1, open: true, revision: 1 });
  context.taskDetailTab = "settings";
  context.applyNativeTaskDetails({ id: 2, open: false, revision: 3 });
  assert.equal(context.nativeDetailOpen, false);
  context.applyNativeTaskDetails({ id: 2, open: true, revision: 4 });
  context.applyNativeTaskDetails({ id: 3, open: true, revision: 5 });
  context.nativeDetailDisposed = true;
  context.applyNativeTaskDetails({ id: 4, open: true, revision: 6 });
  assert.deepEqual(shown, [[2, "info"], [2, "settings"], [3, "info"]]);
  assert.equal(stopped.length, 4);
  assert.equal(routes.at(-1), "#task/3/info");
});

test("hidden or disposed native detail windows never start a request", async () => {
  const context = vm.createContext({
    currentPage: "task", document: { hidden: false }, nativeWindowRole: "task-details",
    nativeDetailOpen: false, nativeDetailDisposed: false, requestJSON: assert.fail,
  });
  vm.runInContext(declarations("loadTaskDetails"), context);
  await context.loadTaskDetails();
  context.nativeDetailOpen = true;
  context.nativeDetailDisposed = true;
  await context.loadTaskDetails();
});

test("detail windows do not register new-download drop handlers", () => {
  const events = [];
  const context = vm.createContext({ nativeWindowRole: "task-details",
    document: { addEventListener: name => events.push(name) },
    window: { addEventListener: name => assert.equal(name, "pagehide") },
  });
  vm.runInContext(declarations("bindDownloadDrops"), context);
  context.bindDownloadDrops();
  assert.deepEqual(events, ["dragstart", "dragend"], "drag policy is shared, download imports are not");
});
