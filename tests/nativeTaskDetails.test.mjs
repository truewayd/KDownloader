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
