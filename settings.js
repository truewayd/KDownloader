const $ = (id) => document.getElementById(id);
const t = (key, substitutions, fallback) => KDI18n.get(key, substitutions, fallback);
KDI18n.localize();

let backendType = "abdm";
let watchMode = "batch";

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "runtime error"));
        return;
      }
      if (!response) {
        reject(new Error("No response from background"));
        return;
      }
      if (response.success === false) {
        reject(new Error(response.error || "Request failed"));
        return;
      }
      resolve(response);
    });
  });
}

function showToast(message, type = "success") {
  const toast = $("toast");
  const status = $("save-status");
  if (status) status.textContent = message;
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => {
    toast.className = "toast";
  }, 2600);
}

function numberValue(id, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number($(id)?.value);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function setValue(id, value) {
  const el = $(id);
  if (!el) return;
  if (el.type === "checkbox") el.checked = !!value;
  else el.value = value ?? "";
}

async function withBusyButton(button, task) {
  if (button) button.disabled = true;
  try {
    return await task();
  } finally {
    if (button) button.disabled = false;
  }
}

function setBackendType(type) {
  backendType = type === "gopeed" ? "gopeed" : "abdm";
  $("backend-type-abdm")?.classList.toggle("active", backendType === "abdm");
  $("backend-type-gopeed")?.classList.toggle("active", backendType === "gopeed");
  updateBackendVisibility();
}

function updateBackendVisibility() {
  const enabled = !!$("backend-enabled")?.checked;
  $("backend-details")?.classList.toggle("hidden", !enabled);
  $("abdm-fields")?.classList.toggle("hidden", !enabled || backendType !== "abdm");
  $("gopeed-fields")?.classList.toggle("hidden", !enabled || backendType !== "gopeed");
}

function updateDownloadFilterVisibility() {
  const enabled = !!$("download-filter-enabled")?.checked;
  $("download-filter-details")?.classList.toggle("hidden", !enabled);
}

function setWatchMode(mode) {
  watchMode = mode === "all" ? "all" : "batch";
  $("watch-mode-batch")?.classList.toggle("active", watchMode === "batch");
  $("watch-mode-all")?.classList.toggle("active", watchMode === "all");
}

function formatDate(value) {
  if (!value) return t("statusNever");
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return t("statusNever");
  }
}

async function loadBackend() {
  const { config } = await sendMessage({ action: "backend.getConfig" });
  setValue("backend-enabled", config.enabled);
  setBackendType(config.backendType);
  setValue("backend-protocol", config.protocol);
  setValue("backend-host", config.host);
  setValue("backend-port", config.port);
  setValue("backend-concurrency", config.concurrency);
  setValue("backend-retry-count", config.retryCount);
  setValue("backend-file-limit", config.perPostFileLimit);
  setValue("gopeed-protocol", config.gopeedProtocol);
  setValue("gopeed-host", config.gopeedHost);
  setValue("gopeed-port", config.gopeedPort);
  setValue("gopeed-token", config.gopeedToken);
  updateBackendVisibility();
}

async function saveBackend() {
  const config = {
    enabled: !!$("backend-enabled")?.checked,
    backendType,
    protocol: $("backend-protocol")?.value === "https" ? "https" : "http",
    host: ($("backend-host")?.value || "").trim() || "127.0.0.1",
    port: numberValue("backend-port", 15151, 1, 65535),
    concurrency: numberValue("backend-concurrency", 3, 1, 6),
    retryCount: numberValue("backend-retry-count", 3, 0, 10),
    perPostFileLimit: numberValue("backend-file-limit", 100, 1, 1000),
    gopeedProtocol: $("gopeed-protocol")?.value === "https" ? "https" : "http",
    gopeedHost: ($("gopeed-host")?.value || "").trim() || "127.0.0.1",
    gopeedPort: numberValue("gopeed-port", 9999, 1, 65535),
    gopeedToken: $("gopeed-token")?.value || "",
  };
  await sendMessage({ action: "backend.setConfig", config });
}

async function loadDownloadRules() {
  const { config } = await sendMessage({ action: "downloadRules.getConfig" });
  setValue("download-filter-enabled", config.enabled);
  const selected = new Set(config.excludedExtensions || []);
  document.querySelectorAll("[data-download-extension]").forEach((input) => {
    input.checked = selected.has(input.value);
  });
  updateDownloadFilterVisibility();
}

async function saveDownloadRules() {
  const excludedExtensions = Array.from(
    document.querySelectorAll("[data-download-extension]:checked"),
    (input) => input.value
  );
  await sendMessage({
    action: "downloadRules.setConfig",
    config: {
      enabled: !!$("download-filter-enabled")?.checked,
      excludedExtensions,
    },
  });
}

async function loadWatch() {
  const [{ config }, { summary }] = await Promise.all([
    sendMessage({ action: "watch.getConfig" }),
    sendMessage({ action: "watch.getSummary" }),
  ]);
  setValue("watch-interval", config.intervalMinutes);
  setWatchMode(config.checkMode);
  const count = Number(summary?.count) || 0;
  $("watch-count").textContent = count > 0
    ? t("watchCount", [String(count)])
    : t("watchCountEmpty");
}

async function saveWatch() {
  await sendMessage({
    action: "watch.setConfig",
    config: {
      intervalMinutes: numberValue("watch-interval", 30, 1, 10080),
      checkMode: watchMode,
    },
  });
}

async function exportWatchList() {
  const { data } = await sendMessage({ action: "watch.export" });
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `pawchive-watch-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importWatchList(file) {
  if (!file) return false;
  const confirmed = confirm(t("watchImportConfirm"));
  if (!confirmed) return false;
  const data = JSON.parse(await file.text());
  await sendMessage({ action: "watch.import", data });
  await loadWatch();
  return true;
}

async function loadGist() {
  const { config } = await sendMessage({ action: "gist.getConfig" });
  setValue("gist-enabled", config.enabled);
  setValue("gist-token", config.token);
  setValue("gist-id", config.gistId);
}

async function saveGist() {
  await sendMessage({
    action: "gist.setConfig",
    config: {
      enabled: !!$("gist-enabled")?.checked,
      token: $("gist-token")?.value || "",
      gistId: ($("gist-id")?.value || "").trim(),
    },
  });
}

async function loadCreators() {
  const summaryResponse = await sendMessage({ action: "creators.getSummary" });
  const summary = summaryResponse.summary || {};
  $("creators-coomer-meta").textContent = formatDate(summary["coomer.st"]?.updatedAt);
  $("creators-kemono-meta").textContent = formatDate(summary["kemono.cr"]?.updatedAt);

  const enabledResponse = await sendMessage({ action: "creators.ensureRuleState" });
  setValue("creators-enabled", !!enabledResponse.enabled);
}

async function saveCreators() {
  await sendMessage({
    action: "creators.setEnabled",
    enabled: !!$("creators-enabled")?.checked,
  });
}

async function loadAll() {
  try {
    $("save-status").textContent = t("statusLoading");
    await Promise.all([loadBackend(), loadDownloadRules(), loadWatch(), loadGist(), loadCreators()]);
    $("save-status").textContent = t("statusIdle");
  } catch (err) {
    console.error("[Settings] load failed", err);
    showToast(err.message || "Load failed", "error");
  }
}

async function saveAll() {
  const saveBtn = $("save-settings");
  await withBusyButton(saveBtn, async () => {
    try {
      $("save-status").textContent = t("statusSaving");
      await saveBackend();
      await saveDownloadRules();
      await saveWatch();
      await saveGist();
      await saveCreators();
      showToast(t("settingsSaved"));
    } catch (err) {
      console.error("[Settings] save failed", err);
      showToast(err.message || "Save failed", "error");
    }
  });
}

async function restoreDefaults(button) {
  const confirmed = confirm(t("restoreDefaultsConfirm"));
  if (!confirmed) return;

  await withBusyButton(button, async () => {
    try {
      $("save-status").textContent = t("statusRestoring");
      await sendMessage({
        action: "backend.setConfig",
        config: {
          enabled: false,
          backendType: "abdm",
          protocol: "http",
          host: "127.0.0.1",
          port: 15151,
          concurrency: 3,
          retryCount: 3,
          perPostFileLimit: 100,
          gopeedProtocol: "http",
          gopeedHost: "127.0.0.1",
          gopeedPort: 9999,
          gopeedToken: "",
        },
      });
      await sendMessage({
        action: "downloadRules.setConfig",
        config: {
          enabled: false,
          excludedExtensions: [
            ".psd", ".clip", ".sai", ".sai2", ".kra", ".xcf",
            ".procreate", ".afphoto", ".afdesign", ".blend",
          ],
        },
      });
      await sendMessage({
        action: "watch.setConfig",
        config: { intervalMinutes: 30, checkMode: "batch" },
      });
      await sendMessage({
        action: "gist.setConfig",
        config: { enabled: false, token: "", gistId: "" },
      });
      await sendMessage({ action: "creators.setEnabled", enabled: false });
      await loadAll();
      showToast(t("defaultsRestored"));
    } catch (err) {
      showToast(err.message || "Restore failed", "error");
    }
  });
}

async function updateCreatorCache(host, labelId) {
  const btn = host === "coomer.st" ? $("creators-update-coomer") : $("creators-update-kemono");
  await withBusyButton(btn, async () => {
    try {
      await sendMessage({ action: "creators.updateCache", host });
      $(labelId).textContent = t("statusUpdating");
      showToast(t("cacheRefreshStarted"));
      setTimeout(() => {
        loadCreators().catch(() => {});
      }, 1200);
    } catch (err) {
      showToast(err.message || "Refresh failed", "error");
    }
  });
}

function bindEvents() {
  $("backend-type-abdm")?.addEventListener("click", () => setBackendType("abdm"));
  $("backend-type-gopeed")?.addEventListener("click", () => setBackendType("gopeed"));
  $("backend-enabled")?.addEventListener("change", updateBackendVisibility);
  $("download-filter-enabled")?.addEventListener("change", updateDownloadFilterVisibility);
  $("save-settings")?.addEventListener("click", saveAll);
  $("reload-settings")?.addEventListener("click", (event) => withBusyButton(event.currentTarget, loadAll));
  $("restore-defaults")?.addEventListener("click", (event) => restoreDefaults(event.currentTarget));
  $("watch-mode-batch")?.addEventListener("click", () => setWatchMode("batch"));
  $("watch-mode-all")?.addEventListener("click", () => setWatchMode("all"));
  $("watch-check")?.addEventListener("click", (event) => {
    withBusyButton(event.currentTarget, async () => {
      try {
        await saveWatch();
        await sendMessage({ action: "watch.forceCheck" });
        showToast(t("watchCheckStarted"));
      } catch (err) {
        showToast(err.message || "Check failed", "error");
      }
    });
  });
  $("watch-export")?.addEventListener("click", (event) => {
    withBusyButton(event.currentTarget, async () => {
      try {
        await exportWatchList();
        showToast(t("watchExported"));
      } catch (err) {
        showToast(err.message || "Export failed", "error");
      }
    });
  });
  $("watch-import")?.addEventListener("click", () => $("watch-import-file")?.click());
  $("watch-import-file")?.addEventListener("change", async (event) => {
    try {
      const imported = await importWatchList(event.target.files?.[0]);
      if (imported) showToast(t("watchImported"));
    } catch (err) {
      showToast(err.message || "Import failed", "error");
    } finally {
      event.target.value = "";
    }
  });
  $("creators-update-coomer")?.addEventListener("click", () =>
    updateCreatorCache("coomer.st", "creators-coomer-meta")
  );
  $("creators-update-kemono")?.addEventListener("click", () =>
    updateCreatorCache("kemono.cr", "creators-kemono-meta")
  );
  $("gist-upload")?.addEventListener("click", (event) => {
    withBusyButton(event.currentTarget, async () => {
      try {
        await saveGist();
        await sendMessage({ action: "gist.upload" });
        showToast(t("gistUploaded"));
      } catch (err) {
        showToast(err.message || "Upload failed", "error");
      }
    });
  });
  $("gist-save")?.addEventListener("click", (event) => {
    withBusyButton(event.currentTarget, async () => {
      try {
        await saveGist();
        showToast(t("gistConfigSaved"));
      } catch (err) {
        showToast(err.message || "Save failed", "error");
      }
    });
  });
  $("gist-download")?.addEventListener("click", (event) => {
    withBusyButton(event.currentTarget, async () => {
      try {
        await saveGist();
        await sendMessage({ action: "gist.download" });
        await loadAll();
        showToast(t("gistDownloaded"));
      } catch (err) {
        showToast(err.message || "Download failed", "error");
      }
    });
  });
  $("clear-history")?.addEventListener("click", async (event) => {
    const confirmed = confirm(t("clearHistoryConfirm"));
    if (!confirmed) return;
    await withBusyButton(event.currentTarget, async () => {
      try {
        await sendMessage({ action: "db.clear" });
        showToast(t("historyCleared"));
      } catch (err) {
        showToast(err.message || "Clear failed", "error");
      }
    });
  });
}

bindEvents();
loadAll();
