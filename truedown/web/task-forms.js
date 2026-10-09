// Native form lifecycle and cross-window preferences. Submission stays in app.js.
let nativeTaskFormReady = false;
let nativeTaskFormLoad = null;
let nativeTaskFormConfigured = false;
const nativeTaskPreferences = {
  pending: null, requested: false, disposed: false, failed: false,
};

function isNativeTaskWindow() {
  return typeof nativeWindowRole !== "undefined" && nativeWindowRole === "new-task";
}

function bindNativeTaskPreferences() {
  if (!isNativeTaskWindow()) return;
  listenNativeEvent("truedown:task-clipboard", fillTaskClipboard).catch(console.error);
  window.addEventListener("focus", refreshNativeTaskFormOnActivation);
  window.addEventListener("pagehide", () => {
    nativeTaskPreferences.disposed = true;
    window.removeEventListener("focus", refreshNativeTaskFormOnActivation);
  }, { once: true });
}

function refreshNativeTaskFormOnActivation() {
  if (document.hidden || nativeTaskPreferences.disposed) return;
  if (!nativeTaskFormReady) { initNativeTaskForm(); return; }
  refreshNativeTaskPreferences().catch((error) => {
    if (!nativeTaskPreferences.disposed) showModalMsg(`读取当前下载选项失败，正在自动重试：${error.message}`, true);
  });
}

async function refreshNativeTaskPreferences() {
  nativeTaskPreferences.requested = true;
  if (nativeTaskPreferences.pending) return nativeTaskPreferences.pending;
  nativeTaskPreferences.pending = (async () => {
    while (nativeTaskPreferences.requested && !nativeTaskPreferences.disposed) {
      nativeTaskPreferences.requested = false;
      const outcomes = await Promise.allSettled([
        requestJSON("/settings/task-defaults"), requestJSON("/settings/download-rules"), requestJSON("/modules"),
      ]);
      if (nativeTaskPreferences.disposed) return;
      if (nativeTaskPreferences.requested) continue;
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure) throw failure.reason;
      const [defaults, rules, modules] = outcomes.map((outcome) => outcome.value);
      // Commit one complete snapshot. Reopening must preserve explicit form drafts.
      applyTaskDefaults(defaults);
      downloadRules = normalizeServerDownloadRules(rules);
      resolverModules = normalizeResolverModules(modules);

    }
  })();
  try {
    await nativeTaskPreferences.pending;
    cancelReadRetry("task-preferences");
    if (nativeTaskPreferences.failed && nativeTaskFormReady && !nativeTaskPreferences.disposed) showModalMsg("连接已恢复，下载选项已同步。");
    nativeTaskPreferences.failed = false;
  } catch (error) {
    nativeTaskPreferences.failed = true;
    scheduleReadRetry("task-preferences", async () => {
      if (!nativeTaskFormReady) { await initNativeTaskForm(); return; }
      await refreshNativeTaskPreferences();
    }, () => !nativeTaskPreferences.disposed);
    throw error;
  } finally {
    nativeTaskPreferences.pending = null;
  }
}

async function initNativeTaskForm() {
  if (nativeTaskFormLoad) return nativeTaskFormLoad;
  currentPage = nativeWindowRole;
  document.title = "新建下载";
  document.querySelector(".app-shell").hidden = true;
  const surface = els.downloadForm.closest(".modal");
  surface.setAttribute("role", "main");
  surface.removeAttribute("aria-modal");
  els.modalCloseBtn.hidden = true;
  els.downloadForm.querySelector(".modal-header").classList.add("visually-hidden");
  els.modalCancelBtn.hidden = true;
  els.overlay.classList.add("open");
  els.overlay.setAttribute("aria-hidden", "false");
  els.overlay.removeAttribute("inert");
  if (!nativeTaskFormConfigured) {
    configureTaskForm();
    nativeTaskFormConfigured = true;
  }
  els.downloadForm.inert = true;
  const body = els.downloadForm.querySelector(".modal-body");
  KDComponents.setPageLoading(body, !nativeTaskFormReady && body.dataset.loading !== "false");
  KDComponents.setBusyState(els.submitTaskBtn, true);
  showModalMsg("正在读取下载默认值…");
  nativeTaskFormLoad = (async () => {
    try {
      // Form windows can read download preferences, but cannot migrate or save them.
      await refreshNativeTaskPreferences();
      if (nativeTaskPreferences.disposed) return;
      nativeTaskFormReady = true;
      KDComponents.setPageLoading(body, false);
      showModalMsg("");
    } catch (error) {
      KDComponents.setPageLoading(body, false);
      showModalMsg(`读取默认值失败，正在自动重试：${error.message}`, true);
    } finally {
      nativeTaskFormLoad = null;
      els.downloadForm.inert = false;
      KDComponents.setBusyState(els.submitTaskBtn, false);
      els.submitTaskBtn.disabled = !nativeTaskFormReady;
      if (nativeTaskFormReady && (document.activeElement === document.body || document.activeElement === els.submitTaskBtn)) els.mLink.focus();
      if (nativeTaskFormReady) { await drainNativeDrop(); await fillTaskClipboard(); }
    }
  })();
  return nativeTaskFormLoad;
}

let taskClipboardPending = false;
async function fillTaskClipboard() {
  if (!nativeTaskFormReady || nativeTaskPreferences.disposed || taskClipboardPending) return;
  taskClipboardPending = true;
  const source = els.mLink.value, file = els.mTorrentFile.files?.[0];
  try {
    const links = await invokeNative("take_task_clipboard");
    if (nativeTaskPreferences.disposed || els.downloadForm.inert || readingNativeDrop || applyingDrop
      || source.trim() || file || els.mLink.value !== source || els.mTorrentFile.files?.[0] !== file
      || !Array.isArray(links) || !links.length) return;
    els.mLink.value = parseLinks(links.join("\n")).join("\n");
    showModalMsg(`已从剪贴板识别 ${links.length} 个链接，请确认后开始下载。`);
  } catch { /* Unavailable clipboard access must not prevent manual entry. */ }
  finally { taskClipboardPending = false; }
}

async function finishNativeTaskForm(message) {
  showModalMsg(message);
  try {
    await invokeNative("finish_task_window");
  } catch (error) {
    // Dispatch has already succeeded. A window operation must never invite replay.
    showModalMsg(`${message}。返回主窗口失败：${error.message}`, true);
  }
}

async function subscribeToCreatedTasks() {
  if (!window.__TAURI__?.event?.listen) return;
  try {
    await listenNativeEvent("truedown:tasks-created", () => {
      if (currentPage === "tasks") refreshAndSchedule(true);
      showToast("下载任务已添加");
    });
    await listenNativeEvent("truedown:task-changed", () => {
      if (currentPage === "tasks") refreshAndSchedule(true);
    });
  } catch (error) {
    showToast(`监听新任务失败：${error.message}`, "error");
  }
}
