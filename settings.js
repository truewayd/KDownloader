const $ = (id) => document.getElementById(id);
const t = (key, substitutions, fallback) => KDI18n.get(key, substitutions, fallback);
KDI18n.localize();

const sendMessage = (...args) => KDUI.sendMessage(...args);
const withBusyButton = KDUI.withBusyButton;
const settingsToast = KDUI.createToast($("toast"), { statusElement: $("save-status") });

let backendType = "abdm";
let watchMode = "batch";
let settingsLoadGeneration = 0;
const MAX_WATCH_STORAGE_BYTES = 4 * 1024 * 1024;
const MAX_WATCH_IMPORT_FILE_BYTES = MAX_WATCH_STORAGE_BYTES + 1024;
let settingsLoaded = false;
let settingsRequestSequence = 0;

function createSettingsRequestId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `settings:${uuid}`;
  } catch (_) { }
  settingsRequestSequence += 1;
  return `settings:${Date.now()}:${settingsRequestSequence}`;
}

function isCurrentLoad(generation) {
  return generation === settingsLoadGeneration;
}

function setSaveAvailable(available) {
  const button = $("save-settings");
  if (button) button.disabled = !available;
}

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
  if (value && !/^[\x20-\x7e]{32,256}$/.test(value)) {
    throw new Error(t("backendApiKeyInvalid", null, "API Key must contain 32 to 256 printable ASCII characters"));
  }
  return value;
}

function headerSecretValue(id) {
  const value = ($(id)?.value || "").trim();
  if (value.length > 4096 || !/^[\x20-\x7e]*$/.test(value)) {
    throw new Error(t(
      "headerSecretInvalid",
      null,
      "Token must contain no more than 4096 printable ASCII characters"
    ));
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
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : t("statusNever");
}

async function loadBackend(generation) {
  const { config } = await sendMessage({ action: "backend.getConfig" });
  if (!isCurrentLoad(generation)) return;
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
    gopeedToken: headerSecretValue("gopeed-token"),
  };
  await sendMessage({ action: "backend.setConfig", config });
}

async function loadDownloadRules(generation) {
  const { config } = await sendMessage({ action: "downloadRules.getConfig" });
  if (!isCurrentLoad(generation)) return;
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

async function loadExternalLinkFilter(generation) {
  const { config } = await sendMessage({ action: "externalLinkFilter.getConfig" });
  if (!isCurrentLoad(generation)) return;
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

async function loadWatch(generation = settingsLoadGeneration) {
  const [{ config }, { summary }] = await Promise.all([
    sendMessage({ action: "watch.getConfig" }),
    sendMessage({ action: "watch.getSummary" }),
  ]);
  if (!isCurrentLoad(generation)) return;
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
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  if (blob.size > MAX_WATCH_IMPORT_FILE_BYTES) {
    throw new Error("Watch export exceeds the import transport safety limit");
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `pawchive-watch-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importWatchList(file) {
  if (!file) return false;
  if (file.size > MAX_WATCH_IMPORT_FILE_BYTES) {
    throw new Error("Watch import file exceeds the transport safety limit");
  }
  const confirmed = confirm(t("watchImportConfirm"));
  if (!confirmed) return false;
  const data = JSON.parse(await file.text());
  await sendMessage({ action: "watch.import", data });
  await loadWatch();
  return true;
}

async function loadGist(generation) {
  const { config } = await sendMessage({ action: "gist.getConfig" });
  if (!isCurrentLoad(generation)) return;
  setValue("gist-enabled", config.enabled);
  setValue("gist-token", config.token);
  setValue("gist-id", config.gistId);
}

async function saveGist() {
  await sendMessage({
    action: "gist.setConfig",
    config: {
      enabled: !!$("gist-enabled")?.checked,
      token: headerSecretValue("gist-token"),
      gistId: ($("gist-id")?.value || "").trim(),
    },
  });
}

async function loadCreatorSummary(generation = settingsLoadGeneration) {
  const summaryResponse = await sendMessage({ action: "creators.getSummary" });
  if (!isCurrentLoad(generation)) return;
  const summary = summaryResponse.summary || {};
  $("creators-coomer-meta").textContent = formatDate(summary["coomer.st"]?.updatedAt);
  $("creators-kemono-meta").textContent = formatDate(summary["kemono.cr"]?.updatedAt);
}

async function loadCreators(generation) {
  const [summaryResponse, enabledResponse] = await Promise.all([
    sendMessage({ action: "creators.getSummary" }),
    sendMessage({ action: "creators.ensureRuleState" }),
  ]);
  if (!isCurrentLoad(generation)) return;
  const summary = summaryResponse.summary || {};
  $("creators-coomer-meta").textContent = formatDate(summary["coomer.st"]?.updatedAt);
  $("creators-kemono-meta").textContent = formatDate(summary["kemono.cr"]?.updatedAt);
  setValue("creators-enabled", !!enabledResponse.enabled);
}

async function saveCreators() {
  await sendMessage({
    action: "creators.setEnabled",
    enabled: !!$("creators-enabled")?.checked,
  });
}

async function loadAll() {
  const generation = ++settingsLoadGeneration;
  settingsLoaded = false;
  setSaveAvailable(false);
  try {
    $("save-status").textContent = t("statusLoading");
    await Promise.all([
      loadBackend(generation),
      loadDownloadRules(generation),
      loadExternalLinkFilter(generation),
      loadWatch(generation),
      loadGist(generation),
      loadCreators(generation),
    ]);
    if (!isCurrentLoad(generation)) return false;
    settingsLoaded = true;
    setSaveAvailable(true);
    $("save-status").textContent = t("statusIdle");
    return true;
  } catch (err) {
    if (!isCurrentLoad(generation)) return false;
    console.error("[Settings] load failed", err);
    showToast(err.message || "Load failed", "error");
    return false;
  }
}

async function saveAll() {
  if (!settingsLoaded) {
    showToast(t("statusLoading"), "error");
    return;
  }
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
    } finally {
      if (settingsLoaded) $("save-status").textContent = t("statusIdle");
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
      await sendMessage(
        { action: "creators.updateCache", host, requestId: createSettingsRequestId() },
        5000,
        { retries: 0, retryDelay: 0 }
      );
      $(labelId).textContent = t("statusUpdating");
      showToast(t("cacheRefreshStarted"));
      setTimeout(() => {
        loadCreatorSummary().catch(() => {});
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
        await sendMessage(
          { action: "watch.forceCheck" },
          7000,
          { retries: 0, retryDelay: 0 }
        );
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
        await sendMessage({ action: "gist.upload" }, 12000, { retries: 0, retryDelay: 0 });
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
        await sendMessage({ action: "gist.download" }, 12000, { retries: 0, retryDelay: 0 });
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
