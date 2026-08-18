const $ = (id) => document.getElementById(id);
const t = (key, substitutions, fallback) => KDI18n.get(key, substitutions, fallback);
KDI18n.localize();

const sendMessage = (...args) => KDUI.sendMessage(...args);
const withBusyButton = KDUI.withBusyButton;
const settingsToast = KDUI.createToast($("toast"), { statusElement: $("save-status") });

let backendType = "abdm";
let watchMode = "batch";

function showToast(message, type = "success") {
  settingsToast.show(message, type);
}

function numberValue(id, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number($(id)?.value);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function loopbackHostValue(id) {
  const value = ($(id)?.value || "127.0.0.1").trim().toLowerCase();
  if (value !== "127.0.0.1" && value !== "localhost") {
    throw new Error(t("backendLoopbackRequired", null, "Backend host must be localhost or 127.0.0.1"));
  }
  return value;
}

function backendApiKeyValue() {
  const value = ($("backend-api-key")?.value || "").trim();
  if (value && (value.length < 32 || value.length > 256 || /[\0\r\n]/.test(value))) {
    throw new Error(t("backendApiKeyInvalid", null, "API Key must contain 32 to 256 safe characters"));
  }
  return value;
}

function setValue(id, value) {
  const el = $(id);
  if (!el) return;
  if (el.type === "checkbox") el.checked = !!value;
  else el.value = value ?? "";
}

function setBackendType(type) {
  backendType = type === "gopeed" ? "gopeed" : "abdm";
  KDUI.setSegmentedValue(
    [$("backend-type-abdm"), $("backend-type-gopeed")],
    backendType,
    "data-value"
  );
  updateBackendVisibility();
}

function updateBackendVisibility() {
  const enabled = !!$("backend-enabled")?.checked;
  $("backend-details")?.classList.toggle("kd-hidden", !enabled);
  $("abdm-fields")?.classList.toggle("kd-hidden", !enabled || backendType !== "abdm");
  $("gopeed-fields")?.classList.toggle("kd-hidden", !enabled || backendType !== "gopeed");
}

function updateDownloadFilterVisibility() {
  const enabled = !!$("download-filter-enabled")?.checked;
  $("download-filter-details")?.classList.toggle("kd-hidden", !enabled);
}

function updateExternalLinkFilterVisibility() {
  const enabled = $("external-link-filter-mode")?.value === "blacklist";
  $("external-link-filter-details")?.classList.toggle("kd-hidden", !enabled);
}

function setWatchMode(mode) {
  watchMode = mode === "all" ? "all" : "batch";
  KDUI.setSegmentedValue(
    [$("watch-mode-batch"), $("watch-mode-all")],
    watchMode,
    "data-value"
  );
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
  setValue("backend-api-key", config.apiKey);
  setValue("gopeed-protocol", config.gopeedProtocol);
  setValue("gopeed-host", config.gopeedHost);
  setValue("gopeed-port", config.gopeedPort);
  setValue("gopeed-token", config.gopeedToken);
  updateBackendVisibility();
}

async function saveBackend() {
  const apiKey = backendApiKeyValue();
  const config = {
    enabled: !!$("backend-enabled")?.checked,
    backendType,
    protocol: $("backend-protocol")?.value === "https" ? "https" : "http",
    host: loopbackHostValue("backend-host"),
    port: numberValue("backend-port", 15151, 1, 65535),
    concurrency: numberValue("backend-concurrency", 3, 1, 6),
    retryCount: numberValue("backend-retry-count", 3, 0, 10),
    perPostFileLimit: numberValue("backend-file-limit", 100, 1, 1000),
    apiKey,
    gopeedProtocol: $("gopeed-protocol")?.value === "https" ? "https" : "http",
    gopeedHost: loopbackHostValue("gopeed-host"),
    gopeedPort: numberValue("gopeed-port", 9999, 1, 65535),
    gopeedToken: $("gopeed-token")?.value || "",
  };
  await sendMessage({ action: "backend.setConfig", config });
}

async function loadDownloadRules() {
  const { config } = await sendMessage({ action: "downloadRules.getConfig" });
  setValue("download-filter-enabled", config.enabled);
  setValue("download-filter-sync-truedown", config.syncToTrueDown);
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
  return sendMessage({
    action: "downloadRules.setConfig",
    config: {
      enabled: !!$("download-filter-enabled")?.checked,
      excludedExtensions,
      syncToTrueDown: !!$("download-filter-sync-truedown")?.checked,
    },
  }, 20000);
}

async function loadExternalLinkFilter() {
  const { config } = await sendMessage({ action: "externalLinkFilter.getConfig" });
  setValue("external-link-filter-mode", config.mode);
  setValue("external-link-filter-blacklist", (config.blacklist || []).join("\n"));
  updateExternalLinkFilterVisibility();
}

async function saveExternalLinkFilter() {
  const blacklist = ($("external-link-filter-blacklist")?.value || "")
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  await sendMessage({
    action: "externalLinkFilter.setConfig",
    config: {
      mode: $("external-link-filter-mode")?.value === "disabled" ? "disabled" : "blacklist",
      blacklist,
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
  if (file.size > 4 * 1024 * 1024) throw new Error("Watch import file exceeds the 4 MiB safety limit");
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
    await Promise.all([loadBackend(), loadDownloadRules(), loadExternalLinkFilter(), loadWatch(), loadGist(), loadCreators()]);
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
      const [downloadRulesResult] = await Promise.all([
        saveDownloadRules(),
        saveExternalLinkFilter(),
        saveWatch(),
        saveGist(),
        saveCreators(),
      ]);
      if (downloadRulesResult?.sync?.state === "failed") {
        showToast(`${t("settingsSavedTrueDownSyncFailed")} ${downloadRulesResult.sync.error}`, "error");
      } else {
        showToast(t("settingsSaved"));
      }
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
      await sendMessage({ action: "settings.restoreDefaults" });
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
  $("external-link-filter-mode")?.addEventListener("change", updateExternalLinkFilterVisibility);
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
