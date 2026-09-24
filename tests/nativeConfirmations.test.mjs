import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dashboardSource as source } from "./helpers/truedownSource.mjs";

function declarations(...names) {
  return names.map((name) => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]).join("\n");
}

test("explicit native confirmations use parented dialogs and preserve cancellation", async () => {
  for (const answer of [false, true]) {
    const calls = [];
    const context = vm.createContext({
      window: { __TAURI__: { core: { invoke() {} } } },
      invokeNative: async (command, args) => { calls.push({ command, ...args }); return answer; },
      showDialog: assert.fail,
    });
    vm.runInContext(declarations("confirmAction"), context);
    assert.equal(await context.confirmAction({ native: true, title: "Remove", message: "Remove task?", confirmLabel: "Remove", danger: true }), answer);
    assert.equal(calls[0].command, "confirm_action");
    assert.equal(calls[0].options.message, "Remove task?");
    assert.equal(calls[0].options.kind, "warning");
    assert.equal(calls[0].options.cancelLabel, "取消");
  }
});

test("native confirmation failures never open a page modal or authorize an action", async () => {
  const context = vm.createContext({
    window: { __TAURI__: { core: { invoke() {} } } },
    invokeNative: async () => { throw new Error("Native dialog unavailable"); },
    showDialog: assert.fail,
    showToast: (message, kind) => { assert.match(message, /unavailable/); assert.equal(kind, "error"); },
  });
  vm.runInContext(declarations("confirmAction"), context);
  assert.equal(await context.confirmAction({ native: true, title: "Remove", message: "Remove?" }), false);
});

test("confirmation severity and localized labels reach the native boundary", async () => {
  const context = vm.createContext({
    window: { __TAURI__: { core: { invoke() {} } } },
    invokeNative: async (_, { options }) => options,
    showDialog: assert.fail,
  });
  vm.runInContext(declarations("confirmAction"), context);
  for (const kind of ["info", "warning", "error"]) {
    const result = await context.confirmAction({ native: true, title: "Title", message: "Message", kind, confirmLabel: "Continue", cancelLabel: "Back" });
    assert.equal(result.kind, kind);
    assert.equal(result.confirmLabel, "Continue");
    assert.equal(result.cancelLabel, "Back");
  }
});

test("browser confirmations retain the shared page dialog", async () => {
  const context = vm.createContext({ window: {}, showDialog: (options) => options.title === "Remove" });
  vm.runInContext(declarations("confirmAction"), context);
  assert.equal(await context.confirmAction({ title: "Remove" }), true);
});

test("desktop product confirmations use the project dialog by default", async () => {
  for (const answer of [false, true]) {
    const context = vm.createContext({
      window: { __TAURI__: { core: { invoke: assert.fail } } },
      invokeNative: assert.fail,
      showDialog: options => { assert.equal(options.title, "Reset"); return answer; },
    });
    vm.runInContext(declarations("confirmAction"), context);
    assert.equal(await context.confirmAction({ title: "Reset" }), answer);
  }
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
