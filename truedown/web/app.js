const ACTIVE_POLL_INTERVAL_MS = 2500;
const IDLE_POLL_INTERVAL_MS = 10000;
const PAGE_SIZE = 100;
const MAX_SELECTED_TASKS = 1000;
const LEGACY_THEME_KEY = "truedown-theme";
const API_TOKEN_SESSION_KEY = "truedown-api-token";
const DOWNLOAD_DEFAULTS_KEY = "truedown-download-defaults-v1";
const MAX_SPEED_BPS = 2 ** 50;
const DEFAULT_DOWNLOAD_SETTINGS = Object.freeze({
  folder: "",
  connections: 16,
  speed: 0,
  speedUnit: 1048576,
  maxTries: 5,
  retryWait: 3,
  proxy: "",
  userAgent: "",
  referer: "",
  headers: "",
  allocation: "none",
  checkIntegrity: false,
  remoteTime: true,
  extra: "",
});

const statusMeta = {
  downloading: { label: "下载中", rank: 0 },
  queued: { label: "排队中", rank: 1 },
  paused: { label: "已暂停", rank: 2 },
  error: { label: "出错", rank: 3 },
  done: { label: "已完成", rank: 4 },
};

const els = {};
const selectedTaskIDs = new Set();
const pageETags = new Map();
let toastTimer = 0;
let pollTimer = 0;
let modalMode = "single";
let currentTasks = [];
let currentSummary = emptySummary();
let currentOffset = 0;
let currentTotal = 0;
let currentFilter = "all";
let loadTasksPromise = null;
let lastTaskRenderSignature = "";
let modalReturnFocus = null;
let apiToken = readSessionToken();
let apiTokenPromptDismissed = false;
let tokenAuthEnabled = false;
let tokenAuthManaged = false;
let downloadSettings = loadDownloadSettings();
let settingsReturnFocus = null;

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  initTheme();
  renderDownloadSettings();
  bindEvents();
  try {
    await loadAuthSettings();
  } catch (error) {
    showToast(`读取认证设置失败：${error.message}`, "error");
  }
  refreshAndSchedule();
});

function cacheElements() {
  [
    "active-count",
    "batch-pause-btn",
    "batch-remove-btn",
    "batch-resume-btn",
    "batch-selection-count",
    "batch-task-btn",
    "batch-toolbar",
    "cfg-conns",
    "cfg-allocation",
    "cfg-check-integrity",
    "cfg-extra",
    "cfg-folder",
    "cfg-headers",
    "cfg-proxy",
    "cfg-referer",
    "cfg-remote-time",
    "cfg-speed",
    "cfg-speed-unit",
    "cfg-tries",
    "cfg-user-agent",
    "cfg-wait",
    "clear-done-btn",
    "copy-api-token-btn",
    "download-form",
    "error-count",
    "m-conns",
    "m-extra",
    "m-folder",
    "m-headers",
    "m-link",
    "m-name",
    "m-queueid",
    "m-referer",
    "m-speed",
    "m-tries",
    "m-wait",
    "modal-cancel-btn",
    "modal-close-btn",
    "modal-eyebrow",
    "modal-msg",
    "modal-title",
    "new-task-btn",
    "next-page-btn",
    "overlay",
    "page-info",
    "prev-page-btn",
    "refresh-tasks-btn",
    "retry-all-btn",
    "settings-btn",
    "settings-cancel-btn",
    "settings-close-btn",
    "settings-form",
    "settings-overlay",
    "settings-reset-btn",
    "submit-task-btn",
    "task-count",
    "task-filter",
    "tasks-container",
    "tasks-wrap",
    "token-auth-enabled",
    "token-auth-status",
    "toast",
  ].forEach((id) => {
    els[toCamel(id)] = document.getElementById(id);
  });
}

function bindEvents() {
  els.newTaskBtn.addEventListener("click", () => openModal("single"));
  els.batchTaskBtn.addEventListener("click", () => openModal("batch"));
  els.settingsBtn.addEventListener("click", openSettingsModal);
  els.settingsCloseBtn.addEventListener("click", closeSettingsModal);
  els.settingsCancelBtn.addEventListener("click", closeSettingsModal);
  els.settingsResetBtn.addEventListener("click", resetDownloadSettings);
  els.settingsForm.addEventListener("submit", saveDownloadSettings);
  els.settingsOverlay.addEventListener("click", (event) => {
    if (event.target === els.settingsOverlay) closeSettingsModal();
  });
  els.modalCloseBtn.addEventListener("click", closeModal);
  els.modalCancelBtn.addEventListener("click", closeModal);
  els.overlay.addEventListener("click", (event) => {
    if (event.target === els.overlay) closeModal();
  });
  document.addEventListener("keydown", onDocumentKeydown);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      window.clearTimeout(pollTimer);
      return;
    }
    refreshAndSchedule();
  });
  window.addEventListener("pagehide", () => window.clearTimeout(pollTimer), { once: true });

  els.downloadForm.addEventListener("submit", submitTask);
  els.refreshTasksBtn.addEventListener("click", async () => {
    await loadTasks({ force: true });
    showToast("任务列表已刷新。");
    schedulePoll();
  });
  els.retryAllBtn.addEventListener("click", requeueAllErrorTasks);
  els.clearDoneBtn.addEventListener("click", clearDone);
  els.tasksContainer.addEventListener("click", onTaskAction);
  els.tasksContainer.addEventListener("change", onTaskSelection);
  els.taskFilter.addEventListener("change", () => {
    currentFilter = els.taskFilter.value;
    currentOffset = 0;
    lastTaskRenderSignature = "";
    refreshAndSchedule(true);
  });
  els.prevPageBtn.addEventListener("click", () => changePage(-1));
  els.nextPageBtn.addEventListener("click", () => changePage(1));
  els.batchPauseBtn.addEventListener("click", () => runSelectedAction("pause", "暂停"));
  els.batchResumeBtn.addEventListener("click", () => runSelectedAction("resume", "继续"));
  els.batchRemoveBtn.addEventListener("click", () => runSelectedAction("remove", "移除", true));
  els.copyApiTokenBtn.addEventListener("click", copyAPIToken);
  els.tokenAuthEnabled.addEventListener("change", updateAuthSettings);
}

function initTheme() {
  localStorage.removeItem(LEGACY_THEME_KEY);
  document.documentElement.removeAttribute("data-theme");
}

function onDocumentKeydown(event) {
  const activeOverlay = els.settingsOverlay.classList.contains("open") ? els.settingsOverlay :
    els.overlay.classList.contains("open") ? els.overlay : null;
  if (!activeOverlay) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (activeOverlay === els.settingsOverlay) closeSettingsModal();
    else closeModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...activeOverlay.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openModal(mode = "single") {
  modalMode = mode;
  modalReturnFocus = document.activeElement;
  const isBatch = mode === "batch";
  els.modalEyebrow.textContent = isBatch ? "Batch download" : "New download";
  els.modalTitle.textContent = isBatch ? "批量下载任务" : "新建下载任务";
  els.submitTaskBtn.textContent = isBatch ? "批量开始" : "开始下载";
  els.mLink.rows = isBatch ? 7 : 4;
  els.mLink.placeholder = isBatch
    ? "https://example.com/file-a.zip\nhttps://example.com/file-b.zip\nhttps://example.com/file-c.zip"
    : "https://example.com/file.zip";
  els.mName.disabled = isBatch;
  els.mName.placeholder = isBatch ? "批量时自动命名" : "留空自动命名";
  if (isBatch) els.mName.value = "";
  els.overlay.classList.add("open");
  els.overlay.setAttribute("aria-hidden", "false");
  els.overlay.removeAttribute("inert");
  document.body.classList.add("modal-open");
  window.setTimeout(() => els.mLink.focus(), 80);
}

function closeModal() {
  if (!els.overlay.classList.contains("open")) return;
  els.overlay.classList.remove("open");
  els.overlay.setAttribute("aria-hidden", "true");
  els.overlay.setAttribute("inert", "");
  document.body.classList.remove("modal-open");
  showModalMsg("");
  if (modalReturnFocus instanceof HTMLElement && modalReturnFocus.isConnected) {
    modalReturnFocus.focus();
  }
  modalReturnFocus = null;
}

async function submitTask(event) {
  event.preventDefault();
  let links;
  try {
    links = parseLinks(els.mLink.value);
  } catch (error) {
    showModalMsg(error.message, true);
    return;
  }
  if (!links.length) {
    showModalMsg("请填写下载链接", true);
    return;
  }

  let headers;
  try {
    headers = mergeHeaders(parseHeaders(downloadSettings.headers), parseHeaders(els.mHeaders.value));
    if (downloadSettings.userAgent && !hasHeader(headers, "user-agent")) {
      headers["User-Agent"] = downloadSettings.userAgent;
    }
  } catch {
    showModalMsg("Headers JSON 格式错误", true);
    return;
  }

  const sharedBody = {
    headers,
    downloadPage: emptyToUndefined(els.mReferer.value) || emptyToUndefined(downloadSettings.referer),
    folder: emptyToUndefined(els.mFolder.value) || emptyToUndefined(downloadSettings.folder),
    name: links.length === 1 ? emptyToUndefined(els.mName.value) : undefined,
    queueId: optionalInt("mQueueid") || undefined,
    opts: buildOpts("m"),
  };

  setSubmitting(true);
  try {
    const outcomes = await mapLimitSettled(links, 8, (link) =>
      requestText("/start-headless-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildStartBody(link, sharedBody)),
      }),
    );
    const created = outcomes.filter((outcome) => outcome.status === "fulfilled").map((outcome) => outcome.value);
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    const duplicateCount = created.filter((text) => text.includes("DUPLICATE")).length;
    await loadTasks({ force: true });
    if (failed.length) {
      els.mLink.value = failed.map((outcome) => outcome.item).join("\n");
      showModalMsg(
        `已创建 ${created.length} 项，失败 ${failed.length} 项：${failed[0].reason?.message || "请求失败"}`,
        true,
      );
      return;
    }
    const summary = duplicateCount
      ? `已接收 ${created.length} 项，其中 ${duplicateCount} 项复用原记录并检查更新`
      : `已创建 ${created.length} 个任务`;
    showModalMsg(links.length === 1 ? (duplicateCount ? "已复用原记录并检查更新" : `已创建：${created[0]}`) : summary);
    els.mLink.value = "";
    window.setTimeout(closeModal, 700);
  } catch (error) {
    showModalMsg(`创建失败：${error.message}`, true);
  } finally {
    setSubmitting(false);
    schedulePoll();
  }
}

function setSubmitting(isSubmitting) {
  els.submitTaskBtn.disabled = isSubmitting;
  els.submitTaskBtn.toggleAttribute("aria-busy", isSubmitting);
  els.submitTaskBtn.textContent = isSubmitting ? "提交中..." : (modalMode === "batch" ? "批量开始" : "开始下载");
}

function buildStartBody(link, sharedBody) {
  return {
    downloadSource: { link, headers: sharedBody.headers, downloadPage: sharedBody.downloadPage },
    folder: sharedBody.folder,
    name: sharedBody.name,
    queueId: sharedBody.queueId,
    opts: sharedBody.opts,
  };
}

function buildOpts(prefix) {
  const extraFromModal = lines(`${prefix}Extra`);
  return {
    connections: optionalInt(`${prefix}Conns`) || downloadSettings.connections,
    maxSpeedBps: optionalInt(`${prefix}Speed`) || settingsSpeedBps(),
    maxTries: optionalInt(`${prefix}Tries`) || downloadSettings.maxTries,
    retryWait: optionalInt(`${prefix}Wait`) || downloadSettings.retryWait,
    extraArgs: extraFromModal.length ? extraFromModal : settingsExtraArgs(),
  };
}

async function onTaskAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = Number(button.dataset.id);
  const action = button.dataset.action;
  if (action === "copy-link") {
    await copyTaskLink(button.dataset.link || "");
    return;
  }
  if (!Number.isSafeInteger(id) || id <= 0) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    if (action === "requeue") await runTaskAction("requeue", id, "任务已重新排队。");
    if (action === "pause") await runTaskAction("pause", id, "任务已暂停。");
    if (action === "resume") await runTaskAction("resume", id, "任务已继续。");
    if (action === "remove") {
      if (!window.confirm("移除此任务？已完成文件会保留；正在下载的任务会停止并删除未完成文件。")) return;
      await runTaskAction("remove", id, "任务已移除。");
      selectedTaskIDs.delete(id);
    }
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function runTaskAction(action, id, successMessage) {
  try {
    const result = await requestJSON("/tasks/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ids: [id] }),
    });
    if (result.failed?.length) throw new Error(result.failed[0].error || "操作失败");
    showToast(successMessage);
    await loadTasks({ force: true });
  } catch (error) {
    showToast(`操作失败：${error.message}`, "error");
  }
}

function onTaskSelection(event) {
  const checkbox = event.target;
  if (checkbox.matches("[data-select-page]")) {
    const visibleIDs = currentTasks.map((task) => task.id);
    if (checkbox.checked && selectedTaskIDs.size + visibleIDs.filter((id) => !selectedTaskIDs.has(id)).length > MAX_SELECTED_TASKS) {
      checkbox.checked = false;
      showToast(`最多选择 ${MAX_SELECTED_TASKS} 个任务。`, "error");
      return;
    }
    visibleIDs.forEach((id) => checkbox.checked ? selectedTaskIDs.add(id) : selectedTaskIDs.delete(id));
    els.tasksContainer.querySelectorAll("[data-select-task]").forEach((input) => {
      input.checked = checkbox.checked;
    });
    syncSelectionControls();
    return;
  }
  if (!checkbox.matches("[data-select-task]")) return;
  const id = Number(checkbox.value);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  if (checkbox.checked && selectedTaskIDs.size >= MAX_SELECTED_TASKS) {
    checkbox.checked = false;
    showToast(`最多选择 ${MAX_SELECTED_TASKS} 个任务。`, "error");
    return;
  }
  if (checkbox.checked) selectedTaskIDs.add(id);
  else selectedTaskIDs.delete(id);
  syncSelectionControls();
}

async function runSelectedAction(action, label, requiresConfirmation = false) {
  const ids = [...selectedTaskIDs];
  if (!ids.length) {
    showToast("请先选择任务。", "error");
    return;
  }
  if (requiresConfirmation && !window.confirm(`移除选中的 ${ids.length} 个任务？已完成文件会保留；活动任务会停止并删除未完成文件。`)) return;
  setBatchBusy(true);
  try {
    const result = await requestJSON("/tasks/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ids }),
    });
    if (action === "remove") {
      (result.succeeded || []).forEach((id) => selectedTaskIDs.delete(id));
    }
    const succeeded = result.succeeded?.length || 0;
    const failed = result.failed?.length || 0;
    const detail = failed ? `；${result.failed[0].error}` : "";
    showToast(`${label}成功 ${succeeded} 项${failed ? `，失败 ${failed} 项${detail}` : ""}`, failed ? "error" : "success");
    await loadTasks({ force: true });
  } catch (error) {
    showToast(`${label}失败：${error.message}`, "error");
  } finally {
    setBatchBusy(false);
    schedulePoll();
  }
}

function setBatchBusy(busy) {
  [els.batchPauseBtn, els.batchResumeBtn, els.batchRemoveBtn].forEach((button) => {
    button.disabled = busy;
    button.toggleAttribute("aria-busy", busy);
  });
}

async function requeueAllErrorTasks() {
  if (!currentSummary.error) {
    showToast("没有需要重试的任务。");
    return;
  }
  els.retryAllBtn.disabled = true;
  els.retryAllBtn.setAttribute("aria-busy", "true");
  try {
    let succeeded = 0;
    let failed = 0;
    let remaining = currentSummary.error;
    while (remaining > 0) {
      const result = await requestJSON("/tasks/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "requeue-errors", ids: [] }),
      });
      const batchSucceeded = result.succeeded?.length || 0;
      const batchFailed = result.failed?.length || 0;
      succeeded += batchSucceeded;
      failed += batchFailed;
      remaining = safeCount(result.remaining);
      if (batchFailed || batchSucceeded === 0) break;
    }
    const remainingText = remaining ? `，仍有 ${remaining} 个待处理` : "";
    showToast(`已重新排队 ${succeeded} 个任务${failed ? `，失败 ${failed} 个` : ""}${remainingText}`, failed || remaining ? "error" : "success");
    await loadTasks({ force: true });
  } catch (error) {
    showToast(`重试失败：${error.message}`, "error");
  } finally {
    els.retryAllBtn.removeAttribute("aria-busy");
    updateMetrics(currentSummary);
    schedulePoll();
  }
}

async function clearDone() {
  if (!currentSummary.done) {
    showToast("没有已完成任务可清理。");
    return;
  }
  if (!window.confirm(`清理 ${currentSummary.done} 条已完成任务记录？磁盘文件不会被删除。`)) return;
  try {
    const text = await requestText("/tasks/clear-done", { method: "POST" });
    selectedTaskIDs.clear();
    showToast(text.replace("OK", "已清理"));
    await loadTasks({ force: true });
  } catch (error) {
    showToast(`清理失败：${error.message}`, "error");
  } finally {
    schedulePoll();
  }
}

async function refreshAndSchedule(force = false) {
  window.clearTimeout(pollTimer);
  await loadTasks({ force });
  schedulePoll();
}

function schedulePoll() {
  window.clearTimeout(pollTimer);
  if (document.hidden) return;
  const active = currentSummary.queued + currentSummary.downloading > 0;
  pollTimer = window.setTimeout(refreshAndSchedule, active ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
}

async function loadTasks({ force = false } = {}) {
  if (loadTasksPromise) {
    await loadTasksPromise;
    if (force) await loadTasks({ force: true });
    return;
  }
  loadTasksPromise = (async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(currentOffset),
          status: currentFilter,
        });
        const url = `/tasks?${params}`;
        const headers = {};
        if (!force && pageETags.has(url)) headers["If-None-Match"] = pageETags.get(url);
        const response = await apiFetch(url, { headers });
        if (response.status === 304) return;
        if (!response.ok) throw new Error(await response.text());
        const page = await response.json();
        if (!page || !Array.isArray(page.tasks) || !page.summary) throw new Error("任务列表响应无效");
        const etag = response.headers.get("ETag");
        if (etag) pageETags.set(url, etag);
        currentTotal = safeCount(page.total);
        currentSummary = normalizeSummary(page.summary);
        if (currentOffset >= currentTotal && currentOffset > 0) {
          currentOffset = Math.max(0, Math.floor(Math.max(0, currentTotal - 1) / PAGE_SIZE) * PAGE_SIZE);
          force = true;
          continue;
        }
        renderTasks(page.tasks);
        updateMetrics(currentSummary);
        updatePagination();
        return;
      }
    } catch (error) {
      console.error("loadTasks:", error);
      showToast(`加载任务失败：${error.message}`, "error");
    } finally {
      loadTasksPromise = null;
    }
  })();
  await loadTasksPromise;
}

function renderTasks(tasks) {
  currentTasks = [...tasks].sort((a, b) => {
    const statusDiff = (statusMeta[a.status]?.rank ?? 9) - (statusMeta[b.status]?.rank ?? 9);
    return statusDiff || b.id - a.id;
  });
  const signature = JSON.stringify([
    currentOffset,
    currentFilter,
    currentTasks.map((task) => [
      task.id, task.status, task.outputName, task.name, task.folder, task.link, task.progress, task.error,
    ]),
  ]);
  if (signature === lastTaskRenderSignature) {
    syncSelectionControls();
    return;
  }
  lastTaskRenderSignature = signature;

  if (!currentTasks.length) {
    els.tasksContainer.innerHTML = emptyMarkup();
    syncSelectionControls();
    return;
  }
  const rows = currentTasks.map((task, index) => taskRow(task, index)).join("");
  els.tasksContainer.innerHTML = `
    <table class="tasks-table">
      <colgroup>
        <col class="col-select"><col class="col-index"><col class="col-file"><col class="col-status">
        <col class="col-link"><col class="col-progress"><col class="col-actions">
      </colgroup>
      <thead><tr>
        <th scope="col" class="select-cell"><input type="checkbox" data-select-page aria-label="选择本页全部任务"></th>
        <th scope="col">#</th><th scope="col">文件</th><th scope="col">状态</th><th scope="col">链接</th>
        <th scope="col">进度 / 日志</th><th scope="col" class="align-right">操作</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  syncSelectionControls();
}

function taskRow(task, index) {
  const status = statusMeta[task.status] ? task.status : "queued";
  const statusLabel = statusMeta[status].label;
  const progress = task.error ? `! ${task.error}` : task.progress || "-";
  const fileName = task.outputName || task.name || `任务 #${task.id}`;
  const actions = [];
  if (status === "error") actions.push(actionButton("requeue", task.id, "重试"));
  if (status === "queued" || status === "downloading") actions.push(actionButton("pause", task.id, "暂停"));
  if (status === "paused") actions.push(actionButton("resume", task.id, "继续"));
  actions.push(actionButton("remove", task.id, "移除", true));
  return `
    <tr data-task-id="${task.id}">
      <td class="select-cell"><input type="checkbox" data-select-task value="${task.id}" aria-label="选择任务 ${esc(fileName)}"${selectedTaskIDs.has(task.id) ? " checked" : ""}></td>
      <td class="task-index">${currentOffset + index + 1}</td>
      <td><div class="task-name" title="${esc(fileName)}">${esc(fileName)}</div><div class="task-folder" title="${esc(task.folder || "默认目录")}">${esc(task.folder || "默认目录")}</div></td>
      <td><span class="status-badge status-${status}">${statusLabel}</span></td>
      <td><button class="task-link" type="button" data-action="copy-link" data-link="${esc(task.link)}" title="点击复制：${esc(task.link)}">${esc(compactUrl(task.link))}</button></td>
      <td><div class="progress-line" title="${esc(progress)}">${esc(progress)}</div></td>
      <td><div class="row-actions">${actions.join("")}</div></td>
    </tr>`;
}

function actionButton(action, id, label, danger = false) {
  return `<button class="text-button${danger ? " text-button-danger" : ""}" type="button" data-action="${action}" data-id="${id}">${label}</button>`;
}

function syncSelectionControls() {
  const visibleIDs = currentTasks.map((task) => task.id);
  const selectedVisible = visibleIDs.filter((id) => selectedTaskIDs.has(id)).length;
  const selectPage = els.tasksContainer.querySelector("[data-select-page]");
  if (selectPage) {
    selectPage.checked = visibleIDs.length > 0 && selectedVisible === visibleIDs.length;
    selectPage.indeterminate = selectedVisible > 0 && selectedVisible < visibleIDs.length;
  }
  els.batchToolbar.hidden = selectedTaskIDs.size === 0;
  els.batchSelectionCount.textContent = `已选择 ${selectedTaskIDs.size} 项`;
}

function updateMetrics(summary) {
  els.taskCount.textContent = summary.total;
  els.activeCount.textContent = summary.queued + summary.downloading;
  els.errorCount.textContent = summary.error;
  els.retryAllBtn.disabled = summary.error === 0;
  els.clearDoneBtn.disabled = summary.done === 0;
}

function updatePagination() {
  const first = currentTotal ? currentOffset + 1 : 0;
  const last = Math.min(currentOffset + PAGE_SIZE, currentTotal);
  els.pageInfo.textContent = `${first}–${last} / ${currentTotal}`;
  els.prevPageBtn.disabled = currentOffset === 0;
  els.nextPageBtn.disabled = currentOffset + PAGE_SIZE >= currentTotal;
}

async function changePage(direction) {
  const nextOffset = Math.max(0, currentOffset + direction * PAGE_SIZE);
  if (nextOffset === currentOffset || nextOffset >= Math.max(currentTotal, 1)) return;
  currentOffset = nextOffset;
  lastTaskRenderSignature = "";
  await refreshAndSchedule();
  els.tasksWrap.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
}

function emptyMarkup() {
  const filtered = currentFilter !== "all";
  return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">↓</div><h2>${filtered ? "此筛选下暂无任务" : "暂无任务"}</h2><p>${filtered ? "请选择其他状态筛选。" : "点击右上角「新建下载」开始添加链接。"}</p></div>`;
}

function openSettingsModal() {
  settingsReturnFocus = document.activeElement;
  renderDownloadSettings();
  els.settingsOverlay.classList.add("open");
  els.settingsOverlay.setAttribute("aria-hidden", "false");
  els.settingsOverlay.removeAttribute("inert");
  document.body.classList.add("modal-open");
  window.setTimeout(() => els.cfgFolder.focus(), 80);
}

function closeSettingsModal() {
  if (!els.settingsOverlay.classList.contains("open")) return;
  els.settingsOverlay.classList.remove("open");
  els.settingsOverlay.setAttribute("aria-hidden", "true");
  els.settingsOverlay.setAttribute("inert", "");
  document.body.classList.remove("modal-open");
  if (settingsReturnFocus instanceof HTMLElement && settingsReturnFocus.isConnected) {
    settingsReturnFocus.focus();
  }
  settingsReturnFocus = null;
}

function loadDownloadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(DOWNLOAD_DEFAULTS_KEY) || "null");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { ...DEFAULT_DOWNLOAD_SETTINGS };
    return {
      ...DEFAULT_DOWNLOAD_SETTINGS,
      folder: stringValue(stored.folder),
      connections: boundedInt(stored.connections, 1, 64, DEFAULT_DOWNLOAD_SETTINGS.connections),
      speed: boundedNumber(stored.speed, 0, 1 << 30, DEFAULT_DOWNLOAD_SETTINGS.speed),
      speedUnit: [1024, 1048576, 1073741824].includes(Number(stored.speedUnit))
        ? Number(stored.speedUnit) : DEFAULT_DOWNLOAD_SETTINGS.speedUnit,
      maxTries: boundedInt(stored.maxTries, 0, 100, DEFAULT_DOWNLOAD_SETTINGS.maxTries),
      retryWait: boundedInt(stored.retryWait, 0, 3600, DEFAULT_DOWNLOAD_SETTINGS.retryWait),
      proxy: stringValue(stored.proxy),
      userAgent: stringValue(stored.userAgent),
      referer: stringValue(stored.referer),
      headers: stringValue(stored.headers),
      allocation: ["none", "prealloc", "trunc", "falloc"].includes(stored.allocation)
        ? stored.allocation : DEFAULT_DOWNLOAD_SETTINGS.allocation,
      checkIntegrity: stored.checkIntegrity === true,
      remoteTime: stored.remoteTime !== false,
      extra: stringValue(stored.extra),
    };
  } catch {
    return { ...DEFAULT_DOWNLOAD_SETTINGS };
  }
}

function renderDownloadSettings(settings = downloadSettings) {
  els.cfgFolder.value = settings.folder;
  els.cfgConns.value = settings.connections;
  els.cfgSpeed.value = settings.speed || "";
  els.cfgSpeedUnit.value = String(settings.speedUnit);
  els.cfgTries.value = settings.maxTries;
  els.cfgWait.value = settings.retryWait;
  els.cfgProxy.value = settings.proxy;
  els.cfgUserAgent.value = settings.userAgent;
  els.cfgReferer.value = settings.referer;
  els.cfgHeaders.value = settings.headers;
  els.cfgAllocation.value = settings.allocation;
  els.cfgCheckIntegrity.checked = settings.checkIntegrity;
  els.cfgRemoteTime.checked = settings.remoteTime;
  els.cfgExtra.value = settings.extra;
}

function saveDownloadSettings(event) {
  event.preventDefault();
  try {
    parseHeaders(els.cfgHeaders.value);
    const speed = Number(els.cfgSpeed.value || 0);
    const speedUnit = Number(els.cfgSpeedUnit.value);
    const speedBps = Math.round(speed * speedUnit);
    if (!Number.isFinite(speed) || speed < 0 || !Number.isSafeInteger(speedBps) || speedBps > MAX_SPEED_BPS) {
      throw new Error("限速数值过大");
    }
    const nextSettings = {
      folder: els.cfgFolder.value.trim(),
      connections: optionalInt("cfgConns") || DEFAULT_DOWNLOAD_SETTINGS.connections,
      speed,
      speedUnit,
      maxTries: optionalIntAllowZero("cfgTries", DEFAULT_DOWNLOAD_SETTINGS.maxTries),
      retryWait: optionalIntAllowZero("cfgWait", DEFAULT_DOWNLOAD_SETTINGS.retryWait),
      proxy: els.cfgProxy.value.trim(),
      userAgent: els.cfgUserAgent.value.trim(),
      referer: els.cfgReferer.value.trim(),
      headers: els.cfgHeaders.value.trim(),
      allocation: els.cfgAllocation.value,
      checkIntegrity: els.cfgCheckIntegrity.checked,
      remoteTime: els.cfgRemoteTime.checked,
      extra: els.cfgExtra.value.trim(),
    };
    localStorage.setItem(DOWNLOAD_DEFAULTS_KEY, JSON.stringify(nextSettings));
    downloadSettings = nextSettings;
    closeSettingsModal();
    showToast("下载器默认设置已保存。");
  } catch (error) {
    showToast(`设置未保存：${error.message}`, "error");
  }
}

function resetDownloadSettings() {
  renderDownloadSettings(DEFAULT_DOWNLOAD_SETTINGS);
  showToast("已恢复默认值，点击「保存设置」后生效。");
}

function settingsSpeedBps() {
  return Math.round(downloadSettings.speed * downloadSettings.speedUnit);
}

function settingsExtraArgs() {
  const args = [];
  if (downloadSettings.proxy) args.push(`--all-proxy=${downloadSettings.proxy}`);
  args.push(`--file-allocation=${downloadSettings.allocation}`);
  args.push(`--check-integrity=${downloadSettings.checkIntegrity}`);
  args.push(`--remote-time=${downloadSettings.remoteTime}`);
  return [...args, ...downloadSettings.extra.split("\n").map((line) => line.trim()).filter(Boolean)];
}

function parseHeaders(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.values(parsed).some((item) => typeof item !== "string")) {
    throw new Error("Headers 必须是字符串键值的 JSON 对象");
  }
  return parsed;
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function mergeHeaders(defaults, overrides) {
  const merged = { ...defaults };
  for (const [name, value] of Object.entries(overrides)) {
    const previous = Object.keys(merged).find((key) => key.toLowerCase() === name.toLowerCase());
    if (previous) delete merged[previous];
    merged[name] = value;
  }
  return merged;
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function boundedInt(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function boundedNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

async function loadAuthSettings() {
  const settings = await requestJSON("/auth/settings");
  applyAuthSettings(settings);
}

function applyAuthSettings(settings) {
  tokenAuthEnabled = settings.enabled === true;
  tokenAuthManaged = settings.managed === true;
  els.tokenAuthEnabled.checked = tokenAuthEnabled;
  els.tokenAuthEnabled.disabled = tokenAuthManaged;
  els.copyApiTokenBtn.disabled = !tokenAuthEnabled;
  els.tokenAuthStatus.textContent = tokenAuthManaged
    ? "认证由启动参数或远程监听策略管理，不能在当前页面关闭。"
    : tokenAuthEnabled
      ? "已启用；浏览器集成需要填写下方可复制的 API Key。"
      : "已关闭；浏览器集成的 API Key 请保持为空。";
}

async function updateAuthSettings() {
  const requested = els.tokenAuthEnabled.checked;
  els.tokenAuthEnabled.disabled = true;
  els.tokenAuthEnabled.setAttribute("aria-busy", "true");
  try {
    const settings = await requestJSON("/auth/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: requested }),
    });
    if (settings.enabled && settings.token) rememberSessionToken(settings.token);
    if (!settings.enabled) clearSessionToken();
    apiTokenPromptDismissed = false;
    applyAuthSettings(settings);
    showToast(settings.enabled ? "API Key 认证已启用，当前页面连接保持有效。" : "API Key 认证已关闭。");
    await loadTasks({ force: true });
  } catch (error) {
    showToast(`更新认证设置失败：${error.message}`, "error");
    try {
      await loadAuthSettings();
    } catch {
      els.tokenAuthEnabled.checked = tokenAuthEnabled;
    }
  } finally {
    els.tokenAuthEnabled.disabled = tokenAuthManaged;
    els.tokenAuthEnabled.removeAttribute("aria-busy");
  }
}

async function copyAPIToken() {
  els.copyApiTokenBtn.disabled = true;
  els.copyApiTokenBtn.setAttribute("aria-busy", "true");
  try {
    const response = await requestJSON("/auth/token");
    if (!response.enabled) {
      showToast("API Key 认证当前未启用；浏览器集成可将 API Key 留空。");
      return;
    }
    if (!response.token) throw new Error("API Key 不可用");
    await writeClipboard(response.token);
    showToast("TrueDown API Key 已复制，请粘贴到需要连接的浏览器扩展设置页。");
  } catch (error) {
    showToast(`复制 API Key 失败：${error.message}`, "error");
  } finally {
    els.copyApiTokenBtn.disabled = !tokenAuthEnabled;
    els.copyApiTokenBtn.removeAttribute("aria-busy");
  }
}

async function requestText(url, options) {
  const response = await apiFetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(text.trim() || response.statusText);
  return text;
}

async function requestJSON(url, options) {
  const response = await apiFetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(text.trim() || response.statusText);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("服务端返回了无效 JSON");
  }
}

async function apiFetch(url, options = {}) {
  let response = await fetchWithAPIToken(url, options);
  if (response.status !== 401 || apiTokenPromptDismissed) return response;

  clearSessionToken();
  const supplied = window.prompt("此 TrueDown 正在远程接口上运行。请输入 API Key：");
  if (supplied === null) {
    apiTokenPromptDismissed = true;
    return response;
  }
  const normalized = supplied.trim();
  if (normalized.length < 32 || normalized.length > 256 || /[\0\r\n]/.test(normalized)) {
    apiTokenPromptDismissed = true;
    throw new Error("API Key 格式无效；请刷新页面后重试");
  }
  rememberSessionToken(normalized);

  response = await fetchWithAPIToken(url, options);
  if (response.status === 401) {
    clearSessionToken();
    apiTokenPromptDismissed = true;
  }
  return response;
}

function rememberSessionToken(token) {
  apiToken = token;
  try {
    window.sessionStorage.setItem(API_TOKEN_SESSION_KEY, apiToken);
  } catch {
    // The token still remains in memory for this page when session storage is unavailable.
  }
}

function fetchWithAPIToken(url, options) {
  const headers = new Headers(options.headers || {});
  if (apiToken) headers.set("X-Api-Key", apiToken);
  return fetch(url, { ...options, headers });
}

function readSessionToken() {
  try {
    return window.sessionStorage.getItem(API_TOKEN_SESSION_KEY) || "";
  } catch {
    return "";
  }
}

function clearSessionToken() {
  apiToken = "";
  try {
    window.sessionStorage.removeItem(API_TOKEN_SESSION_KEY);
  } catch {
    // Ignore storage restrictions; the in-memory token has already been cleared.
  }
}

async function mapLimitSettled(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason, item: items[index] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function copyTaskLink(link) {
  if (!link) {
    showToast("没有可复制的下载链接。", "error");
    return;
  }
  try {
    await writeClipboard(link);
    showToast("下载链接已复制。");
  } catch (error) {
    showToast(`复制失败：${error.message}`, "error");
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.className = "clipboard-fallback";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器拒绝访问剪贴板");
}

function showModalMsg(text, isError = false) {
  els.modalMsg.textContent = text;
  els.modalMsg.classList.toggle("err", isError);
}

function showToast(text, type = "success") {
  window.clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.className = `kd-toast is-visible ${type === "error" ? "error" : "success"}`;
  toastTimer = window.setTimeout(() => { els.toast.className = "kd-toast"; }, 3200);
}

function optionalInt(key) {
  const value = els[key].value.trim();
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function optionalIntAllowZero(key, fallback) {
  const value = els[key].value.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function lines(key) {
  return els[key].value.trim().split("\n").map((line) => line.trim()).filter(Boolean);
}

function parseLinks(value) {
  const links = value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (links.length > 5000) throw new Error("单次最多添加 5000 个链接");
  const unique = [];
  const seen = new Set();
  for (const link of links) {
    let parsed;
    try {
      parsed = new URL(link);
    } catch {
      throw new Error(`下载链接无效：${link}`);
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error(`仅支持不含凭据的 HTTP(S) 下载链接：${link}`);
    }
    const normalized = parsed.toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }
  return unique;
}

function normalizeSummary(value) {
  return {
    total: safeCount(value.total), queued: safeCount(value.queued), downloading: safeCount(value.downloading),
    paused: safeCount(value.paused), done: safeCount(value.done), error: safeCount(value.error),
  };
}

function emptySummary() {
  return { total: 0, queued: 0, downloading: 0, paused: 0, done: 0, error: 0 };
}

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function emptyToUndefined(value) {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function compactUrl(value) {
  if (!value) return "—";
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return value;
  }
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
