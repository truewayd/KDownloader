import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dashboardSource as source } from "./helpers/truedownSource.mjs";

function declarations(...names) {
  return names.map((name) => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]).join("\n");
}

test("native confirmations use a parented command and restore focus after either answer", async () => {
  for (const answer of [false, true]) {
    const calls = [];
    let focused = 0;
    const context = vm.createContext({
      window: { __TAURI__: { core: { invoke() {} } } },
      document: { activeElement: { isConnected: true, closest: () => null, focus: () => focused++ } },
      invokeNative: async (command, args) => { calls.push([command, args]); return answer; },
      showDialog: assert.fail,
    });
    vm.runInContext(declarations("confirmAction"), context);
    assert.equal(await context.confirmAction({ title: "Remove", message: "Remove task?", confirmLabel: "Remove", danger: true }), answer);
    assert.equal(calls[0][0], "confirm_action");
    assert.equal(calls[0][1].options.message, "Remove task?");
    assert.equal(calls[0][1].options.danger, true);
    assert.equal(focused, 1);
  }
});

test("browser confirmations retain the shared page dialog", async () => {
  const context = vm.createContext({ window: {}, showDialog: (options) => options.title === "Remove" });
  vm.runInContext(declarations("confirmAction"), context);
  assert.equal(await context.confirmAction({ title: "Remove" }), true);
});

test("single retries dispatch immediately while deletion still honors cancellation", async () => {
  const calls = [];
  const context = vm.createContext({
    activeTaskActions: new Set(), taskStatusByID: new Map([[1, "error"]]),
    setTaskActionBusy() {}, runTaskAction: async (action, id) => calls.push([action, id]),
    confirmAction: async () => { calls.push(["confirm"]); return false; }, showToast: assert.fail,
  });
  vm.runInContext(declarations("onTaskAction"), context);
  const click = (action) => ({ target: { closest: () => ({ dataset: { action, id: "1" } }) } });
  await context.onTaskAction(click("requeue"));
  assert.deepEqual(calls, [["requeue", 1]]);
  await context.onTaskAction(click("remove"));
  assert.deepEqual(calls, [["requeue", 1], ["confirm"]]);
});

test("retry all sends bounded batches without confirmation and prevents duplicate clicks", async () => {
  let requests = 0, resolve;
  let busy = false;
  const context = vm.createContext({
    currentSummary: { error: 1 }, els: { retryAllBtn: { getAttribute: () => String(busy) } },
    KDComponents: { setBusyState: (_, value) => { busy = value; } },
    requestJSON: async () => { requests++; return new Promise((done) => { resolve = done; }); },
    confirmAction: assert.fail, showToast() {}, loadTasks: async () => {}, updateMetrics() {}, schedulePoll() {}, safeCount: Number,
  });
  vm.runInContext(declarations("requeueAllErrorTasks"), context);
  const operation = context.requeueAllErrorTasks();
  await context.requeueAllErrorTasks();
  assert.equal(requests, 1);
  resolve({ succeeded: [1], failed: [], remaining: 0 });
  await operation;
  assert.equal(busy, false);
});
