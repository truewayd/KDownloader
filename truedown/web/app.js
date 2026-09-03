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
let currentSearch = "";
let currentSort = "status";
let currentSortOrder = "asc";
let loadTasksPromise = null;
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
let settingsReturnFocus = null;
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
  bindEvents();
  try {
    await loadAuthSettings();
  } catch (error) {
    showToast(`读取认证设置失败：${error.message}`, "error");
  }
  try {
    await Promise.all([
      loadServerDownloadRules(),
      loadServerRuntimeSettings(),
      loadTrackerResearchSettings(),
      loadResolverModules(),
      loadSystemUpdateState(),
    ]);
  } catch (error) {
    showToast(`读取服务端设置失败：${error.message}`, "error");
  }
  refreshAndSchedule();
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
    "exit-truedown-btn",
    "m-conns",
    "m-dropbox-filter",
    "m-dropbox-mode",
	"m-dropbox-option",
    "m-extra",
    "m-folder",
    "m-headers",
    "m-link",
    "m-name",
    "m-queueid",
    "m-referer",
	"m-google-drive-option",
	"m-resolver-options",
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
    "settings-cancel-btn",
    "settings-close-btn",
    "settings-form",
    "settings-overlay",
    "settings-reset-btn",
    "submit-task-btn",
    "task-count",
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
  els.settingsBtn.addEventListener("click", openSettingsModal);
  els.settingsCloseBtn.addEventListener("click", closeSettingsModal);
  els.settingsCancelBtn.addEventListener("click", closeSettingsModal);
  els.settingsResetBtn.addEventListener("click", resetDownloadSettings);
  els.settingsForm.addEventListener("submit", saveDownloadSettings);
  els.trackerPretendSeed.addEventListener("change", syncTrackerSeedControls);
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
  els.mDropboxMode.addEventListener("change", updateDropboxOptions);
  els.refreshTasksBtn.addEventListener("click", async () => {
    await loadTasks({ force: true });
    showToast("任务列表已刷新。");
    schedulePoll();
  });
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
  els.checkTruedownUpdateBtn.addEventListener("click", checkTrueDownUpdate);
	els.refreshApplicationLogBtn.addEventListener("click", () => loadApplicationLog(true));
	els.copyApplicationLogBtn.addEventListener("click", copyApplicationLog);
  els.exitTruedownBtn.addEventListener("click", exitTrueDown);
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
    els.settingsOverlay.classList.contains("open") ? els.settingsOverlay :
    els.overlay.classList.contains("open") ? els.overlay : null;
  if (!activeOverlay) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (activeOverlay === els.dialogOverlay) cancelDialog();
    else if (activeOverlay === els.settingsOverlay) closeSettingsModal();
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
	els.mTorrentFile.value = "";
	els.mTorrentFile.disabled = isBatch;
  els.modalEyebrow.textContent = isBatch ? "Batch download" : "New download";
  els.modalTitle.textContent = isBatch ? "批量下载任务" : "新建下载任务";
  els.submitTaskBtn.textContent = isBatch ? "批量开始" : "开始下载";
  els.mLink.rows = isBatch ? 7 : 4;
  els.mLink.placeholder = isBatch
    ? "https://example.com/file-a.zip\nmagnet:?xt=urn:btih:...\nhttps://example.com/file.torrent"
    : "https://example.com/file.zip 或 magnet:?xt=urn:btih:...";
  els.mName.disabled = isBatch;
  els.mName.placeholder = isBatch ? "批量时自动命名" : "普通 HTTP(S) 留空自动命名；BT 使用元信息名称";
  if (isBatch) els.mName.value = "";
  els.mDropboxMode.value = downloadRules.dropboxMode;
  els.mDropboxFilter.checked = downloadRules.enabled;
  updateDropboxOptions();
	renderModuleAvailability();
  els.overlay.classList.add("open");
  els.overlay.setAttribute("aria-hidden", "false");
  els.overlay.removeAttribute("inert");
  document.body.classList.add("modal-open");
  window.setTimeout(() => els.mLink.focus(), 80);
}

function updateDropboxOptions() {
  const expanded = els.mDropboxMode.value === "expand";
  els.mDropboxFilter.disabled = !expanded;
}

function buildModuleOptions() {
	const options = {};
	if (isModuleInstalled("dropbox")) {
		options.dropbox = {
			mode: els.mDropboxMode.value,
			applyFilter: els.mDropboxMode.value === "expand" && els.mDropboxFilter.checked,
		};
	}
	if (isModuleInstalled("google-drive")) options["google-drive"] = {};
	return options;
}

function renderModuleAvailability() {
	const dropboxInstalled = isModuleInstalled("dropbox");
	const googleDriveInstalled = isModuleInstalled("google-drive");
	els.mDropboxOption.hidden = !dropboxInstalled;
	els.mGoogleDriveOption.hidden = !googleDriveInstalled;
	els.mResolverOptions.hidden = !dropboxInstalled && !googleDriveInstalled;
	updateDropboxOptions();
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
  window.setTimeout(() => (dialogHasInput ? els.dialogInput : els.dialogConfirmBtn).focus(), 80);
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
  document.body.classList.remove("modal-open");
  if (dialogReturnFocus instanceof HTMLElement && dialogReturnFocus.isConnected) {
    dialogReturnFocus.focus();
  }
  dialogReturnFocus = null;
  resolve(value);
}

function confirmAction(options) {
  return showDialog(options);
}

async function submitTask(event) {
  event.preventDefault();
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
      await loadTasks({ force: true });
      showModalMsg(result.includes("DUPLICATE") ? "已复用现有 Torrent 任务" : "Torrent 任务已创建");
      els.mTorrentFile.value = "";
      window.setTimeout(closeModal, 700);
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
    showModalMsg(links.length === 1
      ? formatStartOutcome(created[0], duplicateCount > 0)
      : summary);
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
  KDComponents.setBusyState(button, true);
  try {
    if (action === "requeue") {
      const task = currentTasks.find((candidate) => candidate.id === id);
      const cleanRestart = requiresCleanHTTPRestart(task?.error);
      if (cleanRestart && !await confirmAction({
        title: "清除失效残片并重新下载",
        message: "服务器已拒绝旧的续传位置。TrueDown 将删除这个任务的未完成文件和恢复状态，然后从 0 开始；其他文件不会被删除。此操作无法撤销。",
        confirmLabel: "清除并重下",
        danger: true,
      })) return;
      await runTaskAction("requeue", id, cleanRestart ? "已安排清除失效残片，将从 0 重新下载。" : "任务已重新排队。");
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
      selectedTaskIDs.delete(id);
      taskStatusByID.delete(id);
    }
  } finally {
    KDComponents.setBusyState(button, false);
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
  if (!currentSummary.error) {
    showToast("没有需要重试的任务。");
    return;
  }
  if (!await confirmAction({
    title: `重试 ${currentSummary.error} 个失败任务`,
    message: "普通错误会保留断点数据；HTTP 416 续传位置失效的任务会删除其未完成文件和恢复状态，再从 0 开始。",
    confirmLabel: "全部重试",
    danger: currentTasks.some((task) => task.status === "error" && requiresCleanHTTPRestart(task.error)),
  })) return;
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
          sort: currentSort,
          order: currentSortOrder,
        });
        if (currentSearch) params.set("search", currentSearch);
        const url = `/tasks?${params}`;
        const headers = {};
        if (!force && pageETags.has(url)) headers["If-None-Match"] = pageETags.get(url);
        const response = await apiFetch(url, { headers });
        if (response.status === 304) return;
        if (!response.ok) throw new Error(await response.text());
        const page = await response.json();
        if (!page || !Array.isArray(page.tasks) || !page.summary) throw new Error("任务列表响应无效");
        const etag = response.headers.get("ETag");
        if (etag) rememberPageETag(url, etag);
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
  for (const id of taskStatusByID.keys()) {
    if (!selectedTaskIDs.has(id)) taskStatusByID.delete(id);
  }
  tasks.forEach((task) => taskStatusByID.set(task.id, task.status));
  currentTasks = [...tasks];
  const signature = JSON.stringify([
    currentOffset,
    currentFilter,
    currentSearch,
    currentSort,
    currentSortOrder,
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
        ${sortableHeading("id", "#")}${sortableHeading("file", "文件")}${sortableHeading("status", "状态")}${sortableHeading("link", "链接")}
        ${sortableHeading("progress", "进度 / 日志")}<th scope="col" class="align-right">操作</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  syncSelectionControls();
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
  return `<th scope="col"${ariaSort}><button class="sort-button" type="button" data-sort-field="${field}" data-sort-order="${order}" aria-label="按${label}${active && currentSortOrder === "asc" ? "降序" : "升序"}排列">${label}<span class="sort-indicator" aria-hidden="true"></span></button></th>`;
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
  const cleanRestart = requiresCleanHTTPRestart(task.error);
  const progress = task.error ? `! ${formatTaskError(task)}` : task.progress || "-";
  const fileName = task.outputName || task.name || `任务 #${task.id}`;
  const actions = [];
  actions.push(actionButton("open-folder", task.id, "打开下载目录", false, "folder-open"));
  if (status === "done") actions.push(actionButton("open-file", task.id, "打开文件", false, "file"));
  if (status === "error") actions.push(actionButton("requeue", task.id, cleanRestart ? "清除残片并重下" : "重试", cleanRestart, "retry"));
  if (status === "queued" || status === "downloading") actions.push(actionButton("pause", task.id, "暂停", false, "pause"));
  if (status === "paused") actions.push(actionButton("resume", task.id, "继续", false, "play"));
  actions.push(actionButton("remove", task.id, "移除", true, "trash"));
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

function requiresCleanHTTPRestart(message) {
  return String(message || "").toLowerCase().includes("the requested byte range is no longer satisfiable");
}

function formatTaskError(task) {
  if (!requiresCleanHTTPRestart(task.error)) return task.error;
  const link = String(task.link || "");
  if (/^https?:/i.test(link) && isBitTorrentLink(link)) {
    return "HTTP 416：获取 .torrent 元数据时的旧续传位置已失效，BT 连接尚未开始。请使用“清除残片并重下”。";
  }
  return "HTTP 416：旧续传位置与当前远端文件不一致。请使用“清除残片并重下”，TrueDown 会删除该任务的临时数据并从 0 开始。";
}

function actionButton(action, id, label, danger = false, icon = "file") {
  return `<button class="text-button icon-only${danger ? " text-button-danger" : ""}" type="button" data-action="${action}" data-id="${id}" aria-label="${label}" title="${label}">${iconMarkup(icon)}</button>`;
}

function iconMarkup(name) {
  return `<svg class="icon" aria-hidden="true"><use href="/icons.svg#icon-${name}"></use></svg>`;
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
  els.pauseQueueBtn.disabled = summary.queued + summary.downloading === 0;
  els.resumeQueueBtn.disabled = summary.paused === 0;
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
  const detail = searched ? "请尝试其他文件名或链接关键词。" : filtered ? "请选择其他状态筛选。" : "点击右上角「新建下载」开始添加链接。";
  return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">↓</div><h2>${title}</h2><p>${detail}</p></div>`;
}

async function openSettingsModal() {
  settingsReturnFocus = document.activeElement;
  try {
    await Promise.all([
      loadServerDownloadRules(),
      loadServerRuntimeSettings(),
      loadTrackerResearchSettings(),
      loadResolverModules(),
      loadSystemUpdateState(),
		loadApplicationLog(),
    ]);
  } catch (error) {
    showToast(`刷新服务端设置失败：${error.message}`, "error");
  }
  renderDownloadSettings();
	renderResolverModules();
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

function renderDownloadSettings(settings = downloadSettings, rules = downloadRules, runtime = runtimeSettings) {
  const globalSpeed = displaySpeed(runtime.globalDownloadLimitBps);
  els.cfgFolder.value = settings.folder;
  els.cfgConns.value = settings.connections;
  els.cfgTaskConcurrency.value = runtime.concurrentDownloads;
  els.cfgGlobalSpeed.value = globalSpeed.value || "";
  els.cfgGlobalSpeedUnit.value = String(globalSpeed.unit);
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
  els.cfgDropboxMode.value = rules.dropboxMode;
  els.cfgFilterEnabled.checked = rules.enabled;
  const selected = new Set(rules.excludedExtensions);
  document.querySelectorAll("[data-download-extension]").forEach((input) => {
    input.checked = selected.has(input.value);
  });
  els.cfgExtra.value = settings.extra;
  renderTrackerResearchSettings();
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

function renderTrackerResearchSettings(settings = trackerResearchSettings) {
  els.trackerResearchEnabled.checked = settings.enabled;
  els.trackerMinimumLeechers.value = settings.minimumLeechers;
  els.trackerDownloadMultiplierMin.value = settings.downloadMultiplierMin;
  els.trackerDownloadMultiplierMax.value = settings.downloadMultiplierMax;
  els.trackerUploadMultiplierMin.value = settings.uploadMultiplierMin;
  els.trackerUploadMultiplierMax.value = settings.uploadMultiplierMax;
  els.trackerBonusKibPerSecond.value = settings.bonusKiBPerSecond;
  els.trackerBonusChancePercent.value = settings.bonusChancePercent;
  els.trackerReportDownloadZero.checked = settings.reportDownloadAsZero;
  els.trackerPretendSeed.checked = settings.pretendToSeed;
  els.trackerOnlyTraffic.checked = true;
  els.trackerLocalOnly.checked = true;
  syncTrackerSeedControls();
  const engineLabel = settings.engine === "next"
    ? `Aria2 Next${settings.engineVersion ? ` v${settings.engineVersion}` : ""}`
    : "内置稳定版 aria2";
  els.btClientIdentity.textContent = bitTorrentIdentityDescription(settings);
  let support = "尚未检测 Aria2 Next RPC";
  if (settings.supportKnown && settings.supported) {
    support = `${engineLabel} 的 ${settings.requiredRPC} RPC 已就绪`;
  } else if (settings.supportKnown && settings.engine === "next") {
    support = `${engineLabel} 缺少 ${settings.requiredRPC}；官方 NEXT 至少需要 v${settings.minimumNextVersion}，请手动更新 NEXT`;
  } else if (settings.supportKnown) {
    support = `研究模块需要 Aria2 Next v${settings.minimumNextVersion} 或更高版本及 ${settings.requiredRPC}；请安装并选择 NEXT`;
  }
  const enableBlocked = !settings.enabled && settings.supportKnown && !settings.supported;
  els.trackerResearchEnabled.disabled = enableBlocked;
  els.trackerResearchEnabled.title = enableBlocked ? support : "";
  const activity = settings.active
    ? `relay 已运行；已配置 ${settings.configuredTorrents} 个任务、改写 ${settings.rewrittenTrackers} 个 HTTP(S) tracker、转发 ${settings.forwardedAnnounces} 次请求`
    : (settings.enabled ? "已保存启用状态，但 relay 尚未运行" : "模块已关闭");
  els.trackerResearchStatus.textContent = settings.lastError
    ? `${support}；${activity}；错误：${settings.lastError}`
    : `${support}；${activity}`;
  els.trackerResearchStatus.dataset.error = String(Boolean(settings.lastError) || (settings.supportKnown && !settings.supported));
}

function bitTorrentIdentityDescription(settings) {
  if (settings.engine !== "next") {
    return "当前内置稳定版 aria2 不开放 TrueDown 的 BitTorrent 创建接口；选择 Aria2 Next 后会自动切换并启用 BT。";
  }
  const version = settings.engineVersion || "当前版本";
  const libraryVersion = KNOWN_NEXT_LIBTORRENT_VERSIONS[settings.engineVersion];
  const libraryIdentity = libraryVersion ? `libtorrent/${libraryVersion}` : "libtorrent/<官方构建版本>";
  const fingerprint = aria2NextPeerFingerprint(settings.engineVersion);
  const fingerprintText = fingerprint ? `，peer_id 前缀 ${fingerprint}` : "，peer_id 使用 A2 版本指纹";
  return `当前 tracker/扩展握手身份由官方内核固定为 aria2-next/${version} ${libraryIdentity}${fingerprintText}；普通 HTTP User-Agent 设置不会覆盖它。`;
}

function aria2NextPeerFingerprint(version) {
  const parts = String(version || "").split(".").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 35)) return "";
  const encode = (part) => part < 10 ? String(part) : String.fromCharCode("A".charCodeAt(0) + part - 10);
  return `-A2${parts.map(encode).join("")}0-`;
}

function syncTrackerSeedControls() {
  if (els.trackerPretendSeed.checked) els.trackerReportDownloadZero.checked = true;
  els.trackerReportDownloadZero.disabled = els.trackerPretendSeed.checked;
}

async function saveDownloadSettings(event) {
  event.preventDefault();
  try {
    parseHeaders(els.cfgHeaders.value);
    const speed = Number(els.cfgSpeed.value || 0);
    const speedUnit = Number(els.cfgSpeedUnit.value);
    const speedBps = Math.round(speed * speedUnit);
    if (!Number.isFinite(speed) || speed < 0 || !Number.isSafeInteger(speedBps) || speedBps > MAX_SPEED_BPS) {
      throw new Error("限速数值过大");
    }
    const globalSpeed = Number(els.cfgGlobalSpeed.value || 0);
    const globalSpeedUnit = Number(els.cfgGlobalSpeedUnit.value);
    const globalDownloadLimitBps = Math.round(globalSpeed * globalSpeedUnit);
    if (!Number.isFinite(globalSpeed) || globalSpeed < 0 || !Number.isSafeInteger(globalDownloadLimitBps) ||
        globalDownloadLimitBps > MAX_SPEED_BPS) {
      throw new Error("全局限速数值过大");
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
    const nextRules = {
      enabled: els.cfgFilterEnabled.checked,
      dropboxMode: els.cfgDropboxMode.value,
      excludedExtensions: Array.from(
        document.querySelectorAll("[data-download-extension]:checked"),
        (input) => input.value,
      ),
    };
    const nextRuntimeSettings = {
      concurrentDownloads: optionalInt("cfgTaskConcurrency") || DEFAULT_RUNTIME_SETTINGS.concurrentDownloads,
      globalDownloadLimitBps,
    };
    const nextTrackerResearchSettings = readTrackerResearchForm();
    let acknowledgedRisk = false;
    if (nextTrackerResearchSettings.enabled && !trackerResearchSettings.enabled) {
      acknowledgedRisk = await confirmAction({
        eyebrow: "Research only",
        title: "确认启用 Tracker 流量研究",
        message: "此功能仅限在你控制的 tracker 或测试环境中研究流量，不得用于欺骗、滥用或违反服务条款。继续即表示你理解并自行承担全部后果。",
        confirmLabel: "我理解，启用研究模块",
        danger: true,
      });
      if (!acknowledgedRisk) return;
    }
    const [savedRules, savedRuntimeSettings, savedTrackerResearchSettings] = await Promise.all([
      requestJSON("/settings/download-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextRules),
      }),
      requestJSON("/settings/runtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextRuntimeSettings),
      }),
      requestJSON("/settings/tracker-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...nextTrackerResearchSettings, acknowledgedRisk }),
      }),
    ]);
    localStorage.setItem(DOWNLOAD_DEFAULTS_KEY, JSON.stringify(nextSettings));
    downloadSettings = nextSettings;
    downloadRules = normalizeServerDownloadRules(savedRules);
    runtimeSettings = normalizeServerRuntimeSettings(savedRuntimeSettings);
    trackerResearchSettings = normalizeTrackerResearchSettings(savedTrackerResearchSettings);
    closeSettingsModal();
    showToast("下载器默认设置已保存。");
  } catch (error) {
    showToast(`设置未保存：${error.message}`, "error");
  }
}

function resetDownloadSettings() {
  const defaultRules = {
    enabled: DEFAULT_DOWNLOAD_RULES.enabled,
    excludedExtensions: [...DEFAULT_DOWNLOAD_RULES.excludedExtensions],
    dropboxMode: DEFAULT_DOWNLOAD_RULES.dropboxMode,
  };
  renderDownloadSettings(DEFAULT_DOWNLOAD_SETTINGS, defaultRules, DEFAULT_RUNTIME_SETTINGS);
  renderTrackerResearchSettings({
    ...DEFAULT_TRACKER_RESEARCH_SETTINGS,
    engine: trackerResearchSettings.engine,
    engineVersion: trackerResearchSettings.engineVersion,
    requiredRPC: trackerResearchSettings.requiredRPC,
    minimumNextVersion: trackerResearchSettings.minimumNextVersion,
    supportKnown: trackerResearchSettings.supportKnown,
    supported: trackerResearchSettings.supported,
    lastError: trackerResearchSettings.lastError,
  });
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

function normalizeExcludedExtensions(value, fallback) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/);
  const result = [];
  const seen = new Set();
  for (const item of items) {
    let extension = String(item || "").trim().toLowerCase();
    if (!extension) continue;
    if (!extension.startsWith(".")) extension = `.${extension}`;
    if (!/^\.[a-z0-9]{1,16}$/.test(extension)) {
      if (fallback) return [...fallback];
      throw new Error(`无效的排除后缀：${item}`);
    }
    if (!seen.has(extension)) {
      seen.add(extension);
      result.push(extension);
    }
  }
  if (result.length > 64) {
    if (fallback) return [...fallback];
    throw new Error("排除后缀不能超过 64 项");
  }
  return result;
}

function normalizeServerDownloadRules(value) {
  const rules = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: rules.enabled === true,
    excludedExtensions: normalizeExcludedExtensions(rules.excludedExtensions, DEFAULT_EXCLUDED_EXTENSIONS),
    dropboxMode: rules.dropboxMode === "expand" ? "expand" : "direct",
  };
}

async function loadServerDownloadRules() {
  downloadRules = normalizeServerDownloadRules(await requestJSON("/settings/download-rules"));
}

function normalizeServerRuntimeSettings(value) {
  const settings = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    concurrentDownloads: boundedInt(
      settings.concurrentDownloads,
      1,
      64,
      DEFAULT_RUNTIME_SETTINGS.concurrentDownloads,
    ),
    globalDownloadLimitBps: boundedInt(
      settings.globalDownloadLimitBps,
      0,
      MAX_SPEED_BPS,
      DEFAULT_RUNTIME_SETTINGS.globalDownloadLimitBps,
    ),
  };
}

function displaySpeed(speedBps) {
  const value = boundedInt(speedBps, 0, MAX_SPEED_BPS, 0);
  let unit = 1048576;
  if (value >= 1073741824) unit = 1073741824;
  else if (value > 0 && value < 1048576) unit = 1024;
  return { value: value / unit, unit };
}

async function loadServerRuntimeSettings() {
  runtimeSettings = normalizeServerRuntimeSettings(await requestJSON("/settings/runtime"));
}

function normalizeTrackerResearchSettings(value) {
  const settings = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const boundedFloat = (candidate, min, max, fallback) => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  return {
    enabled: settings.enabled === true,
    minimumLeechers: boundedInt(settings.minimumLeechers, 0, 1000000, DEFAULT_TRACKER_RESEARCH_SETTINGS.minimumLeechers),
    downloadMultiplierMin: boundedFloat(settings.downloadMultiplierMin, 0, 1000, DEFAULT_TRACKER_RESEARCH_SETTINGS.downloadMultiplierMin),
    downloadMultiplierMax: boundedFloat(settings.downloadMultiplierMax, 0, 1000, DEFAULT_TRACKER_RESEARCH_SETTINGS.downloadMultiplierMax),
    uploadMultiplierMin: boundedFloat(settings.uploadMultiplierMin, 0, 1000, DEFAULT_TRACKER_RESEARCH_SETTINGS.uploadMultiplierMin),
    uploadMultiplierMax: boundedFloat(settings.uploadMultiplierMax, 0, 1000, DEFAULT_TRACKER_RESEARCH_SETTINGS.uploadMultiplierMax),
    bonusKiBPerSecond: boundedFloat(settings.bonusKiBPerSecond, 0, 1000000, DEFAULT_TRACKER_RESEARCH_SETTINGS.bonusKiBPerSecond),
    bonusChancePercent: boundedFloat(settings.bonusChancePercent, 0, 100, DEFAULT_TRACKER_RESEARCH_SETTINGS.bonusChancePercent),
    reportDownloadAsZero: settings.reportDownloadAsZero === true,
    pretendToSeed: settings.pretendToSeed === true,
    onlyTrackerTraffic: true,
    onlyLocalConnections: true,
    engine: settings.engine === "next" ? "next" : "stable",
    engineVersion: stringValue(settings.engineVersion),
    requiredRPC: stringValue(settings.requiredRPC) || DEFAULT_TRACKER_RESEARCH_SETTINGS.requiredRPC,
    minimumNextVersion: stringValue(settings.minimumNextVersion) || DEFAULT_TRACKER_RESEARCH_SETTINGS.minimumNextVersion,
    supportKnown: settings.supportKnown === true,
    supported: settings.supported === true,
    active: settings.active === true,
    configuredTorrents: boundedInt(settings.configuredTorrents, 0, Number.MAX_SAFE_INTEGER, 0),
    rewrittenTrackers: boundedInt(settings.rewrittenTrackers, 0, Number.MAX_SAFE_INTEGER, 0),
    forwardedAnnounces: boundedInt(settings.forwardedAnnounces, 0, Number.MAX_SAFE_INTEGER, 0),
    lastError: stringValue(settings.lastError),
  };
}

function readTrackerResearchForm() {
  const readNumber = (element, label) => {
    const value = Number(element.value);
    if (!Number.isFinite(value)) throw new Error(`${label}不是有效数值`);
    return value;
  };
  const settings = {
    enabled: els.trackerResearchEnabled.checked,
    minimumLeechers: optionalIntAllowZero("trackerMinimumLeechers", DEFAULT_TRACKER_RESEARCH_SETTINGS.minimumLeechers),
    downloadMultiplierMin: readNumber(els.trackerDownloadMultiplierMin, "下载倍率下限"),
    downloadMultiplierMax: readNumber(els.trackerDownloadMultiplierMax, "下载倍率上限"),
    uploadMultiplierMin: readNumber(els.trackerUploadMultiplierMin, "上传倍率下限"),
    uploadMultiplierMax: readNumber(els.trackerUploadMultiplierMax, "上传倍率上限"),
    bonusKiBPerSecond: readNumber(els.trackerBonusKibPerSecond, "随机增量上限"),
    bonusChancePercent: readNumber(els.trackerBonusChancePercent, "随机增量概率"),
    reportDownloadAsZero: els.trackerReportDownloadZero.checked,
    pretendToSeed: els.trackerPretendSeed.checked,
    onlyTrackerTraffic: true,
    onlyLocalConnections: true,
  };
  if (settings.downloadMultiplierMin > settings.downloadMultiplierMax) throw new Error("下载倍率下限不能大于上限");
  if (settings.uploadMultiplierMin > settings.uploadMultiplierMax) throw new Error("上传倍率下限不能大于上限");
  return settings;
}

async function loadTrackerResearchSettings() {
  trackerResearchSettings = normalizeTrackerResearchSettings(await requestJSON("/settings/tracker-research"));
  renderTrackerResearchSettings();
}

function normalizeResolverModules(value) {
	const modules = Array.isArray(value?.modules) ? value.modules : [];
	return modules.slice(0, 32).map(normalizeResolverModule).filter(Boolean);
}

function normalizeResolverModule(module) {
	if (!module || typeof module !== "object") return null;
	const normalized = {
		id: stringValue(module.id),
		name: stringValue(module.name),
		version: stringValue(module.version),
		baselineVersion: stringValue(module.baselineVersion),
		releasedAt: stringValue(module.releasedAt),
		description: stringValue(module.description),
		capabilities: Array.isArray(module.capabilities)
			? module.capabilities.slice(0, 16).map(stringValue).filter(Boolean) : [],
		builtIn: module.builtIn === true,
		installed: module.installed === true,
		source: module.source === "updated" ? "updated" : "baseline",
		digest: stringValue(module.digest),
		hotReload: module.hotReload === true,
		updateError: stringValue(module.updateError),
	};
	return normalized.id && normalized.name ? normalized : null;
}

async function loadResolverModules() {
	resolverModules = normalizeResolverModules(await requestJSON("/modules"));
	renderResolverModules();
	renderModuleAvailability();
}

function isModuleInstalled(id) {
	return resolverModules.some((module) => module.id === id && module.installed);
}

function renderResolverModules() {
	if (!els.moduleList) return;
	els.moduleList.replaceChildren();
	if (!resolverModules.length) {
		const empty = document.createElement("p");
		empty.className = "hint";
		empty.textContent = "没有可用的解析模块。";
		els.moduleList.append(empty);
		return;
	}
	for (const module of resolverModules) {
		const card = document.createElement("article");
		card.className = "module-card";
		const copy = document.createElement("div");
		copy.className = "module-card-copy";
		const heading = document.createElement("div");
		heading.className = "module-card-heading";
		const name = document.createElement("strong");
		name.textContent = module.name;
		const version = document.createElement("span");
		version.textContent = `v${module.version} · ${module.source === "updated" ? "独立更新" : "内置基线"}`;
		heading.append(name, version);
		const description = document.createElement("p");
		description.textContent = module.description;
		const capabilities = document.createElement("small");
		capabilities.textContent = module.capabilities.join(" · ");
		const lifecycle = document.createElement("small");
		const baseline = module.baselineVersion ? `内置 v${module.baselineVersion}` : "内置基线";
		const released = module.releasedAt ? ` · 发布于 ${module.releasedAt}` : "";
		const digest = module.digest ? ` · SHA-256 ${module.digest.slice(0, 12)}…` : "";
		lifecycle.textContent = `${baseline}${released}${module.hotReload ? " · 支持热重载" : ""}${digest}`;
		if (module.digest) lifecycle.title = `SHA-256: ${module.digest}`;
		copy.append(heading, description, capabilities, lifecycle);
		if (module.updateError) {
			const error = document.createElement("p");
			error.className = "module-card-error";
			error.textContent = `更新包未启用：${module.updateError}`;
			copy.append(error);
		}
		const actions = document.createElement("div");
		actions.className = "module-card-actions";
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.className = `kd-button ${module.installed ? "secondary" : "primary"} compact`;
		toggle.dataset.moduleToggle = module.id;
		toggle.dataset.installed = String(module.installed);
		toggle.setAttribute("aria-pressed", String(module.installed));
		toggle.setAttribute("aria-label", `${module.installed ? "停用" : "启用"} ${module.name} 解析模块`);
		toggle.textContent = module.installed ? "停用" : "启用";
		const update = document.createElement("button");
		update.type = "button";
		update.className = "kd-button secondary compact";
		update.dataset.moduleUpdate = module.id;
		update.setAttribute("aria-label", `导入 ${module.name} 组件更新包`);
		update.textContent = "导入更新";
		actions.append(toggle, update);
		if (module.source === "updated" || module.updateError) {
			const reset = document.createElement("button");
			reset.type = "button";
			reset.className = "kd-button secondary compact";
			reset.dataset.moduleReset = module.id;
			reset.setAttribute("aria-label", `将 ${module.name} 恢复到内置基线`);
			reset.textContent = "恢复基线";
			actions.append(reset);
		}
		card.append(copy, actions);
		els.moduleList.append(card);
	}
}

async function onModuleAction(event) {
	const button = event.target.closest("button[data-module-toggle], button[data-module-update], button[data-module-reset]");
	if (!button) return;
	if (button.dataset.moduleUpdate) {
		await importModuleUpdate(button.dataset.moduleUpdate, button);
		return;
	}
	if (button.dataset.moduleReset) {
		await resetModuleUpdate(button.dataset.moduleReset, button);
		return;
	}
	const id = button.dataset.moduleToggle;
	const installed = button.dataset.installed !== "true";
	KDComponents.setBusyState(button, true);
	try {
		const saved = await requestJSON("/modules", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, installed }),
		});
		resolverModules = resolverModules.map((module) => module.id === id
			? { ...module, installed: saved.installed === true } : module);
		renderResolverModules();
		renderModuleAvailability();
		showToast(`${stringValue(saved.name) || id} 模块已${installed ? "启用" : "停用"}。`);
	} catch (error) {
		showToast(`模块状态更新失败：${error.message}`, "error");
		KDComponents.setBusyState(button, false);
	}
}

async function importModuleUpdate(id, button) {
	const file = await chooseModulePackageFile();
	if (!file) return;
	if (file.size <= 0 || file.size > 64 * 1024) {
		showToast("组件更新包必须小于 64 KiB。", "error");
		return;
	}
	KDComponents.setBusyState(button, true);
	try {
		const parsed = JSON.parse(await file.text());
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.id !== id) {
			throw new Error(`更新包 ID 必须是 ${id}`);
		}
		const saved = await requestJSON("/modules/package", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ package: parsed }),
		});
		replaceResolverModule(saved);
		renderResolverModules();
		renderModuleAvailability();
		showToast(`${stringValue(saved.name) || id} v${stringValue(saved.version)} 已热重载。`);
	} catch (error) {
		showToast(`组件更新失败：${error.message}`, "error");
	} finally {
		if (button.isConnected) {
			KDComponents.setBusyState(button, false);
		}
	}
}

function chooseModulePackageFile() {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json,.tdmodule.json,application/json";
		const finish = (file) => {
			input.removeEventListener("change", onChange);
			input.removeEventListener("cancel", onCancel);
			resolve(file);
		};
		const onChange = () => finish(input.files?.[0] || null);
		const onCancel = () => finish(null);
		input.addEventListener("change", onChange, { once: true });
		input.addEventListener("cancel", onCancel, { once: true });
		input.click();
	});
}

async function resetModuleUpdate(id, button) {
	const module = resolverModules.find((candidate) => candidate.id === id);
	const confirmed = await confirmAction({
		title: "恢复内置组件基线",
		message: `将删除 ${module?.name || id} 的独立更新包，并立即切换回内置基线。已有下载记录不会被删除。`,
		confirmLabel: "恢复基线",
		danger: true,
	});
	if (!confirmed) return;
	KDComponents.setBusyState(button, true);
	try {
		const saved = await requestJSON(`/modules/package?id=${encodeURIComponent(id)}`, { method: "DELETE" });
		replaceResolverModule(saved);
		renderResolverModules();
		renderModuleAvailability();
		showToast(`${stringValue(saved.name) || id} 已恢复到内置基线。`);
	} catch (error) {
		showToast(`恢复组件基线失败：${error.message}`, "error");
	} finally {
		if (button.isConnected) {
			KDComponents.setBusyState(button, false);
		}
	}
}

function replaceResolverModule(value) {
	const normalized = normalizeResolverModule(value);
	if (!normalized) return;
	resolverModules = resolverModules.map((module) => module.id === normalized.id ? normalized : module);
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

async function loadSystemUpdateState() {
  systemUpdateState = normalizeSystemUpdateState(await requestJSON("/system/update"));
  renderSystemUpdateState();
}

function normalizeSystemUpdateState(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const trueDown = source.trueDown && typeof source.trueDown === "object" ? source.trueDown : {};
  const engine = source.engine && typeof source.engine === "object" ? source.engine : {};
  return {
    busy: stringValue(source.busy),
    error: stringValue(source.error),
    trueDown: {
      version: stringValue(trueDown.version) || "unknown",
      build: boundedInt(trueDown.build, 0, Number.MAX_SAFE_INTEGER, 0),
      supported: trueDown.supported === true,
      autoUpdate: trueDown.autoUpdate === true,
      updateAvailable: trueDown.updateAvailable === true,
      availableVersion: stringValue(trueDown.availableVersion),
      pendingVersion: stringValue(trueDown.pendingVersion),
      pendingBuild: boundedInt(trueDown.pendingBuild, 0, Number.MAX_SAFE_INTEGER, 0),
      restartRequired: trueDown.restartRequired === true,
      lastCheckedAt: stringValue(trueDown.lastCheckedAt),
    },
    engine: {
      preference: engine.preference === "next" ? "next" : "stable",
      active: engine.active === "next" ? "next" : "stable",
      activeVersion: stringValue(engine.activeVersion),
      stableVersion: stringValue(engine.stableVersion),
      nextInstalled: engine.nextInstalled === true,
      nextInstalledVersion: stringValue(engine.nextInstalledVersion),
      nextAvailableVersion: stringValue(engine.nextAvailableVersion),
      restartRequired: engine.restartRequired === true,
    },
  };
}

function renderSystemUpdateState() {
  if (!systemUpdateState) return;
  const { trueDown, engine, busy, error } = systemUpdateState;
  els.truedownUpdateVersion.textContent = trueDown.build > 0
    ? `${trueDown.version} · build ${trueDown.build}` : `${trueDown.version} · 开发构建`;
  let trueDownStatus = trueDown.supported
    ? "当前已是最新发布版本。"
    : "当前构建未包含发布编号，不能使用自动更新。";
  if (trueDown.restartRequired) {
    trueDownStatus = `已验证并暂存 ${trueDown.pendingVersion || `build ${trueDown.pendingBuild}`}，等待任务空闲后重启更新。`;
  } else if (trueDown.updateAvailable) {
    trueDownStatus = `发现 ${trueDown.availableVersion || "新版本"}。`;
  } else if (trueDown.lastCheckedAt) {
    trueDownStatus += ` 上次检查：${formatUpdateTime(trueDown.lastCheckedAt)}。`;
  }
  if (busy === "truedown") trueDownStatus = "正在检查、下载并验证 TrueDown 更新…";
  if (error) trueDownStatus += ` 最近一次更新操作：${error}`;
  els.truedownUpdateStatus.textContent = trueDownStatus;
  els.autoUpdateTruedown.checked = trueDown.autoUpdate;
  els.autoUpdateTruedown.disabled = !trueDown.supported || Boolean(busy);
  els.checkTruedownUpdateBtn.disabled = !trueDown.supported || Boolean(busy);
  KDComponents.setBusyState(els.checkTruedownUpdateBtn, busy === "truedown", { manageDisabled: false });
  els.restartTruedownUpdateBtn.hidden = !trueDown.restartRequired;
  els.restartTruedownUpdateBtn.disabled = Boolean(busy);

  const activeLabel = engine.active === "next" ? "Aria2 Next" : "内置稳定版 aria2";
  els.engineVersion.textContent = `${activeLabel}${engine.activeVersion ? ` v${engine.activeVersion}` : ""}`;
  let engineStatus = engine.active === "next"
    ? `当前使用 NEXT v${engine.activeVersion || engine.nextInstalledVersion || "unknown"}。`
    : `当前使用随包提供的稳定内核${engine.stableVersion ? ` v${engine.stableVersion}` : ""}。`;
  if (engine.restartRequired) {
    const selected = engine.preference === "next"
      ? `NEXT v${engine.nextInstalledVersion || "unknown"}` : "内置稳定内核";
    engineStatus += ` 已选择 ${selected}，正在等待运行期切换。`;
  } else if (engine.nextInstalled) {
    engineStatus += ` 已安装 NEXT v${engine.nextInstalledVersion}，不会自动跟随上游。`;
  } else {
    engineStatus += " 尚未安装 NEXT。";
  }
  if (busy === "next-engine") engineStatus = "正在从 aria2-next 官方 Release 下载、校验并安装 NEXT…";
  if (busy === "engine-switch") engineStatus = "正在保存任务状态并切换下载内核…";
  if (busy === "engine-recovery") engineStatus = "下载内核意外退出，正在自动恢复任务…";
  if (busy === "engine-reload") engineStatus = "内核自动恢复失败，正在重载 TrueDown…";
  els.engineUpdateStatus.textContent = engineStatus;
  els.installNextEngineBtn.textContent = engine.nextInstalled ? "手动更新 NEXT" : "手动安装 NEXT";
  els.installNextEngineBtn.disabled = Boolean(busy);
  KDComponents.setBusyState(els.installNextEngineBtn, busy === "next-engine", { manageDisabled: false });
  els.selectStableEngineBtn.disabled = Boolean(busy) || engine.preference === "stable";
  els.selectStableEngineBtn.setAttribute("aria-pressed", String(engine.preference === "stable"));
  els.selectNextEngineBtn.disabled = Boolean(busy) || !engine.nextInstalled || engine.preference === "next";
  els.selectNextEngineBtn.setAttribute("aria-pressed", String(engine.preference === "next"));
}

async function updateTrueDownAutoUpdate() {
  const requested = els.autoUpdateTruedown.checked;
  KDComponents.setBusyState(els.autoUpdateTruedown, true);
  try {
    systemUpdateState = normalizeSystemUpdateState(await requestJSON("/settings/updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoUpdateTrueDown: requested }),
    }));
    renderSystemUpdateState();
    showToast(requested ? "TrueDown 自动更新已启用。" : "TrueDown 自动更新已关闭，仍可手动检查。");
  } catch (error) {
    showToast(`自动更新设置失败：${error.message}`, "error");
    await reloadSystemUpdateStateQuietly();
  } finally {
    KDComponents.setBusyState(els.autoUpdateTruedown, false, { manageDisabled: false });
    renderSystemUpdateState();
  }
}

async function checkTrueDownUpdate() {
  setUpdateButtonBusy(els.checkTruedownUpdateBtn, true);
  try {
    systemUpdateState = normalizeSystemUpdateState(await requestJSON("/system/update/check", { method: "POST" }));
    renderSystemUpdateState();
    showToast(systemUpdateState.trueDown.restartRequired
      ? "新版本已下载并验证；任务空闲时会自动重启，或现在手动重启。"
      : "当前已是最新版本。")
  } catch (error) {
    showToast(`检查 TrueDown 更新失败：${error.message}`, "error");
    await reloadSystemUpdateStateQuietly();
  } finally {
    setUpdateButtonBusy(els.checkTruedownUpdateBtn, false);
    renderSystemUpdateState();
  }
}

async function restartForTrueDownUpdate() {
  const confirmed = await confirmAction({
    title: "重启并更新 TrueDown",
    message: "TrueDown 将停止内置 aria2、替换并启动新版本。存在排队、下载中或暂停任务时会拒绝本次重启；新版本启动失败会自动回滚。",
    confirmLabel: "重启并更新",
  });
  if (!confirmed) return;
  setUpdateButtonBusy(els.restartTruedownUpdateBtn, true);
  try {
    await requestJSON("/system/update/restart", { method: "POST" });
    showToast("TrueDown 正在重启并应用更新。");
  } catch (error) {
    showToast(`无法重启更新：${error.message}`, "error");
    setUpdateButtonBusy(els.restartTruedownUpdateBtn, false);
  }
}

async function installNextEngine() {
  const action = systemUpdateState?.engine.nextInstalled ? "更新" : "安装";
  const confirmed = await confirmAction({
    title: `手动${action} Aria2 Next`,
    message: `这会从 AnInsomniacy/aria2-next 的官方 GitHub Release 下载 Windows 内核，核对发布的 SHA-256 和版本后保存到 TrueDown 数据目录。NEXT 不会自动跟随上游；如果当前已选择 NEXT，验证完成后会自动保存任务状态并切换到新版本。`,
    confirmLabel: `手动${action}`,
  });
  if (!confirmed) return;
  setUpdateButtonBusy(els.installNextEngineBtn, true);
  try {
    systemUpdateState = normalizeSystemUpdateState(await requestJSON("/system/engine/next", { method: "POST" }));
    renderSystemUpdateState();
    if (systemUpdateState.busy === "engine-switch") {
      showToast("Aria2 Next 已验证，正在热切换下载内核…");
      systemUpdateState = await waitForEngineTransition();
    }
    showToast(systemUpdateState.error
      ? `Aria2 Next 已安装，但运行期切换未完成：${systemUpdateState.error}`
      : systemUpdateState.engine.active === "next"
        ? `当前已使用 Aria2 Next${systemUpdateState.engine.activeVersion ? ` v${systemUpdateState.engine.activeVersion}` : ""}。`
        : "Aria2 Next 已验证并安装；需要时可选择“使用 NEXT”。",
    systemUpdateState.error ? "error" : "success");
  } catch (error) {
    showToast(`Aria2 Next ${action}失败：${error.message}`, "error");
    await reloadSystemUpdateStateQuietly();
  } finally {
    setUpdateButtonBusy(els.installNextEngineBtn, false);
    renderSystemUpdateState();
  }
}

async function selectDownloadEngine(engine) {
  const button = engine === "next" ? els.selectNextEngineBtn : els.selectStableEngineBtn;
  setUpdateButtonBusy(button, true);
  try {
    systemUpdateState = normalizeSystemUpdateState(await requestJSON("/system/engine/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine }),
    }));
    renderSystemUpdateState();
    if (systemUpdateState.busy === "engine-switch") {
      showToast(`已选择${engine === "next" ? " Aria2 Next" : "内置稳定内核"}，正在保存任务并切换…`);
      systemUpdateState = await waitForEngineTransition();
    }
    const switched = systemUpdateState.engine.active === engine && !systemUpdateState.engine.restartRequired;
    showToast(switched
      ? `已切换到${engine === "next" ? " Aria2 Next" : "内置稳定内核"}。`
      : `下载内核切换未完成：${systemUpdateState.error || "已恢复原内核"}`,
    switched ? "success" : "error");
  } catch (error) {
    showToast(`切换下载内核失败：${error.message}`, "error");
    await reloadSystemUpdateStateQuietly();
  } finally {
    setUpdateButtonBusy(button, false);
    renderSystemUpdateState();
  }
}

async function reloadSystemUpdateStateQuietly() {
  try {
    await loadSystemUpdateState();
  } catch {
    renderSystemUpdateState();
  }
}

function setUpdateButtonBusy(button, busy) {
  KDComponents.setBusyState(button, busy);
}

function formatUpdateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
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
  KDComponents.setBusyState(els.tokenAuthEnabled, true);
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
    KDComponents.setBusyState(els.tokenAuthEnabled, false, { manageDisabled: false });
  }
}

async function copyAPIToken() {
  KDComponents.setBusyState(els.copyApiTokenBtn, true);
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
    KDComponents.setBusyState(els.copyApiTokenBtn, false, { manageDisabled: false });
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
  if (!apiTokenRequestPromise) {
    apiTokenRequestPromise = showDialog({
      title: "连接 TrueDown",
      eyebrow: "Authentication required",
      message: "此 TrueDown 正在远程接口上运行，请输入 API Key 以继续。Key 只保存在当前标签页会话中。",
      confirmLabel: "连接",
      inputLabel: "API Key",
      inputType: "password",
      validate: (value) => {
        const normalized = value.trim();
        return normalized.length < 32 || normalized.length > 256 || !/^[\x20-\x7e]+$/.test(normalized)
          ? "API Key 应为 32–256 个可打印 ASCII 字符。"
          : "";
      },
    }).finally(() => { apiTokenRequestPromise = null; });
  }
  const supplied = await apiTokenRequestPromise;
  if (supplied === null) {
    apiTokenPromptDismissed = true;
    return response;
  }
  const normalized = supplied.trim();
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
    const token = window.sessionStorage.getItem(API_TOKEN_SESSION_KEY) || "";
    if (token.length >= 32 && token.length <= 256 && token.trim() === token && /^[\x20-\x7e]+$/.test(token)) {
      return token;
    }
    window.sessionStorage.removeItem(API_TOKEN_SESSION_KEY);
    return "";
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
  trueDownToast?.show(text, type);
}

async function loadApplicationLog(announce = false) {
	KDComponents.setBusyState(els.refreshApplicationLogBtn, true);
	try {
		const response = await requestJSON("/system/logs");
		const content = stringValue(response.content).slice(-(256 * 1024));
		els.applicationLogOutput.textContent = content || "当前还没有应用日志。";
		const updated = stringValue(response.updatedAt);
		els.applicationLogStatus.textContent = response.truncated === true
			? `仅显示最新 256 KiB${updated ? `；更新时间：${formatUpdateTime(updated)}` : ""}。`
			: `显示当前日志${updated ? `；更新时间：${formatUpdateTime(updated)}` : ""}。`;
		els.copyApplicationLogBtn.disabled = !content;
		els.applicationLogOutput.scrollTop = els.applicationLogOutput.scrollHeight;
		if (announce) showToast("应用日志已刷新。");
	} catch (error) {
		els.applicationLogStatus.textContent = `读取应用日志失败：${error.message}`;
		if (announce) showToast(`读取应用日志失败：${error.message}`, "error");
	} finally {
		KDComponents.setBusyState(els.refreshApplicationLogBtn, false);
	}
}

async function copyApplicationLog() {
	KDComponents.setBusyState(els.copyApplicationLogBtn, true);
	try {
		const content = els.applicationLogOutput.textContent || "";
		if (!content || content === "当前还没有应用日志。") throw new Error("当前没有可复制的日志");
		await writeClipboard(content);
		showToast("应用日志已复制。");
	} catch (error) {
		showToast(`复制应用日志失败：${error.message}`, "error");
	} finally {
		KDComponents.setBusyState(els.copyApplicationLogBtn, false);
	}
}

async function exitTrueDown() {
	const confirmed = await confirmAction({
		title: "退出 TrueDown？",
		eyebrow: "Application lifecycle",
		message: "TrueDown 将停止当前服务和下载内核。未完成任务会保留，并在下次启动时恢复。",
		confirmLabel: "退出 TrueDown",
		danger: true,
	});
	if (!confirmed) return;
	KDComponents.setBusyState(els.exitTruedownBtn, true, { busyLabel: "正在退出…" });
	try {
		await requestJSON("/system/exit", { method: "POST", body: "{}" });
		showToast("TrueDown 正在安全退出。");
	} catch (error) {
		KDComponents.setBusyState(els.exitTruedownBtn, false);
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
