let taskDetailID = 0;
let taskDetailTab = "info";
let taskDetailData = null;
let taskDetailTimer = 0;
let taskDetailRead = 0;
let taskDetailAbort = null;
let taskDetailReturnID = 0;
const taskDetailDrafts = new Map();
const taskSettingControls = { connections: "task-setting-connections", maxSpeedBps: "task-setting-speed", maxTries: "task-setting-tries", retryWait: "task-setting-wait" };

function taskBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "\u2014";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
function taskProgressPercent(task) {
  if (task.status === "done") return 100;
  const percent = task.totalLength > 0 && Number.isFinite(task.completedLength) ? 100 * task.completedLength / task.totalLength : parseFloat(task.progress);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
}
function taskProgressLabel(task) {
  if (task.error) return "\u4e0b\u8f7d\u5931\u8d25";
  return task.status === "queued" ? "\u7b49\u5f85\u4e0b\u8f7d" : `${taskProgressPercent(task).toFixed(1)}%`;
}
function taskSpeed(task) { return task.status === "downloading" && task.downloadSpeed > 0 ? `${taskBytes(task.downloadSpeed)}/s` : "\u2014"; }
function taskRemaining(task) {
  if (task.status !== "downloading" || !(task.downloadSpeed > 0) || !(task.totalLength > task.completedLength)) return "\u2014";
  const seconds = Math.ceil((task.totalLength - task.completedLength) / task.downloadSpeed);
  return seconds < 60 ? `${seconds} \u79d2` : seconds < 3600 ? `${Math.ceil(seconds / 60)} \u5206\u949f` : `${(seconds / 3600).toFixed(1)} \u5c0f\u65f6`;
}
function taskDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "\u2014";
}

function initTaskDetails() {
  document.getElementById("task-detail-actions").addEventListener("click", onTaskAction);
  document.getElementById("task-settings-form").addEventListener("input", () => {
    const draft = taskDetailDrafts.get(taskDetailID);
    if (!draft) return;
    for (const [key, id] of Object.entries(taskSettingControls)) draft.values[key] = document.getElementById(id).value;
    draft.dirty = true;
    draft.message = "\u6709\u672a\u4fdd\u5b58\u7684\u4fee\u6539\u3002";
    document.getElementById("task-settings-status").textContent = draft.message;
  });
  document.getElementById("task-settings-form").addEventListener("submit", saveTaskDetails);
  document.getElementById("task-settings-reload").addEventListener("click", async () => {
    taskDetailDrafts.delete(taskDetailID);
    await loadTaskDetails();
  });
  document.addEventListener("visibilitychange", () => {
    stopTaskDetails();
    if (currentPage === "task" && !document.hidden) loadTaskDetails();
  });
  window.addEventListener("pagehide", stopTaskDetails, { once: true });
}

function stopTaskDetails() {
  clearTimeout(taskDetailTimer);
  taskDetailRead++;
  taskDetailAbort?.abort();
}

function showTaskDetails(id, tab) {
  stopTaskDetails();
  taskDetailID = id;
  taskDetailTab = tab === "settings" ? "settings" : "info";
  taskDetailData = null;
  document.getElementById("task-detail-title").textContent = "\u4efb\u52a1\u4fe1\u606f";
  document.getElementById("task-info-grid").replaceChildren();
  document.getElementById("task-detail-actions").replaceChildren();
  delete document.getElementById("task-detail-actions").dataset.status;
  document.getElementById("task-detail-progress").removeAttribute("value");
  document.getElementById("task-settings-fields").disabled = true;
  document.getElementById("task-settings-save").disabled = true;
  document.getElementById("task-info-panel").hidden = taskDetailTab !== "info";
  document.getElementById("task-settings-form").hidden = taskDetailTab !== "settings";
  for (const name of ["info", "settings"]) {
    const link = document.getElementById(`task-${name}-tab`);
    link.href = `#task/${id}/${name}`;
    if (name === taskDetailTab) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  document.getElementById("task-detail-status").textContent = "\u6b63\u5728\u8bfb\u53d6\u4efb\u52a1\u2026";
  document.getElementById("task-settings-status").textContent = taskDetailDrafts.get(id)?.message || "";
  loadTaskDetails();
}

async function loadTaskDetails() {
  if (currentPage !== "task" || document.hidden) return;
  clearTimeout(taskDetailTimer);
  taskDetailAbort?.abort();
  const controller = new AbortController();
  taskDetailAbort = controller;
  const id = taskDetailID, epoch = routeEpoch, version = ++taskDetailRead;
  const current = () => currentPage === "task" && routeEpoch === epoch && taskDetailID === id && taskDetailRead === version;
  try {
    const detail = await requestJSON(`/tasks/detail?id=${id}`, { signal: controller.signal });
    if (!current()) return;
    if (detail.id !== id || !detail.settings) throw new Error("\u4efb\u52a1\u54cd\u5e94\u65e0\u6548");
    if (detail.groups) applyFileGroups(detail.groups);
    taskDetailData = detail;
    taskStatusByID.set(id, detail.status);
    renderTaskDetails(detail);
    document.getElementById("task-detail-status").textContent = "";
  } catch (error) {
    if (!current() || error.name === "AbortError") return;
    document.getElementById("task-detail-status").textContent = error.status === 404 ? "\u6b64\u4efb\u52a1\u5df2\u88ab\u79fb\u9664\u3002" : `\u8bfb\u53d6\u5931\u8d25\uff1a${error.message}`;
    document.getElementById("task-settings-save").disabled = true;
    document.getElementById("task-detail-actions").replaceChildren();
    delete document.getElementById("task-detail-actions").dataset.status;
  } finally {
    if (current()) taskDetailTimer = setTimeout(loadTaskDetails, 2500);
  }
}

function renderTaskDetails(task) {
  document.getElementById("task-detail-title").textContent = task.outputName || task.name || `\u4efb\u52a1 #${task.id}`;
  document.title = document.getElementById("task-detail-title").textContent;
  const facts = [
    ["\u6587\u4ef6\u540d", task.outputName || task.name], ["\u5206\u7ec4", taskCategoryMeta(task.category).label],
    ["\u72b6\u6001", statusMeta[task.status]?.label], ["\u6587\u4ef6\u5927\u5c0f", taskBytes(task.totalLength)],
    ["\u5df2\u4e0b\u8f7d", taskBytes(task.status === "done" ? task.totalLength : task.completedLength)],
    ["\u4e0b\u8f7d\u901f\u5ea6", taskSpeed(task)], ["\u5269\u4f59\u65f6\u95f4", taskRemaining(task)],
    ["\u4fdd\u5b58\u76ee\u5f55", task.folder], ["\u4e0b\u8f7d\u94fe\u63a5", task.link],
    ["\u6dfb\u52a0\u65f6\u95f4", taskDate(task.createdAt)], ["\u8be6\u7ec6\u8fdb\u5ea6", task.progress],
    ...(task.error ? [["\u9519\u8bef\u4fe1\u606f", formatTaskError(task)]] : []),
  ];
  const grid = document.getElementById("task-info-grid");
  facts.forEach(([label, value], i) => {
    if (!grid.children[i * 2]) grid.append(document.createElement("dt"), document.createElement("dd"));
    if (grid.children[i * 2].textContent !== label) grid.children[i * 2].textContent = label;
    const text = String(value || "\u2014");
    if (grid.children[i * 2 + 1].textContent !== text) grid.children[i * 2 + 1].textContent = text;
  });
  while (grid.children.length > facts.length * 2) grid.lastChild.remove();
  document.getElementById("task-detail-progress").value = taskProgressPercent(task);
  const actions = document.getElementById("task-detail-actions");
  const shape = JSON.stringify([task.id, task.status, task.link]);
  if (actions.dataset.status !== shape) {
    const focused = actions.contains(document.activeElement) ? document.activeElement.dataset.action : null;
    actions.innerHTML = `<button class="text-button icon-only" type="button" data-action="copy-link" data-link="${esc(task.link)}" aria-label="\u590d\u5236\u94fe\u63a5" title="\u590d\u5236\u94fe\u63a5">${iconMarkup("copy")}</button>` + actionButton("open-folder", task.id, "\u6253\u5f00\u76ee\u5f55", false, "folder-open")
      + (task.status === "done" ? actionButton("open-file", task.id, "\u6253\u5f00\u6587\u4ef6") : task.status === "error" ? actionButton("requeue", task.id, "\u91cd\u8bd5", false, "retry") : task.status === "paused" ? actionButton("resume", task.id, "\u7ee7\u7eed", false, "play") : actionButton("pause", task.id, "\u6682\u505c", false, "pause"));
    actions.dataset.status = shape;
    if (focused) (actions.querySelector(`[data-action="${focused}"]`) || actions.querySelector("button"))?.focus({ preventScroll: true });
  }
  let draft = taskDetailDrafts.get(task.id);
  if (!draft || !draft.dirty && !draft.saving && draft.revision !== task.settingsRevision) {
    draft = { revision: task.settingsRevision, values: { ...task.settings }, dirty: false, message: "" };
    taskDetailDrafts.set(task.id, draft);
    while (taskDetailDrafts.size > 32) taskDetailDrafts.delete(taskDetailDrafts.keys().next().value);
  }
  for (const [key, id] of Object.entries(taskSettingControls)) {
    const control = document.getElementById(id);
    if (document.activeElement !== control && control.value !== String(draft.values[key])) control.value = draft.values[key];
    control.disabled = task.status === "done" || task.status === "downloading" && key !== "maxSpeedBps";
  }
  document.getElementById("task-settings-fields").disabled = Boolean(draft.saving);
  document.getElementById("task-settings-save").disabled = task.status === "done" || Boolean(draft.saving);
  document.getElementById("task-settings-status").textContent = draft.message || "";
}

async function saveTaskDetails(event) {
  event.preventDefault();
  const id = taskDetailID, draft = taskDetailDrafts.get(id), epoch = routeEpoch;
  if (!draft || draft.saving || document.getElementById("task-settings-save").disabled) return;
  const values = Object.fromEntries(Object.entries(draft.values).map(([key, value]) => [key, Number(value)]));
  draft.saving = true;
  stopTaskDetails();
  const button = document.getElementById("task-settings-save");
  document.getElementById("task-settings-fields").disabled = true;
  KDComponents.setBusyState(button, true);
  try {
    const task = await requestJSON(`/tasks/detail?id=${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: draft.revision, values }) });
    Object.assign(draft, { revision: task.settingsRevision, values: { ...task.settings }, dirty: false, message: "\u6b64\u4efb\u52a1\u7684\u8bbe\u7f6e\u5df2\u4fdd\u5b58\u3002" });
  } catch (error) {
    draft.message = error.status === 409 ? "\u4efb\u52a1\u8bbe\u7f6e\u5df2\u53d8\u66f4\uff0c\u8bf7\u91cd\u65b0\u8bfb\u53d6\u540e\u4fee\u6539\u3002\u8349\u7a3f\u5df2\u4fdd\u7559\u3002" : `\u4fdd\u5b58\u5931\u8d25\uff1a${error.message}`;
  } finally {
    draft.saving = false;
    KDComponents.setBusyState(button, false);
    if (currentPage === "task" && taskDetailID === id && epoch === routeEpoch) {
      document.getElementById("task-settings-status").textContent = draft.message;
      await loadTaskDetails();
    }
  }
}
