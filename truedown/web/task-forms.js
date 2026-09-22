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
  KDComponents.setBusyState(els.submitTaskBtn, true);
  showModalMsg("正在读取下载默认值…");
  nativeTaskFormLoad = (async () => {
    try {
      // Form windows can read download preferences, but cannot migrate or save them.
      await refreshNativeTaskPreferences();
      if (nativeTaskPreferences.disposed) return;
      nativeTaskFormReady = true;
      showModalMsg("");
    } catch (error) {
      showModalMsg(`读取默认值失败，正在自动重试：${error.message}`, true);
    } finally {
      nativeTaskFormLoad = null;
      els.downloadForm.inert = false;
      KDComponents.setBusyState(els.submitTaskBtn, false);
      els.submitTaskBtn.disabled = !nativeTaskFormReady;
      if (nativeTaskFormReady && (document.activeElement === document.body || document.activeElement === els.submitTaskBtn)) els.mLink.focus();
      if (nativeTaskFormReady) drainNativeDrop();
    }
  })();
  return nativeTaskFormLoad;
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
