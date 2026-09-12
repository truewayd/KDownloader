const ACTIVE_POLL_INTERVAL_MS = 2500;
const IDLE_POLL_INTERVAL_MS = 10000;
const PAGE_SIZE = 100;
const MAX_SELECTED_TASKS = 1000;
const MAX_PAGE_ETAGS = 128;
const LEGACY_THEME_KEY = "truedown-theme";
const API_TOKEN_SESSION_KEY = "truedown-api-token";
const DOWNLOAD_DEFAULTS_KEY = "truedown-download-defaults-v1";
const MAX_SPEED_BPS = 2 ** 50;
const DEFAULT_EXCLUDED_EXTENSIONS = Object.freeze([
  ".psd", ".clip", ".sai", ".sai2", ".kra", ".xcf", ".procreate", ".afphoto", ".afdesign", ".blend",
]);
const DEFAULT_DOWNLOAD_RULES = Object.freeze({
  enabled: false,
  excludedExtensions: DEFAULT_EXCLUDED_EXTENSIONS,
  dropboxMode: "direct",
});
const DEFAULT_RUNTIME_SETTINGS = Object.freeze({
  concurrentDownloads: 3,
  globalDownloadLimitBps: 0,
});
const KNOWN_NEXT_LIBTORRENT_VERSIONS = Object.freeze({
  "2.6.6": "2.1.1",
});
const DEFAULT_TRACKER_RESEARCH_SETTINGS = Object.freeze({
  enabled: false,
  minimumLeechers: 3,
  downloadMultiplierMin: 0,
  downloadMultiplierMax: 0.001,
  uploadMultiplierMin: 2,
  uploadMultiplierMax: 8,
  bonusKiBPerSecond: 15,
  bonusChancePercent: 5,
  reportDownloadAsZero: false,
  pretendToSeed: false,
  onlyTrackerTraffic: true,
  onlyLocalConnections: true,
  engine: "stable",
  engineVersion: "",
  requiredRPC: "aria2.replaceBtTrackers",
  minimumNextVersion: "2.5.7",
  supportKnown: false,
  supported: false,
  active: false,
  configuredTorrents: 0,
  rewrittenTrackers: 0,
  forwardedAnnounces: 0,
  lastError: "",
});
const DEFAULT_DOWNLOAD_SETTINGS = Object.freeze({
  folder: "",
  connections: 16,
  speed: 0,
  speedUnit: 1048576,
  maxTries: 5,
  retryWait: 3,
  proxy: "",
  proxyMode: "system",
  userAgent: "",
  referer: "",
  headers: "",
  allocation: "none",
  checkIntegrity: false,
  remoteTime: true,
  extra: "",
});

const statusMeta = {
  downloading: { label: "下载中" },
  queued: { label: "排队中" },
  paused: { label: "已暂停" },
  error: { label: "出错" },
  done: { label: "已完成" },
};

const els = {};
const selectedTaskIDs = new Set();
const taskStatusByID = new Map();
const activeTaskActions = new Set();
const pageETags = new Map();
let trueDownToast = null;
let pollTimer = 0;
let searchTimer = 0;
let modalMode = "single";
let currentTasks = [];
let currentSummary = emptySummary();
let currentOffset = 0;
let currentTotal = 0;
let currentFilter = "all";
let currentCategory = "";
let currentSearch = "";
let currentSort = "status";
let currentSortOrder = "asc";
let loadTasksPromise = null;
let taskRefreshRequested = false;
let renderedTaskPageURL = "";
let lastTaskRenderSignature = "";
let modalReturnFocus = null;
let apiToken = readSessionToken();
let apiTokenPromptDismissed = false;
let tokenAuthEnabled = false;
let tokenAuthManaged = false;
let downloadSettings = loadDownloadSettings();
let downloadRules = {
  enabled: DEFAULT_DOWNLOAD_RULES.enabled,
  excludedExtensions: [...DEFAULT_DOWNLOAD_RULES.excludedExtensions],
  dropboxMode: DEFAULT_DOWNLOAD_RULES.dropboxMode,
};
let runtimeSettings = { ...DEFAULT_RUNTIME_SETTINGS };
let trackerResearchSettings = { ...DEFAULT_TRACKER_RESEARCH_SETTINGS };
let resolverModules = [];
let systemUpdateState = null;
let dialogReturnFocus = null;
let dialogResolver = null;
let dialogHasInput = false;
let dialogValidator = null;
let apiTokenRequestPromise = null;

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  KDComponents.prepareDecorativeIcons();
  trueDownToast = KDComponents.createToast(els.toast, { duration: 3200 });
  initTheme();
  renderDownloadSettings();
  renderTrackerResearchSettings();
  bindEvents();
  initTaskDetails();
  if (isNativeTaskWindow()) await initNativeTaskForm();
  else initWorkspace();
  if (nativeWindowRole === "main") {
    subscribeToCreatedTasks();
    invokeNative("desktop_ready").catch((error) => showToast(error.message, "error"));
  }
});

function cacheElements() {
  [
    "active-count",
	"auto-update-truedown",
    "batch-pause-btn",
    "batch-remove-btn",
    "batch-resume-btn",
    "batch-selection-count",
    "batch-task-btn",
    "batch-toolbar",
    "cfg-conns",
	"cfg-allocation",
	"cfg-check-integrity",
	"cfg-dropbox-mode",
    "cfg-extra",
    "cfg-filter-enabled",
    "cfg-folder",
    "cfg-global-speed",
    "cfg-global-speed-unit",
    "cfg-headers",
    "cfg-proxy",
    "cfg-proxy-mode",
    "cfg-referer",
    "cfg-remote-time",
    "cfg-speed",
    "cfg-speed-unit",
    "cfg-task-concurrency",
    "cfg-tries",
    "cfg-user-agent",
    "cfg-wait",
    "clear-done-btn",
	"check-truedown-update-btn",
	"copy-application-log-btn",
    "copy-api-token-btn",
    "download-form",
    "dialog-cancel-btn",
    "dialog-close-btn",
    "dialog-confirm-btn",
    "dialog-error",
    "dialog-eyebrow",
    "dialog-form",
    "dialog-input",
    "dialog-input-field",
    "dialog-input-label",
    "dialog-message",
    "dialog-overlay",
    "dialog-title",
    "error-count",
    "exit-from-settings-btn",
    "m-conns",
    "m-extra",
    "m-folder",
    "m-headers",
    "m-link",
    "m-name",
    "m-queueid",
    "m-referer",
    "m-speed",
	"m-torrent-file",
    "m-tries",
    "m-wait",
    "modal-cancel-btn",
    "modal-close-btn",
    "modal-eyebrow",
    "modal-msg",
    "modal-title",
	"module-list",
	"engine-update-status",
	"engine-version",
	"install-next-engine-btn",
    "new-task-btn",
    "next-page-btn",
    "open-downloads-btn",
    "overlay",
    "page-info",
    "prev-page-btn",
    "pause-queue-btn",
    "refresh-tasks-btn",
    "retry-all-btn",
    "resume-queue-btn",
	"restart-truedown-update-btn",
	"refresh-application-log-btn",
	"select-next-engine-btn",
	"select-stable-engine-btn",
    "settings-btn",
    "settings-form",
    "settings-save-btn",
    "settings-footer",
    "settings-load-status",
    "settings-save-status",
    "settings-reload-btn",
    "startup-enabled",
    "startup-status",
    "settings-reset-btn",
    "submit-task-btn",
    "task-count",
    "task-detail-actions",
    "task-filter",
    "task-search",
    "tasks-container",
    "tasks-wrap",
    "token-auth-enabled",
    "token-auth-status",
    "toast",
	"tracker-bonus-chance-percent",
	"tracker-bonus-kib-per-second",
	"tracker-download-multiplier-max",
	"tracker-download-multiplier-min",
	"tracker-local-only",
	"tracker-minimum-leechers",
	"tracker-only-traffic",
	"tracker-pretend-seed",
	"tracker-report-download-zero",
	"tracker-research-enabled",
	"tracker-research-status",
	"tracker-upload-multiplier-max",
	"tracker-upload-multiplier-min",
	"bt-client-identity",
	"application-log-output",
	"application-log-status",
	"truedown-update-status",
	"truedown-update-version",
  ].forEach((id) => {
    els[toCamel(id)] = document.getElementById(id);
  });
}

function bindEvents() {
  els.newTaskBtn.addEventListener("click", () => openModal("single"));
  els.batchTaskBtn.addEventListener("click", () => openModal("batch"));
  els.settingsResetBtn.addEventListener("click", resetDownloadSettings);
  els.settingsForm.addEventListener("submit", saveDownloadSettings);
  els.settingsForm.addEventListener("input", markSettingsDraft);
  els.settingsReloadBtn.addEventListener("click", () => loadSettingsPage(true));
  els.startupEnabled.addEventListener("change", updateStartupSettings);
  els.trackerPretendSeed.addEventListener("change", syncTrackerSeedControls);
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
    if (isNativeTaskWindow()) {
      refreshNativeTaskFormOnActivation();
      return;
    }
    refreshAndSchedule();
  });
  window.addEventListener("pagehide", () => window.clearTimeout(pollTimer), { once: true });

  els.downloadForm.addEventListener("submit", submitTask);
  bindNativeTaskPreferences();
  bindDownloadDrops();
  els.refreshTasksBtn.addEventListener("click", refreshTasks);
  els.retryAllBtn.addEventListener("click", requeueAllErrorTasks);
  els.pauseQueueBtn.addEventListener("click", () => runQueueAction("pause"));
  els.resumeQueueBtn.addEventListener("click", () => runQueueAction("resume"));
  els.openDownloadsBtn.addEventListener("click", openDownloadsDirectory);
  els.clearDoneBtn.addEventListener("click", clearDone);
  els.tasksContainer.addEventListener("click", onTaskAction);
  els.tasksContainer.addEventListener("click", onTaskSort);
  els.tasksContainer.addEventListener("change", onTaskSelection);
  els.taskSearch.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(applyTaskSearch, 250);
  });
  els.taskSearch.addEventListener("search", applyTaskSearch);
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
	els.moduleList.addEventListener("click", onModuleAction);
  els.autoUpdateTruedown.addEventListener("change", updateTrueDownAutoUpdate);
  document.getElementById("auto-update-next").addEventListener("change", updateNextAutoUpdate);
  els.cfgProxyMode.addEventListener("change", renderProxyMode);
  els.checkTruedownUpdateBtn.addEventListener("click", checkTrueDownUpdate);
	els.refreshApplicationLogBtn.addEventListener("click", () => loadApplicationLog(true));
	els.copyApplicationLogBtn.addEventListener("click", copyApplicationLog);
  els.exitFromSettingsBtn.addEventListener("click", exitTrueDown);
  els.restartTruedownUpdateBtn.addEventListener("click", restartForTrueDownUpdate);
  els.installNextEngineBtn.addEventListener("click", installNextEngine);
  els.selectStableEngineBtn.addEventListener("click", () => selectDownloadEngine("stable"));
  els.selectNextEngineBtn.addEventListener("click", () => selectDownloadEngine("next"));
  els.dialogForm.addEventListener("submit", submitDialog);
  els.dialogCloseBtn.addEventListener("click", cancelDialog);
  els.dialogCancelBtn.addEventListener("click", cancelDialog);
  els.dialogOverlay.addEventListener("click", (event) => {
    if (event.target === els.dialogOverlay) cancelDialog();
  });
}

function applyTaskSearch() {
  window.clearTimeout(searchTimer);
  const next = els.taskSearch.value.trim();
  if (next === currentSearch) return;
  currentSearch = next;
  currentOffset = 0;
  lastTaskRenderSignature = "";
  refreshAndSchedule(true);
}

function initTheme() {
  localStorage.removeItem(LEGACY_THEME_KEY);
  document.documentElement.removeAttribute("data-theme");
}

function onDocumentKeydown(event) {
  const activeOverlay = els.dialogOverlay.classList.contains("open") ? els.dialogOverlay :
    !isNativeTaskWindow() && els.overlay.classList.contains("open") ? els.overlay : null;
  if (!activeOverlay) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (activeOverlay === els.dialogOverlay) cancelDialog();
    else closeModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...activeOverlay.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));
  if (!focusable.length) {
    event.preventDefault();
    activeOverlay.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!focusable.includes(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function openModal(mode = "single") {
  if (els.downloadForm.inert || els.newTaskBtn.getAttribute("aria-busy") === "true") return;
  if (typeof nativeWindowRole !== "undefined" && nativeWindowRole !== "browser") {
    KDComponents.setBusyState(els.newTaskBtn, true);
    KDComponents.setBusyState(els.batchTaskBtn, true);
    try {
      await invokeNative("open_auxiliary", { kind: mode === "batch" ? "batch-task" : "new-task" });
    } catch (error) {
      showToast(`打开下载窗口失败：${error.message}`, "error");
    } finally {
      KDComponents.setBusyState(els.newTaskBtn, false);
      KDComponents.setBusyState(els.batchTaskBtn, false);
    }
    return;
  }
  const returnFocus = document.activeElement;
  const epoch = routeEpoch;
  KDComponents.setBusyState(els.newTaskBtn, true);
  KDComponents.setBusyState(els.batchTaskBtn, true);
  try {
    await Promise.all([loadServerTaskDefaults(), loadServerDownloadRules(), loadResolverModules()]);
  } catch (error) {
    showToast(`读取新任务默认值失败：${error.message}`, "error");
    return;
  } finally {
    KDComponents.setBusyState(els.newTaskBtn, false);
    KDComponents.setBusyState(els.batchTaskBtn, false);
    if (epoch === routeEpoch && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  if (epoch !== routeEpoch) return;
  modalReturnFocus = returnFocus;
  configureTaskForm(mode);
  els.overlay.classList.add("open");
  els.overlay.setAttribute("aria-hidden", "false");
  els.overlay.removeAttribute("inert");
  document.body.classList.add("modal-open");
  els.mLink.focus();
}

function configureTaskForm(mode) {
  modalMode = mode;
  const isBatch = mode === "batch";
	els.mTorrentFile.value = "";
	els.mTorrentFile.disabled = isBatch;
  if (typeof updateTorrentSelection === "function") updateTorrentSelection();
  els.modalEyebrow.textContent = isBatch ? "Batch download" : "New download";
  els.modalTitle.textContent = isBatch ? "批量下载任务" : "新建下载任务";
  els.submitTaskBtn.textContent = isBatch ? "批量开始" : "开始下载";
  els.mLink.rows = isBatch ? 7 : 2;
  els.mLink.placeholder = isBatch
    ? "https://example.com/file-a.zip\nmagnet:?xt=urn:btih:...\nhttps://example.com/file.torrent"
    : "https://example.com/file.zip 或 magnet:?xt=urn:btih:...";
  els.mName.disabled = isBatch;
  els.mName.placeholder = isBatch ? "批量时自动命名" : "普通 HTTP(S) 留空自动命名；BT 使用元信息名称";
  els.mFolder.placeholder = downloadSettings.folder || "留空使用默认下载目录";
  if (isBatch) els.mName.value = "";

}


function buildModuleOptions() {
  const options = {};
  if (isModuleInstalled("dropbox")) options.dropbox = {
    mode: downloadRules.dropboxMode,
    applyFilter: downloadRules.dropboxMode === "expand" && downloadRules.enabled,
  };
  if (isModuleInstalled("google-drive")) options["google-drive"] = {};
  return options;
}

function closeModal() {
  if (isNativeTaskWindow()) {
    invokeNative("close_auxiliary").catch((error) => showModalMsg(`关闭窗口失败：${error.message}`, true));
    return;
  }
  if (!els.overlay.classList.contains("open")) return;
  els.overlay.classList.remove("open");
  els.overlay.setAttribute("aria-hidden", "true");
  els.overlay.setAttribute("inert", "");
  syncModalScrollLock();
  showModalMsg("");
  if (modalReturnFocus instanceof HTMLElement && modalReturnFocus.isConnected) {
    modalReturnFocus.focus();
  }
  modalReturnFocus = null;
}

function showDialog({
  title,
  message,
  eyebrow = "Confirm action",
  confirmLabel = "确认",
  danger = false,
  inputLabel = "",
  inputType = "text",
  validate = null,
}) {
  if (dialogResolver) throw new Error("已有对话框正在等待处理");
  dialogReturnFocus = document.activeElement;
  dialogHasInput = Boolean(inputLabel);
  dialogValidator = validate;
  els.dialogEyebrow.textContent = eyebrow;
  els.dialogTitle.textContent = title;
  els.dialogMessage.textContent = message;
  els.dialogConfirmBtn.textContent = confirmLabel;
  els.dialogConfirmBtn.className = `kd-button ${danger ? "danger" : "primary"}`;
  els.dialogInputField.hidden = !dialogHasInput;
  els.dialogInputLabel.textContent = inputLabel;
  els.dialogInput.type = inputType;
  els.dialogInput.value = "";
  els.dialogError.hidden = true;
  els.dialogError.textContent = "";
  els.dialogOverlay.classList.add("open");
  els.dialogOverlay.setAttribute("aria-hidden", "false");
  els.dialogOverlay.removeAttribute("inert");
  document.body.classList.add("modal-open");
  (dialogHasInput ? els.dialogInput : danger ? els.dialogCancelBtn : els.dialogConfirmBtn).focus();
  return new Promise((resolve) => { dialogResolver = resolve; });
}

function submitDialog(event) {
  event.preventDefault();
  const value = dialogHasInput ? els.dialogInput.value : true;
  const error = dialogValidator ? dialogValidator(value) : "";
  if (error) {
    els.dialogError.textContent = error;
    els.dialogError.hidden = false;
    els.dialogInput.focus();
    return;
  }
  settleDialog(value);
}

function cancelDialog() {
  settleDialog(dialogHasInput ? null : false);
}

function settleDialog(value) {
  if (!dialogResolver) return;
  const resolve = dialogResolver;
  dialogResolver = null;
  dialogValidator = null;
  els.dialogOverlay.classList.remove("open");
  els.dialogOverlay.setAttribute("aria-hidden", "true");
  els.dialogOverlay.setAttribute("inert", "");
  syncModalScrollLock();
  if (dialogReturnFocus instanceof HTMLElement && dialogReturnFocus.isConnected) {
    dialogReturnFocus.focus();
  }
  dialogReturnFocus = null;
  resolve(value);
}

async function confirmAction(options) {
  if (!window.__TAURI__?.core?.invoke) return showDialog(options);
  const returnFocus = document.activeElement;
  try {
    return await invokeNative("confirm_action", { options: {
      title: options.title, message: options.message, confirmLabel: options.confirmLabel || "确认",
      cancelLabel: options.cancelLabel || "取消", danger: options.danger === true,
    } });
  } finally {
    if (returnFocus?.isConnected && !returnFocus.closest("[inert]")) returnFocus.focus({ preventScroll: true });
  }
}

function syncModalScrollLock() {
  document.body.classList.toggle("modal-open", [els.overlay, els.dialogOverlay]
    .some((overlay) => overlay.classList.contains("open")));
}

async function submitTask(event) {
  event.preventDefault();
  if (els.downloadForm.inert) return;
  if (isNativeTaskWindow() && !nativeTaskFormReady) {
    await initNativeTaskForm();
    return;
  }
  const torrentFile = els.mTorrentFile.files?.[0] || null;
  let links;
  try {
    links = parseLinks(els.mLink.value);
  } catch (error) {
    showModalMsg(error.message, true);
    return;
  }
  if (!links.length && !torrentFile) {
    showModalMsg("请填写下载链接、Magnet，或选择 .torrent 文件", true);
    return;
  }
  if (links.length && torrentFile) {
    showModalMsg("链接和 .torrent 文件只能选择一种来源", true);
    return;
  }
  if (torrentFile && torrentFile.size > 4 * 1024 * 1024) {
    showModalMsg(".torrent 文件不能超过 4 MiB", true);
    return;
  }
  if (torrentFile && modalMode === "batch") {
    showModalMsg("本地 .torrent 请使用单任务模式导入", true);
    return;
  }

  if (isNativeTaskWindow()) {
    // Singleton windows retain explicit draft fields, while blank fields must
    // inherit the preferences currently saved in the separate Settings window.
    setSubmitting(true);
    try {
      await refreshNativeTaskPreferences();
    } catch (error) {
      showModalMsg(`读取当前下载默认值失败：${error.message}`, true);
      return;
    } finally {
      setSubmitting(false);
    }
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
	moduleOptions: buildModuleOptions(),
  };

  setSubmitting(true);
  try {
    if (torrentFile) {
      const torrentBase64 = await fileToBase64(torrentFile);
      const result = await requestText("/start-bt-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          torrentBase64,
          folder: sharedBody.folder,
          opts: sharedBody.opts,
        }),
      });
      if (!isNativeTaskWindow()) await loadTasks({ force: true });
      const message = result.includes("DUPLICATE") ? "已复用现有 Torrent 任务" : "Torrent 任务已创建";
      els.mTorrentFile.value = "";
      if (typeof updateTorrentSelection === "function") updateTorrentSelection();
      if (isNativeTaskWindow()) await finishNativeTaskForm(message);
      else { closeModal(); showToast(message); }
      return;
    }
    const outcomes = await mapLimitSettled(links, 8, (link) =>
      requestText(isBitTorrentLink(link) ? "/start-bt-download" : "/start-headless-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isBitTorrentLink(link)
          ? buildBitTorrentStartBody(link, sharedBody)
          : buildStartBody(link, sharedBody)),
      }),
    );
    const created = outcomes.filter((outcome) => outcome.status === "fulfilled").map((outcome) => outcome.value);
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    const duplicateCount = created.filter((text) => text.includes("DUPLICATE")).length;
    if (!isNativeTaskWindow()) await loadTasks({ force: true });
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
    const message = links.length === 1
      ? formatStartOutcome(created[0], duplicateCount > 0)
      : summary;
    els.mLink.value = "";
    if (isNativeTaskWindow()) await finishNativeTaskForm(message);
    else { closeModal(); showToast(message); }
  } catch (error) {
    showModalMsg(`创建失败：${error.message}`, true);
  } finally {
    setSubmitting(false);
    schedulePoll();
  }
}

function setSubmitting(isSubmitting) {
  els.downloadForm.inert = isSubmitting;
  els.downloadForm.setAttribute("aria-busy", String(isSubmitting));
  KDComponents.setBusyState(els.submitTaskBtn, isSubmitting);
  els.submitTaskBtn.textContent = isSubmitting ? "提交中..." : (modalMode === "batch" ? "批量开始" : "开始下载");
}

function formatStartOutcome(value, duplicate) {
  const folder = /^OK\s+(\d+)\s+FILES(?:\s+(\d+)\s+FILTERED)?(?:\s+(\d+)\s+DUPLICATE)?$/.exec(value);
  if (folder) {
    const filtered = Number(folder[2] || 0);
    const duplicates = Number(folder[3] || 0);
    return `目录解析完成：加入 ${folder[1]} 个文件${filtered ? `，过滤 ${filtered} 个` : ""}${duplicates ? `，复用 ${duplicates} 个续传任务` : ""}`;
  }
  return duplicate ? "已复用原记录并检查更新" : `已创建：${value}`;
}

function buildStartBody(link, sharedBody) {
  return {
    downloadSource: { link, headers: sharedBody.headers, downloadPage: sharedBody.downloadPage },
    folder: sharedBody.folder,
    name: sharedBody.name,
    queueId: sharedBody.queueId,
    opts: sharedBody.opts,
	moduleOptions: sharedBody.moduleOptions,
  };
}

function buildOpts(prefix) {
  const extraFromModal = lines(`${prefix}Extra`);
  return {
    connections: optionalInt(`${prefix}Conns`) || downloadSettings.connections,
    maxSpeedBps: optionalIntAllowZero(`${prefix}Speed`, settingsSpeedBps()),
    maxTries: optionalInt(`${prefix}Tries`) || downloadSettings.maxTries,
    retryWait: optionalInt(`${prefix}Wait`) || downloadSettings.retryWait,
    extraArgs: extraFromModal.length ? extraFromModal : settingsExtraArgs(),
    proxyMode: downloadSettings.proxyMode,
  };
}

async function onTaskAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = Number(button.dataset.id);
  const action = button.dataset.action;
  if (action === "details") {
    taskDetailReturnID = id;
    location.hash = `task/${id}/info`;
    return;
  }
  if (action === "copy-link") {
    await copyTaskLink(button.dataset.link || "");
    return;
  }
  if (!Number.isSafeInteger(id) || id <= 0) return;
  if (activeTaskActions.has(id)) return;
  setTaskActionBusy(id, true);
  try {
    if (action === "requeue") {
      await runTaskAction("requeue", id, "任务已重新排队。");
    }
    if (action === "pause") await runTaskAction("pause", id, "任务已暂停。");
    if (action === "resume") await runTaskAction("resume", id, "任务已继续。");
    if (action === "open-file") {
      await requestText(`/tasks/open-file?id=${encodeURIComponent(id)}`, { method: "POST" });
      showToast("已打开下载文件。");
    }
    if (action === "open-folder") {
      await requestText(`/tasks/open-folder?id=${encodeURIComponent(id)}`, { method: "POST" });
      showToast("已打开任务下载目录。");
    }
    if (action === "remove") {
      if (taskStatusByID.get(id) !== "done" && !await confirmAction({
        title: "移除下载任务",
        message: "正在下载的任务会停止，并删除未完成文件。此操作无法撤销。",
        confirmLabel: "移除任务",
        danger: true,
      })) return;
      await runTaskAction("remove", id, "任务已移除。");
    }
  } catch (error) {
    showToast(`操作失败：${error.message}`, "error");
  } finally {
    setTaskActionBusy(id, false);
  }
}

async function runTaskAction(action, id, successMessage) {
  const result = await requestJSON("/tasks/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ids: [id] }),
  });
  if (result.failed?.length) throw new Error(result.failed[0].error || "操作失败");
  if (action === "remove") {
    selectedTaskIDs.delete(id);
    taskStatusByID.delete(id);
    syncSelectionControls();
  }
  showToast(successMessage);
  await loadTasks({ force: true });
  if (currentPage === "task") await loadTaskDetails();
}

function setTaskActionBusy(id, busy) {
  if (busy) activeTaskActions.add(id);
  else activeTaskActions.delete(id);
  [...els.tasksContainer.querySelectorAll("button[data-id]"), ...(els.taskDetailActions?.querySelectorAll("button[data-id]") || [])].forEach((control) => {
    if (Number(control.dataset.id) === id) KDComponents.setBusyState(control, busy);
  });
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
  const allDownloaded = ids.every((id) => taskStatusByID.get(id) === "done");
  if (requiresConfirmation && !allDownloaded && !await confirmAction({
    title: `移除 ${ids.length} 个任务`,
    message: "已完成文件会保留；活动任务会停止，并删除未完成文件。此操作无法撤销。",
    confirmLabel: "批量移除",
    danger: true,
  })) return;
  setBatchBusy(true);
  try {
    const result = await requestJSON("/tasks/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ids }),
    });
    if (action === "remove") {
      (result.succeeded || []).forEach((id) => {
        selectedTaskIDs.delete(id);
        taskStatusByID.delete(id);
      });
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
    KDComponents.setBusyState(button, busy);
  });
}

async function runQueueAction(action) {
  const pause = action === "pause";
  const button = pause ? els.pauseQueueBtn : els.resumeQueueBtn;
  KDComponents.setBusyState(button, true);
  try {
    const result = await requestJSON(`/queue/${action}`, { method: "POST" });
    const succeeded = result.succeeded?.length || 0;
    const failed = result.failed?.length || 0;
    const verb = pause ? "暂停" : "恢复";
    showToast(`${verb}队列：成功 ${succeeded} 项${failed ? `，失败 ${failed} 项` : ""}`, failed ? "error" : "success");
    await loadTasks({ force: true });
  } catch (error) {
    showToast(`队列操作失败：${error.message}`, "error");
  } finally {
    KDComponents.setBusyState(button, false, { manageDisabled: false });
    updateMetrics(currentSummary);
    schedulePoll();
  }
}

async function openDownloadsDirectory() {
  KDComponents.setBusyState(els.openDownloadsBtn, true);
  try {
    await requestText("/system/open-downloads", { method: "POST" });
    showToast("已打开 TrueDown 下载目录。");
  } catch (error) {
    showToast(`无法打开下载目录：${error.message}`, "error");
  } finally {
    KDComponents.setBusyState(els.openDownloadsBtn, false);
  }
}

async function requeueAllErrorTasks() {
  if (els.retryAllBtn.getAttribute("aria-busy") === "true") return;
  if (!currentSummary.error) {
    showToast("没有需要重试的任务。");
    return;
  }
  KDComponents.setBusyState(els.retryAllBtn, true);
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
    KDComponents.setBusyState(els.retryAllBtn, false, { manageDisabled: false });
    updateMetrics(currentSummary);
    schedulePoll();
  }
}

async function clearDone() {
  if (!currentSummary.done) {
    showToast("没有已完成任务可清理。");
    return;
  }
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
  if (document.hidden || currentPage !== "tasks") return;
  const active = currentSummary.queued + currentSummary.downloading > 0;
  pollTimer = window.setTimeout(refreshAndSchedule, active ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
}

async function loadTasks({ force = false } = {}) {
  if (currentPage !== "tasks" || document.hidden) return false;
  if (loadTasksPromise) {
    if (force) taskRefreshRequested = true;
    return loadTasksPromise;
  }
  loadTasksPromise = (async () => {
    try {
      while (true) {
        taskRefreshRequested = false;
        if (currentPage !== "tasks" || document.hidden) return false;
        const epoch = routeEpoch;
        const url = taskPageURL();
        const headers = {};
        // Validators only save work when the corresponding body is still displayed.
        if (!force && renderedTaskPageURL === url && pageETags.has(url)) {
          headers["If-None-Match"] = pageETags.get(url);
        }
        const response = await apiFetch(url, { headers });
        if (currentPage !== "tasks" || document.hidden) return false;
        if (epoch !== routeEpoch || url !== taskPageURL()) continue;
        if (response.status === 304) {
          if (taskRefreshRequested) { force = true; continue; }
          restoreTaskReturnFocus();
          return true;
        }
        if (!response.ok) throw new Error(await response.text());
        const page = await response.json();
        if (currentPage !== "tasks" || document.hidden) return false;
        if (epoch !== routeEpoch || url !== taskPageURL()) continue;
        if (!page || !Array.isArray(page.tasks) || !page.summary) throw new Error("任务列表响应无效");
        const etag = response.headers.get("ETag");
        if (page.groups) {
          applyFileGroups(page.groups);
          if (currentCategory && !page.groups.groups.some((group) => group.id === currentCategory)) {
            currentCategory = "";
            currentOffset = 0;
            updateTaskNavigation();
            force = true;
            continue;
          }
        }
        if (etag) rememberPageETag(url, etag);
        currentTotal = safeCount(page.total);
        currentSummary = normalizeSummary(page.summary);
        if (currentOffset >= currentTotal && currentOffset > 0) {
          currentOffset = Math.max(0, Math.floor(Math.max(0, currentTotal - 1) / PAGE_SIZE) * PAGE_SIZE);
          force = true;
          continue;
        }
        renderTasks(page.tasks);
        restoreTaskReturnFocus();
        renderedTaskPageURL = url;
        updateMetrics(currentSummary);
        updatePagination();
        if (taskRefreshRequested) { force = true; continue; }
        return true;
      }
    } catch (error) {
      console.error("loadTasks:", error);
      showToast(`加载任务失败：${error.message}`, "error");
      return false;
    } finally {
      loadTasksPromise = null;
    }
  })();
  return loadTasksPromise;
}

async function refreshTasks() {
  if (els.refreshTasksBtn.getAttribute("aria-busy") === "true") return;
  KDComponents.setBusyState(els.refreshTasksBtn, true);
  try {
    if (await loadTasks({ force: true })) showToast("任务列表已刷新。");
  } finally {
    KDComponents.setBusyState(els.refreshTasksBtn, false);
    schedulePoll();
  }
}

function taskPageURL() {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(currentOffset),
    status: currentFilter,
    sort: currentSort,
    order: currentSortOrder,
  });
  if (currentSearch) params.set("search", currentSearch);
  if (currentCategory) params.set("category", currentCategory);
  return `/tasks?${params}`;
}

function renderTasks(tasks) {
  const focused = document.activeElement;
  const focusKey = els.tasksContainer.contains(focused) ? taskControlKey(focused) : "";
  for (const id of taskStatusByID.keys()) {
    if (!selectedTaskIDs.has(id)) taskStatusByID.delete(id);
  }
  tasks.forEach((task) => taskStatusByID.set(task.id, task.status));
  currentTasks = [...tasks];
  const signature = JSON.stringify([
    currentOffset,
    currentFilter,
    currentCategory,
    fileGroupsState.revision,
    currentSearch,
    currentSort,
    currentSortOrder,
    currentTasks.map((task) => [
      task.id, task.status, task.outputName, task.name, task.folder, task.link, task.progress, task.error, task.category, task.totalLength, task.completedLength, task.downloadSpeed, task.createdAt,
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
    if (focusKey) els.taskSearch.focus({ preventScroll: true });
    return;
  }
  let table = els.tasksContainer.querySelector(".tasks-table");
  if (!table) {
    els.tasksContainer.innerHTML = `
    <table class="tasks-table">
      <colgroup>
        <col class="col-select"><col class="col-index"><col class="col-file"><col class="col-status">
        <col class="col-progress"><col class="col-size"><col class="col-speed"><col class="col-created"><col class="col-actions">
      </colgroup>
      <thead><tr>
        <th scope="col" class="select-cell"><input type="checkbox" data-select-page aria-label="选择本页全部任务"></th>
        ${sortableHeading("id", "#")}${sortableHeading("file", "文件")}${sortableHeading("status", "状态")}
        ${sortableHeading("progress", "进度")}<th scope="col">大小</th><th scope="col">速度 / 剩余</th><th scope="col">添加时间</th><th scope="col" class="align-right">操作</th>
      </tr></thead>
      <tbody></tbody>
    </table>`;
    table = els.tasksContainer.querySelector(".tasks-table");
  }
  const sortKey = `${currentSort}:${currentSortOrder}`;
  if (table.dataset.sort !== sortKey) {
    const headings = ["id", "file", "status", "progress"];
    const labels = ["#", "文件", "状态", "进度"];
    headings.forEach((field, i) => {
      const heading = table.querySelectorAll("thead th")[i + 1];
      const active = currentSort === field;
      if (active) heading.setAttribute("aria-sort", currentSortOrder === "asc" ? "ascending" : "descending");
      else heading.removeAttribute("aria-sort");
      const button = heading.querySelector("button");
      button.dataset.sortOrder = active ? currentSortOrder : "none";
      const icon = active ? currentSortOrder === "asc" ? "arrow-up" : "arrow-down" : "arrow-up-down";
      button.querySelector("use").setAttribute("href", `/icons.svg#icon-${icon}`);
      button.setAttribute("aria-label", `按${labels[i]}${active && currentSortOrder === "asc" ? "降序" : "升序"}排列`);
    });
    table.dataset.sort = sortKey;
  }
  reconcileTaskRows(table.querySelector("tbody"), currentTasks);
  syncSelectionControls();
  if (focusKey && document.activeElement !== focused) {
    const controls = Array.from(els.tasksContainer.querySelectorAll("button, input"));
    const nextFocus = controls.find((control) => taskControlKey(control) === focusKey)
      || els.tasksContainer.querySelector("[data-select-page]");
    nextFocus?.focus({ preventScroll: true });
  }
}

function taskControlKey(control) {
  if (!control?.dataset) return "";
  if (control.dataset.sortField) return `sort:${control.dataset.sortField}`;
  if (control.dataset.selectPage !== undefined) return "page";
  const taskID = control.closest("[data-task-id]")?.dataset.taskId;
  if (!taskID) return "";
  return JSON.stringify([taskID, control.dataset.action || "select"]);
}

function rememberPageETag(url, etag) {
  pageETags.delete(url);
  pageETags.set(url, etag);
  while (pageETags.size > MAX_PAGE_ETAGS) {
    pageETags.delete(pageETags.keys().next().value);
  }
}

function sortableHeading(field, label) {
  const active = currentSort === field;
  const ariaSort = active ? ` aria-sort="${currentSortOrder === "desc" ? "descending" : "ascending"}"` : "";
  const order = active ? currentSortOrder : "none";
  const icon = order === "asc" ? "arrow-up" : order === "desc" ? "arrow-down" : "arrow-up-down";
  return `<th scope="col"${ariaSort}><button class="sort-button" type="button" data-sort-field="${field}" data-sort-order="${order}" aria-label="按${label}${active && currentSortOrder === "asc" ? "降序" : "升序"}排列">${label}<span class="sort-indicator" aria-hidden="true">${iconMarkup(icon)}</span></button></th>`;
}

function onTaskSort(event) {
  const button = event.target.closest("button[data-sort-field]");
  if (!button) return;
  const field = button.dataset.sortField;
  if (!["id", "file", "status", "link", "progress"].includes(field)) return;
  if (currentSort === field) {
    currentSortOrder = currentSortOrder === "asc" ? "desc" : "asc";
  } else {
    currentSort = field;
    currentSortOrder = "asc";
  }
  currentOffset = 0;
  lastTaskRenderSignature = "";
  refreshAndSchedule(true);
}

function taskRow(task, index) {
  const status = statusMeta[task.status] ? task.status : "queued";
  const statusLabel = statusMeta[status].label;
  const progress = task.error ? `! ${formatTaskError(task)}` : task.progress || "-";
  const fileName = task.outputName || task.name || `任务 #${task.id}`;
  const actions = [];
  actions.push(actionButton("open-folder", task.id, "打开下载目录", false, "folder-open"));
  if (status === "done") actions.push(actionButton("open-file", task.id, "打开文件", false, "file"));
  if (status === "error") actions.push(actionButton("requeue", task.id, "重试", false, "retry"));
  if (status === "queued" || status === "downloading") actions.push(actionButton("pause", task.id, "暂停", false, "pause"));
  if (status === "paused") actions.push(actionButton("resume", task.id, "继续", false, "play"));
  actions.push(actionButton("remove", task.id, "移除", true, "trash"));
  return `
    <tr data-task-id="${task.id}">
      <td class="select-cell"><input type="checkbox" data-select-task value="${task.id}" aria-label="选择任务 ${esc(fileName)}"${selectedTaskIDs.has(task.id) ? " checked" : ""}></td>
      <td class="task-index">${currentOffset + index + 1}</td>
      <td><div class="task-file-cell">${iconMarkup(taskCategoryMeta(task.category).icon)}<div><button class="task-name task-name-button" type="button" data-action="details" data-id="${task.id}" title="${esc(fileName)}">${esc(fileName)}</button><div class="task-folder">${esc(taskCategoryMeta(task.category).label)}</div></div></div></td>
      <td><span class="status-badge status-${status}">${statusLabel}</span></td>
      <td><div class="progress-line" title="${esc(progress)}">${esc(taskProgressLabel(task))}</div><progress class="task-progress" max="100" value="${taskProgressPercent(task)}" aria-label="下载进度"></progress></td>
      <td class="task-size">${taskBytes(task.totalLength)}</td>
      <td><div class="task-speed">${taskSpeed(task)}</div><div class="task-remaining task-folder">${taskRemaining(task)}</div></td>
      <td class="task-created">${esc(taskDate(task.createdAt))}</td>
      <td><div class="row-actions">${actions.join("")}</div></td>
    </tr>`;
}

function requiresCleanHTTPRestart(message) {
  return String(message || "").toLowerCase().includes("the requested byte range is no longer satisfiable");
}

function formatTaskError(task) {
  if (!requiresCleanHTTPRestart(task.error)) return task.error;
  const link = String(task.link || "");
  if (/^https?:/i.test(link) && isBitTorrentLink(link)) {
    return "HTTP 416：获取 .torrent 元数据时的旧续传位置已失效，BT 连接尚未开始。";
  }
  return "HTTP 416：旧续传位置与当前远端文件不一致。";
}

function actionButton(action, id, label, danger = false, icon = "file") {
  const busy = activeTaskActions.has(id) ? ' disabled aria-busy="true" aria-disabled="true"' : "";
  return `<button class="text-button icon-only${danger ? " text-button-danger" : ""}" type="button" data-action="${action}" data-id="${id}" aria-label="${label}" title="${label}"${busy}>${iconMarkup(icon)}</button>`;
}

function iconMarkup(name) {
  return `<svg class="icon" aria-hidden="true" focusable="false"><use href="/icons.svg#icon-${name}"></use></svg>`;
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
  els.retryAllBtn.disabled = summary.error === 0 || els.retryAllBtn.getAttribute("aria-busy") === "true";
  els.clearDoneBtn.disabled = summary.done === 0;
  els.pauseQueueBtn.disabled = summary.queued + summary.downloading === 0 || els.pauseQueueBtn.getAttribute("aria-busy") === "true";
  els.resumeQueueBtn.disabled = summary.paused === 0 || els.resumeQueueBtn.getAttribute("aria-busy") === "true";
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
  const searched = Boolean(currentSearch);
  const title = searched ? "没有匹配的任务" : filtered ? "此筛选下暂无任务" : "暂无任务";
  const detail = searched ? "请尝试其他文件名或链接关键词。" : filtered ? "请选择其他状态筛选。" : "选择「新建下载」，添加链接或导入 Torrent 文件。";
  return `<div class="empty-state"><div class="empty-icon" aria-hidden="true"><svg class="icon" focusable="false"><use href="/icons.svg#icon-downloads"></use></svg></div><h2>${title}</h2><p>${detail}</p></div>`;
}

function buildBitTorrentStartBody(link, sharedBody) {
  return {
    link,
    headers: sharedBody.headers,
    downloadPage: sharedBody.downloadPage,
    folder: sharedBody.folder,
    opts: sharedBody.opts,
  };
}

function isBitTorrentLink(link) {
  try {
    const parsed = new URL(link);
    return parsed.protocol === "magnet:" || parsed.pathname.toLowerCase().endsWith(".torrent");
  } catch {
    return false;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error("无法读取 .torrent 文件"));
        return;
      }
      resolve(result.slice(separator + 1));
    }, { once: true });
    reader.addEventListener("error", () => reject(new Error("无法读取 .torrent 文件")), { once: true });
    reader.readAsDataURL(file);
  });
}

function settingsSpeedBps() {
  return Math.round(downloadSettings.speed * downloadSettings.speedUnit);
}

function settingsExtraArgs() {
  const args = [];
  if (downloadSettings.proxyMode === "custom" && downloadSettings.proxy) args.push(`--all-proxy=${downloadSettings.proxy}`);
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
  els.modalMsg.setAttribute("role", isError ? "alert" : "status");
  els.modalMsg.setAttribute("aria-live", isError ? "assertive" : "polite");
  els.modalMsg.setAttribute("aria-atomic", "true");
  els.modalMsg.textContent = text;
  els.modalMsg.classList.toggle("err", isError);
}

function showToast(text, type = "success") {
  trueDownToast?.show(text, type);
}

async function exitTrueDown(event) {
	const button = event?.currentTarget || els.exitTruedownBtn;
	const confirmed = await confirmAction({
		title: "退出 TrueDown？",
		eyebrow: "Application lifecycle",
		message: typeof nativeDesktopState !== "undefined" && nativeDesktopState?.owned === false
      ? "将关闭桌面界面，已连接的独立下载服务会继续运行。"
      : "TrueDown 将停止当前服务和下载内核。未完成任务会保留，并在下次启动时恢复。",
		confirmLabel: "退出 TrueDown",
		danger: true,
	});
	if (!confirmed) return;
	KDComponents.setBusyState(button, true, { busyLabel: "正在退出…" });
	try {
		await requestJSON("/system/exit", { method: "POST", body: "{}" });
		showToast("TrueDown 正在安全退出。");
	} catch (error) {
		KDComponents.setBusyState(button, false);
		showToast(`退出 TrueDown 失败：${error.message}`, "error");
	}
}

async function waitForEngineTransition() {
  const deadline = Date.now() + 90_000;
  let lastError = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    try {
      const state = normalizeSystemUpdateState(await requestJSON("/system/update"));
      systemUpdateState = state;
      renderSystemUpdateState();
      if (!["engine-switch", "engine-recovery", "engine-reload"].includes(state.busy)) {
        return state;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError?.message || "等待下载内核切换超时");
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
    const isHTTP = (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname;
    const isMagnet = parsed.protocol === "magnet:" && parsed.searchParams.getAll("xt").some((value) => {
      const topic = value.toLowerCase();
      return topic.startsWith("urn:btih:") || topic.startsWith("urn:btmh:");
    });
    if ((!isHTTP && !isMagnet) || parsed.username || parsed.password) {
      throw new Error(`仅支持不含凭据的 HTTP(S) 或 BitTorrent Magnet 链接：${link}`);
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
