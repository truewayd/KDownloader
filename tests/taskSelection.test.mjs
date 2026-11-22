import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../truedown/web/app.js", import.meta.url), "utf8");
const metadataSource = source.slice(source.indexOf("function rememberTaskMetadata("), source.indexOf("async function runTaskAction("));
const selectSource = source.slice(source.indexOf("async function onTaskSelection("), source.indexOf("async function runSelectedAction(")) + "\n" + source.match(/^function taskSelectionScope\(\).*$/m)[0];
const batchSource = source.slice(source.indexOf("async function runSelectedAction("), source.indexOf("function setBatchBusy("))
  + source.slice(source.indexOf("function renderBatchCount("), source.indexOf("function taskSelectionScope("));
function context(extra = {}) {
  const state = vm.createContext({
    selectedTaskIDs: new Set(), taskStatusByID: new Map(), taskLinkByID: new Map(), updateTaskIDs: new Set(),
    taskSelectionLoading: false, taskSelectionSerial: 0, taskBatchRunning: false, taskBatchProgress: "",
    currentPage: "tasks", currentFilter: "all", currentSearch: "", currentCategory: "", currentModule: "", MAX_SELECTED_TASKS: 50000,
    URLSearchParams,
    currentTasks: [], syncSelectionControls() {}, showToast() {}, clearTaskSelection() {},
    ...extra,
  });
  vm.runInContext(metadataSource, state);
  return state;
}
function checkbox() { return { checked: true, matches: selector => selector === "[data-select-page]" }; }

test("clearing a full snapshot immediately releases links and statuses outside the mounted page", () => {
  const state = context({
    currentTasks: [{ id: 27, status: "paused", link: "visible", updateDownload: true }],
    els: { tasksContainer: { querySelectorAll: () => [] }, tasksWrap: { focus() {} } },
  });
  for (let id = 1; id <= 50000; id++) {
    state.selectedTaskIDs.add(id);
    state.taskStatusByID.set(id, "paused");
    state.taskLinkByID.set(id, "https://example.test/" + id);
    state.updateTaskIDs.add(id);
  }
  vm.runInContext(source.slice(source.indexOf("function clearTaskSelection("), source.indexOf("async function runTaskAction(")), state);
  state.clearTaskSelection();
  assert.equal(state.taskLinkByID.size, 1);
  assert.deepEqual([...state.taskStatusByID], [[27, "paused"]]);
  assert.equal(state.taskLinkByID.get(27), "visible");
  assert.deepEqual([...state.updateTaskIDs], [27]);
});

test("select all obtains offscreen membership and links independently of rendered rows", async () => {
  let url;
  const state = context({ currentModule: "google-drive", requestJSON: async value => {
    url = value;
    return { tasks: Array.from({ length: 1205 }, (_, i) => ({ id: i + 1, status: "paused", link: `https://example.test/${i}`, updateDownload: i === 1000 })) };
  } });
  vm.runInContext(selectSource, state);
  await state.onTaskSelection({ target: checkbox() });
  assert.match(url, /^\/tasks\/selection\?/);
  assert.equal(new URL(url, "https://example.test").searchParams.get("module"), "google-drive");
  assert.equal(state.selectedTaskIDs.size, 1205);
  assert.equal(state.taskLinkByID.get(1205), "https://example.test/1204");
  assert.equal(state.updateTaskIDs.has(1001), true);
  assert.equal(state.taskSelectionLoading, false);
});

test("a superseded select-all response cannot replace a newer selection", async () => {
  let resolve;
  const state = context({ requestJSON: () => new Promise(done => { resolve = done; }) });
  vm.runInContext(selectSource, state);
  const pending = state.onTaskSelection({ target: checkbox() });
  state.taskSelectionSerial++;
  state.selectedTaskIDs.add(99);
  resolve({ tasks: [{ id: 1 }] });
  await pending;
  assert.deepEqual([...state.selectedTaskIDs], [99]);
});

test("bulk removal chunks every selected ID and retains failed rows", async () => {
  const calls = [];
  const state = context({
    els: { batchSelectionCount: {} },
    requestJSON: async (_url, options) => {
      const request = JSON.parse(options.body); calls.push(request);
      return { succeeded: request.ids.filter(id => id !== 1050), failed: request.ids.includes(1050) ? [{ id: 1050, error: "retained" }] : [] };
    },
    confirmAction: async () => true, confirmUpdateTaskAction: async () => true,
    setBatchBusy() {}, loadTasks: async () => {}, schedulePoll() {},
  });
  for (let id = 1; id <= 2405; id++) state.selectedTaskIDs.add(id);
  vm.runInContext(batchSource, state);
  await state.runSelectedAction("remove", "remove", true);
  assert.deepEqual(calls.map(call => call.ids.length), [1000, 1000, 405]);
  assert.deepEqual([...state.selectedTaskIDs], [1050]);
});

test("selection survives viewport changes and sorting, and clears on filter changes", () => {
  const header = {};
  const state = context({
    selectedTaskScope: JSON.stringify(["all", "", "", "google-drive"]), currentModule: "google-drive", currentTotal: 1205,
    currentTasks: Array.from({ length: 100 }, (_, index) => ({ id: index + 1001 })),
    els: { tasksContainer: { querySelectorAll: () => [], querySelector: () => header }, batchToolbar: {}, batchSelectionCount: {} },
    KDComponents: { setBusyState() {} },
  });
  for (let id = 1; id <= 1205; id++) state.selectedTaskIDs.add(id);
  vm.runInContext(source.slice(source.indexOf("function syncSelectionControls("), source.indexOf("function updateMetrics(")), state);
  state.syncSelectionControls();
  assert.equal(header.checked, true);
  state.currentSort = "file";
  state.currentTasks = [{ id: 1 }];
  state.syncSelectionControls();
  assert.equal(state.selectedTaskIDs.size, 1205);
  state.selectedTaskIDs.delete(1100);
  state.syncSelectionControls();
  assert.equal(header.checked, false);
  assert.equal(header.indeterminate, true);
  state.currentModule = "dropbox";
  state.syncSelectionControls();
  assert.equal(state.selectedTaskIDs.size, 0);
});
