const SETTINGS_PAGES = ["general", "network", "files", "groups", "application", "modules", "engine", "security", "advanced", "experimental", "logs", "about"];
const EDITABLE_SETTINGS_PAGES = new Set(["general", "network", "files", "advanced", "experimental"]);
const settingsLoads = new Map();
const settingsReady = new Set();
const settingsRendered = new Set();
const settingsMessages = new Map();
const settingReadVersions = new Map();
let systemUpdateTimer = 0, updatePreferenceSaving = false;
function stopSystemUpdateRefresh() { clearTimeout(systemUpdateTimer); }
function scheduleSystemUpdateRefresh() {
  stopSystemUpdateRefresh();
  if (document.hidden || currentPage !== "settings" || currentSettingsPage !== "engine") return;
  const epoch = routeEpoch;
  systemUpdateTimer = setTimeout(async () => {
    try { if (!updatePreferenceSaving && epoch === routeEpoch) await loadSystemUpdateState(); }
    catch { /* Keep the last verified status during a transient disconnect. */ }
    finally { if (epoch === routeEpoch) scheduleSystemUpdateRefresh(); }
  }, 3000);
}
document.addEventListener("visibilitychange", scheduleSystemUpdateRefresh);
window.addEventListener("pagehide", stopSystemUpdateRefresh, { once: true });
const settingReadRequests = new Map();
const settingSnapshotsKnown = new Set();
const pendingResolverModuleActions = new Set();
let startupSettings = null;
let taskDefaultsRevision = 0;
let taskDefaultsLoad = null;

function invalidateSettingRead(key) {
  const revision = (settingReadVersions.get(key) || 0) + 1;
  settingReadVersions.set(key, revision);
  return revision;
}

async function readSettingSnapshot(key, url, apply) {
  const pending = settingReadRequests.get(key);
  if (pending && pending.revision === settingReadVersions.get(key)) return pending.promise;
  const revision = invalidateSettingRead(key);
  const promise = (async () => {
    try {
      const value = await requestJSON(url);
      if (settingReadVersions.get(key) !== revision) return;
      apply(value);
      settingSnapshotsKnown.add(key);
    } finally {
      if (settingReadRequests.get(key)?.revision === revision) settingReadRequests.delete(key);
    }
  })();
  settingReadRequests.set(key, { revision, promise });
  return promise;
}

function markSettingsDraft() {
  if (!EDITABLE_SETTINGS_PAGES.has(currentSettingsPage)) return;
  settingsMessages.set(currentSettingsPage, "本页有未保存的修改。");
  els.settingsSaveStatus.textContent = settingsMessages.get(currentSettingsPage);
}

function settingsPanels(page = currentSettingsPage) {
  return [...document.querySelectorAll(`[data-settings-page="${page}"]`)];
}

function renderSettingsCategory(page, settings = downloadSettings, rules = downloadRules, runtime = runtimeSettings) {
  renderDownloadSettings(settings, rules, runtime, page);
}

async function loadSettingsPage(retry = false) {
  const page = currentSettingsPage;
  const epoch = routeEpoch;
  document.querySelectorAll("[data-settings-page]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPage !== page;
  });
  document.querySelectorAll("[data-settings-link]").forEach((link) => {
    if (link.dataset.settingsLink === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  els.settingsFooter.hidden = !EDITABLE_SETTINGS_PAGES.has(page);
  els.settingsSaveStatus.textContent = settingsMessages.get(page) || "保存当前分类的设置。";
  els.settingsReloadBtn.hidden = true;
  if (retry) { settingsReady.delete(page); settingsRendered.delete(page); }
  if (page === "logs") { loadApplicationLog(); }
  if (page === "about") { loadAbout(); }
  if (page === "engine") scheduleSystemUpdateRefresh();
  if (settingsReady.has(page)) {
    initializeSettingsCategory(page);
    els.settingsLoadStatus.textContent = "";
    els.settingsSaveBtn.disabled = false;
    els.settingsResetBtn.disabled = false;

    return;
  }
  els.settingsSaveBtn.disabled = true;
  els.settingsResetBtn.disabled = true;
  settingsPanels(page).forEach((panel) => { panel.inert = !["logs", "about"].includes(page); });
  els.settingsLoadStatus.textContent = ["logs", "about"].includes(page) ? "" : "正在读取本页设置…";
  try {
    if (!settingsLoads.has(page)) {
      const loaders = {
        logs: () => {},
        about: () => {},
        general: () => Promise.all([loadServerTaskDefaults(), loadServerRuntimeSettings()]),
        network: loadServerTaskDefaults,
        groups: loadFileGroupsEditor,
        files: () => Promise.all([loadServerTaskDefaults(), loadServerDownloadRules()]),
        advanced: loadServerTaskDefaults,
        application: () => Promise.all([loadStartupSettings(), loadStorageLocation()]),
        modules: loadResolverModules,
        engine: () => Promise.all([loadSystemUpdateState(), loadTrackerResearchSettings()]),
        security: loadAuthSettings,
        experimental: loadTrackerResearchSettings,
      };
      settingsLoads.set(page, Promise.resolve().then(() => loaders[page]?.()).finally(() => settingsLoads.delete(page)));
    }
    await settingsLoads.get(page);
    settingsReady.add(page);
    if (epoch !== routeEpoch || currentPage !== "settings" || currentSettingsPage !== page) return;
    initializeSettingsCategory(page);

    els.settingsLoadStatus.textContent = "";
    els.settingsSaveBtn.disabled = false;
    els.settingsResetBtn.disabled = false;
  } catch (error) {
    if (epoch !== routeEpoch || currentPage !== "settings" || currentSettingsPage !== page) return;
    els.settingsLoadStatus.textContent = `读取失败：${error.message}`;
    els.settingsReloadBtn.hidden = false;
  } finally {
    // A category becomes editable only after its own read has succeeded.
    settingsPanels(page).forEach((panel) => { panel.inert = !settingsReady.has(page); });
  }
}

function initializeSettingsCategory(page) {
  if (settingsRendered.has(page)) return;
  renderSettingsCategory(page);
  if (page === "experimental") renderTrackerResearchSettings();
  if (page === "engine") els.btClientIdentity.textContent = bitTorrentIdentityDescription(trackerResearchSettings);
  settingsRendered.add(page);
}

async function loadStartupSettings() {
  await readSettingSnapshot("startup", "/settings/startup", (value) => {
    startupSettings = value;
    renderStartupSettings();
  });
}

async function loadStorageLocation() {
  const element = document.getElementById("storage-location");
  try {
    const location = await requestJSON("/system/storage");
    element.replaceChildren();
    const root = document.createElement("p");
    root.textContent = `数据目录：${location.dataDirectory}`;
    element.append(root);
    if (location.paths) {
      const details = document.createElement("dl");
      details.className = "storage-locations";
      for (const [key,label] of [["config","配置"],["data","任务数据"],["state","恢复状态"],["logs","日志"],["cache","缓存"]]) {
        const term = document.createElement("dt"), path = document.createElement("dd");
        term.textContent = label; path.textContent = location.paths[key]; details.append(term,path);
      }
      element.append(details);
    }
  } catch (error) {
    element.textContent = `读取数据目录失败：${error.message}`;
    throw error;
  }
}

function renderStartupSettings() {
  const state = startupSettings;
  els.startupEnabled.checked = state?.enabled === true;
  els.startupEnabled.disabled = state?.supported !== true;
  const status = !state ? "尚未读取启动设置。" : !state.supported
    ? "此实例不支持内置开机启动。"
    : state.enabled ? "已开启，下次登录时在后台启动。" : "已关闭。";
  els.startupStatus.textContent = `${status}${stringValue(state?.reason)}`;
}

async function updateStartupSettings() {
  if (els.startupEnabled.disabled) return;
  const restoreFocus = document.activeElement === els.startupEnabled;
  const enabled = els.startupEnabled.checked;
  KDComponents.setBusyState(els.startupEnabled, true);
  try {
    invalidateSettingRead("startup");
    startupSettings = await requestJSON("/settings/startup", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
    });
    invalidateSettingRead("startup");
    renderStartupSettings();
    const applied = startupSettings.enabled === true;
    if (applied === enabled) showToast(applied ? "已开启开机自动启动。" : "已关闭开机自动启动。");
    else showToast(stringValue(startupSettings.reason) || "启动状态未按请求更改，请检查系统启动项设置。", "error");
  } catch (error) {
    renderStartupSettings();
    els.startupStatus.textContent = `保存启动设置失败：${error.message}`;
    showToast(els.startupStatus.textContent, "error");
  } finally {
    KDComponents.setBusyState(els.startupEnabled, false);
    els.startupEnabled.disabled = startupSettings?.supported !== true;
    if (restoreFocus && currentPage === "settings" && currentSettingsPage === "application") els.startupEnabled.focus({ preventScroll: true });

  }
}

async function saveDownloadSettings(event) {
  event.preventDefault();
  const page = currentSettingsPage;
  if (els.settingsForm.inert || !settingsReady.has(page) || !EDITABLE_SETTINGS_PAGES.has(page)) return;
  for (const panel of settingsPanels(page)) {
    const invalid = [...panel.querySelectorAll("input, textarea, select")].find((input) => !input.disabled && !input.checkValidity());
    if (invalid) { invalid.reportValidity(); return; }
  }
  const previousFocus = document.activeElement;
  els.settingsForm.inert = true;
  KDComponents.setBusyState(els.settingsSaveBtn, true);
  let serverSaved = false;
  try {
    const next = { ...downloadSettings };
    if (page === "general") {
      next.folder = els.cfgFolder.value.trim();
      next.connections = optionalInt("cfgConns") || DEFAULT_DOWNLOAD_SETTINGS.connections;
      next.speed = Number(els.cfgSpeed.value || 0);
      next.speedUnit = Number(els.cfgSpeedUnit.value);
      validateSettingsSpeed(next.speed, next.speedUnit);
      const speed = Number(els.cfgGlobalSpeed.value || 0);
      const unit = Number(els.cfgGlobalSpeedUnit.value);
      validateSettingsSpeed(speed, unit);
      invalidateSettingRead("runtime");
      runtimeSettings = normalizeServerRuntimeSettings(await requestJSON("/settings/runtime", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concurrentDownloads: optionalInt("cfgTaskConcurrency") || 3, globalDownloadLimitBps: Math.round(speed * unit) }),
      }));
      invalidateSettingRead("runtime");
      serverSaved = true;
      const normalizedSpeed = displaySpeed(runtimeSettings.globalDownloadLimitBps);
      els.cfgTaskConcurrency.value = runtimeSettings.concurrentDownloads;
      els.cfgGlobalSpeed.value = normalizedSpeed.value || "";
      els.cfgGlobalSpeedUnit.value = String(normalizedSpeed.unit);
    } else if (page === "network") {
      parseHeaders(els.cfgHeaders.value);
      Object.assign(next, {
        maxTries: optionalInt("cfgTries") || 5, retryWait: optionalInt("cfgWait") || 3,
        proxy: els.cfgProxy.value.trim(), proxyMode: els.cfgProxyMode.value, userAgent: els.cfgUserAgent.value.trim(),
        referer: els.cfgReferer.value.trim(), headers: els.cfgHeaders.value.trim(),
      });
    } else if (page === "files") {
      Object.assign(next, { allocation: els.cfgAllocation.value, checkIntegrity: els.cfgCheckIntegrity.checked, remoteTime: els.cfgRemoteTime.checked });
      invalidateSettingRead("rules");
      downloadRules = normalizeServerDownloadRules(await requestJSON("/settings/download-rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: els.cfgFilterEnabled.checked, dropboxMode: els.cfgDropboxMode.value,
          excludedExtensions: [...document.querySelectorAll("[data-download-extension]:checked")].map((input) => input.value),
        }),
      }));
      invalidateSettingRead("rules");
      serverSaved = true;
      els.cfgDropboxMode.value = downloadRules.dropboxMode;
      els.cfgFilterEnabled.checked = downloadRules.enabled;
      document.querySelectorAll("[data-download-extension]").forEach((input) => {
        input.checked = downloadRules.excludedExtensions.includes(input.value);
      });
    } else if (page === "advanced") {
      next.extra = els.cfgExtra.value.trim();
    } else if (page === "experimental") {
      const settings = readTrackerResearchForm();
      let acknowledgedRisk = false;
      if (settings.enabled && !trackerResearchSettings.enabled) {
        acknowledgedRisk = await confirmAction({
          eyebrow: "Research only", title: "确认启用 Tracker 流量研究",
          message: "此功能仅限在你控制的 tracker 或测试环境中研究流量，不得用于欺骗、滥用或违反服务条款。继续即表示你理解并自行承担全部后果。",
          confirmLabel: "我理解，启用研究模块", danger: true,
        });
        if (!acknowledgedRisk) return;
      }
      invalidateSettingRead("tracker");
      trackerResearchSettings = normalizeTrackerResearchSettings(await requestJSON("/settings/tracker-research", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, acknowledgedRisk }),
      }));
      invalidateSettingRead("tracker");
      serverSaved = true;
    }
    if (page !== "experimental") {
      try {
        const saved = await requestJSON("/settings/task-defaults", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: taskDefaultsRevision, values: next }),
        });
        applyTaskDefaults(saved);
      } catch (error) {
        if (error.status === 409) {
          await loadServerTaskDefaults();
          throw new Error("其他窗口已修改默认值，已读取最新设置；本页草稿保留，请检查后重新保存。");
        }
        throw error;
      }
    }
    settingsMessages.set(page, "本页设置已保存。");
    if (currentPage === "settings" && currentSettingsPage === page) {
      renderSettingsCategory(page);
      if (page === "experimental") renderTrackerResearchSettings();
      els.settingsSaveStatus.textContent = settingsMessages.get(page);
    }

    showToast("本页设置已保存。");
  } catch (error) {
    const message = `${serverSaved ? "运行或规则设置已保存，任务默认值保存失败" : "本页设置未保存"}：${error.message}`;
    settingsMessages.set(page, message);
    if (currentPage === "settings" && currentSettingsPage === page) els.settingsSaveStatus.textContent = message;
    showToast(message, "error");
  } finally {
    els.settingsForm.inert = false;
    KDComponents.setBusyState(els.settingsSaveBtn, false);
    els.settingsSaveBtn.disabled = !settingsReady.has(currentSettingsPage);
    if (previousFocus?.isConnected && currentPage === "settings" && currentSettingsPage === page) previousFocus.focus({ preventScroll: true });
  }
}

function validateSettingsSpeed(speed, unit) {
  const bytes = Math.round(speed * unit);
  if (!Number.isFinite(speed) || speed < 0 || !Number.isSafeInteger(bytes) || bytes > MAX_SPEED_BPS) throw new Error("限速数值过大");
}

function resetDownloadSettings() {
  const page = currentSettingsPage;
  if (!settingsReady.has(page) || !EDITABLE_SETTINGS_PAGES.has(page)) return;
  renderSettingsCategory(page, DEFAULT_DOWNLOAD_SETTINGS, DEFAULT_DOWNLOAD_RULES, DEFAULT_RUNTIME_SETTINGS);
  if (page === "experimental") renderTrackerResearchSettings({
    ...trackerResearchSettings, ...DEFAULT_TRACKER_RESEARCH_SETTINGS,
    engine: trackerResearchSettings.engine, engineVersion: trackerResearchSettings.engineVersion,
    supportKnown: trackerResearchSettings.supportKnown, supported: trackerResearchSettings.supported,
  });
  els.settingsSaveStatus.textContent = "本页已恢复默认值，保存后生效。";
}

function applyTaskDefaults(state) {
  if (!Number.isSafeInteger(state?.revision) || state.revision < 0 || !state.values || typeof state.values !== "object") {
    throw new Error("服务端返回了无效的下载默认值");
  }
  if (state.revision < taskDefaultsRevision) return;
  taskDefaultsRevision = state.revision;
  downloadSettings = { ...DEFAULT_DOWNLOAD_SETTINGS, ...state.values };
}

async function loadServerTaskDefaults() {
  if (taskDefaultsLoad) return taskDefaultsLoad;
  taskDefaultsLoad = (async () => {
    let state = await requestJSON("/settings/task-defaults");
    let legacy = null;
    try { legacy = localStorage.getItem(DOWNLOAD_DEFAULTS_KEY); } catch { /* Storage may be unavailable. */ }
    if (state.revision === 0 && legacy) {
      try {
        state = await requestJSON("/settings/task-defaults", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 0, values: loadDownloadSettings() }),
        });
      } catch (error) {
        if (error.status !== 409) throw error;
        state = await requestJSON("/settings/task-defaults");
      }
    }
    applyTaskDefaults(state);
    // Keep legacy preferences on a failed import. Clear only after a successful
    // server read/import so another browser cannot overwrite this profile.
    if (legacy && state.revision > 0) {
      try { localStorage.removeItem(DOWNLOAD_DEFAULTS_KEY); } catch { /* Server state is authoritative. */ }
    }
  })().finally(() => { taskDefaultsLoad = null; });
  return taskDefaultsLoad;
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
      maxTries: boundedInt(stored.maxTries, 1, 100, DEFAULT_DOWNLOAD_SETTINGS.maxTries),
      retryWait: boundedInt(stored.retryWait, 1, 3600, DEFAULT_DOWNLOAD_SETTINGS.retryWait),
      proxy: stringValue(stored.proxy),
      proxyMode: ["system", "custom", "none"].includes(stored.proxyMode) ? stored.proxyMode : (stored.proxy ? "custom" : "system"),
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

function renderProxyMode() {
  document.getElementById("cfg-proxy-field").hidden = els.cfgProxyMode.value !== "custom";
  els.cfgProxy.required = els.cfgProxyMode.value === "custom";
}

function renderDownloadSettings(settings = downloadSettings, rules = downloadRules, runtime = runtimeSettings, page = "") {
  if (!page || page === "general") {
    const globalSpeed = displaySpeed(runtime.globalDownloadLimitBps);
    els.cfgFolder.value = settings.folder;
    els.cfgConns.value = settings.connections;
    els.cfgTaskConcurrency.value = runtime.concurrentDownloads;
    els.cfgGlobalSpeed.value = globalSpeed.value || "";
    els.cfgGlobalSpeedUnit.value = String(globalSpeed.unit);
    els.cfgSpeed.value = settings.speed || "";
    els.cfgSpeedUnit.value = String(settings.speedUnit);
  }
  if (!page || page === "network") {
    els.cfgTries.value = settings.maxTries;
    els.cfgWait.value = settings.retryWait;
    els.cfgProxy.value = settings.proxy;
    els.cfgProxyMode.value = settings.proxyMode || (settings.proxy ? "custom" : "system");
    renderProxyMode();
    els.cfgUserAgent.value = settings.userAgent;
    els.cfgReferer.value = settings.referer;
    els.cfgHeaders.value = settings.headers;
  }
  if (!page || page === "files") {
    els.cfgAllocation.value = settings.allocation;
    els.cfgCheckIntegrity.checked = settings.checkIntegrity;
    els.cfgRemoteTime.checked = settings.remoteTime;
    els.cfgDropboxMode.value = rules.dropboxMode;
    els.cfgFilterEnabled.checked = rules.enabled;
    const selected = new Set(rules.excludedExtensions);
    document.querySelectorAll("[data-download-extension]").forEach((input) => {
      input.checked = selected.has(input.value);
    });
  }
  if (!page || page === "advanced") els.cfgExtra.value = settings.extra;
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
    return "BitTorrent 下载需要安装并选择 Aria2 Next。";
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
  await readSettingSnapshot("rules", "/settings/download-rules", (value) => { downloadRules = normalizeServerDownloadRules(value); });
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
  await readSettingSnapshot("runtime", "/settings/runtime", (value) => { runtimeSettings = normalizeServerRuntimeSettings(value); });
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
  await readSettingSnapshot("tracker", "/settings/tracker-research", (value) => { trackerResearchSettings = normalizeTrackerResearchSettings(value); });
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
  await readSettingSnapshot("modules", "/modules", (value) => {
    resolverModules = normalizeResolverModules(value);
    renderResolverModules();
  });
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
		const icon = document.createElement("span");
		icon.className = "module-card-icon";
		icon.setAttribute("aria-hidden", "true");
		icon.innerHTML = iconMarkup(module.id === "google-drive" ? "google-drive" : module.id === "dropbox" ? "dropbox" : "cloud");
		const copy = document.createElement("div");
		copy.className = "module-card-copy";
		const heading = document.createElement("div");
		heading.className = "module-card-heading";
		const name = document.createElement("strong");
		name.textContent = module.name;
		const version = document.createElement("span");
		version.textContent = `v${module.version} · ${module.source === "updated" ? "已更新" : "内置"}`;
		heading.append(name, version);
		const description = document.createElement("p");
		description.textContent = module.id === "google-drive" ? "解析公开文件、文件夹和 Google 文档。"
			: module.id === "dropbox" ? "下载共享文件，或将文件夹展开为独立任务。" : module.description;
		copy.append(heading, description);
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
		if (pendingResolverModuleActions.has(module.id)) {
			actions.querySelectorAll("button").forEach(button => KDComponents.setBusyState(button, true));
		}
		card.append(icon, copy, actions);
		els.moduleList.append(card);
	}
}

async function onModuleAction(event) {
	const button = event.target.closest("button[data-module-toggle], button[data-module-update], button[data-module-reset]");
	if (!button) return;
	const id = button.dataset.moduleToggle || button.dataset.moduleUpdate || button.dataset.moduleReset;
	if (!id || pendingResolverModuleActions.has(id)) return;
	const installed = button.dataset.installed !== "true";
	setResolverModuleBusy(id, true);
	invalidateSettingRead("modules");
	try {
		if (button.dataset.moduleUpdate) {
			await importModuleUpdate(id);
			return;
		}
		if (button.dataset.moduleReset) {
			await resetModuleUpdate(id);
			return;
		}
		const saved = await requestJSON("/modules", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, installed }),
		});
		resolverModules = resolverModules.map((module) => module.id === id
			? { ...module, installed: saved.installed === true } : module);
		renderResolverModules();
		showToast(`${stringValue(saved.name) || id} 模块已${installed ? "启用" : "停用"}。`);
	} catch (error) {
		showToast(`模块状态更新失败：${error.message}`, "error");
	} finally {
		invalidateSettingRead("modules");
		setResolverModuleBusy(id, false);
	}
}

function setResolverModuleBusy(id, busy) {
  if (busy) pendingResolverModuleActions.add(id);
  else pendingResolverModuleActions.delete(id);
  els.moduleList.querySelectorAll("button[data-module-toggle], button[data-module-update], button[data-module-reset]").forEach(button => {
    if ((button.dataset.moduleToggle || button.dataset.moduleUpdate || button.dataset.moduleReset) === id) {
      KDComponents.setBusyState(button, busy);
    }
  });
}

async function importModuleUpdate(id) {
	const file = await chooseModulePackageFile();
	if (!file) return;
	if (file.size <= 0 || file.size > 64 * 1024) {
		showToast("组件更新包必须小于 64 KiB。", "error");
		return;
	}
	invalidateSettingRead("modules");
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
		showToast(`${stringValue(saved.name) || id} v${stringValue(saved.version)} 已热重载。`);
	} catch (error) {
		showToast(`组件更新失败：${error.message}`, "error");
	} finally {
	  invalidateSettingRead("modules");
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

async function resetModuleUpdate(id) {
	const module = resolverModules.find((candidate) => candidate.id === id);
	const confirmed = await confirmAction({
		title: "恢复内置组件基线",
		message: `将删除 ${module?.name || id} 的独立更新包，并立即切换回内置基线。已有下载记录不会被删除。`,
		confirmLabel: "恢复基线",
		danger: true,
	});
	if (!confirmed) return;
	invalidateSettingRead("modules");
	try {
		const saved = await requestJSON(`/modules/package?id=${encodeURIComponent(id)}`, { method: "DELETE" });
		replaceResolverModule(saved);
		renderResolverModules();
		showToast(`${stringValue(saved.name) || id} 已恢复到内置基线。`);
	} catch (error) {
		showToast(`恢复组件基线失败：${error.message}`, "error");
	} finally {
	  invalidateSettingRead("modules");
	}
}

function replaceResolverModule(value) {
	const normalized = normalizeResolverModule(value);
	if (!normalized) return;
	resolverModules = resolverModules.map((module) => module.id === normalized.id ? normalized : module);
}

async function loadSystemUpdateState() {
  await readSettingSnapshot("engine", "/system/update", (value) => {
    systemUpdateState = normalizeSystemUpdateState(value);
    renderSystemUpdateState();
  });
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
      productVersion: stringValue(trueDown.productVersion),
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
      autoUpdate: engine.autoUpdate === true,
      autoUpdateSupported: engine.autoUpdateSupported === true,
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
    ? `${trueDown.productVersion || trueDown.version} · build ${trueDown.build}` : `${trueDown.productVersion || trueDown.version} · 开发构建`;
  let trueDownStatus = trueDown.supported
    ? (trueDown.lastCheckedAt ? "当前已是最新发布版本。" : "尚未检查更新。")
    : "自动更新适用于 Windows 正式桌面安装包。";
  if (trueDown.restartRequired) {
    trueDownStatus = `已验证并暂存 ${trueDown.pendingVersion || `build ${trueDown.pendingBuild}`}。${trueDown.autoUpdate ? "等待任务空闲后自动重启更新。" : "自动更新已关闭，可手动重启更新。"}`;
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
    engineStatus += ` 已准备 ${selected}。${engine.autoUpdate ? "队列空闲后自动切换。" : "可手动选择内核以应用更新。"}`;
  } else if (engine.nextInstalled) {
    engineStatus += ` 已安装 NEXT v${engine.nextInstalledVersion}。${engine.autoUpdate ? "自动检查稳定版更新。" : "自动更新已关闭。"}`;
  } else {
    engineStatus += " 尚未安装 NEXT。";
  }
  if (busy === "next-engine") engineStatus = "正在从 aria2-next 官方 Release 下载、校验并安装 NEXT…";
  if (busy === "engine-switch") engineStatus = "正在保存任务状态并切换下载内核…";
  if (busy === "engine-recovery") engineStatus = "下载内核意外退出，正在自动恢复任务…";
  if (busy === "engine-reload") engineStatus = "内核自动恢复失败，正在重载 TrueDown…";
  els.engineUpdateStatus.textContent = engineStatus;
  els.installNextEngineBtn.textContent = engine.nextInstalled ? "手动更新 NEXT" : "手动安装 NEXT";
  els.installNextEngineBtn.disabled = Boolean(busy) || !engine.autoUpdateSupported;
  const nextToggle = document.getElementById("auto-update-next");
  nextToggle.checked = engine.autoUpdate;
  nextToggle.disabled = !engine.autoUpdateSupported || Boolean(busy);
  KDComponents.setBusyState(els.installNextEngineBtn, busy === "next-engine", { manageDisabled: false });
  els.selectStableEngineBtn.disabled = Boolean(busy) || engine.preference === "stable";
  els.selectStableEngineBtn.setAttribute("aria-pressed", String(engine.preference === "stable"));
  els.selectNextEngineBtn.disabled = Boolean(busy) || !engine.nextInstalled || (engine.preference === "next" && !engine.restartRequired);
  els.selectNextEngineBtn.setAttribute("aria-pressed", String(engine.preference === "next"));
}

async function updateTrueDownAutoUpdate() {
  return saveAutoUpdatePreference(els.autoUpdateTruedown, "autoUpdateTrueDown", "TrueDown");
}

async function updateNextAutoUpdate() {
  return saveAutoUpdatePreference(document.getElementById("auto-update-next"), "autoUpdateNext", "Aria2 Next");
}

async function saveAutoUpdatePreference(control, key, name) {
  updatePreferenceSaving = true;
  const requested = control.checked;
  KDComponents.setBusyState(control, true);
  invalidateSettingRead("engine");
  try {
    systemUpdateState = normalizeSystemUpdateState(await requestJSON("/settings/updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: requested }),
    }));
    renderSystemUpdateState();
    showToast(`${name} 自动更新已${requested ? "启用" : "关闭"}。`);
  } catch (error) {
    showToast(`自动更新设置失败：${error.message}`, "error");
    await reloadSystemUpdateStateQuietly();
  } finally {
    invalidateSettingRead("engine");
    updatePreferenceSaving = false;
    KDComponents.setBusyState(control, false, { manageDisabled: false });
    renderSystemUpdateState();
  }
}

async function checkTrueDownUpdate() {
  setUpdateButtonBusy(els.checkTruedownUpdateBtn, true);
  invalidateSettingRead("engine");
  try {
    systemUpdateState = normalizeSystemUpdateState(await requestJSON("/system/update/check", { method: "POST" }));
    renderSystemUpdateState();
    showToast(systemUpdateState.trueDown.restartRequired
      ? (systemUpdateState.trueDown.autoUpdate ? "新版本已验证，任务空闲时自动重启更新。" : "新版本已验证，可手动重启更新。")
      : "当前已是最新版本。")
  } catch (error) {
    showToast(`检查 TrueDown 更新失败：${error.message}`, "error");
    await reloadSystemUpdateStateQuietly();
  } finally {
    invalidateSettingRead("engine");
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
  invalidateSettingRead("engine");
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
    invalidateSettingRead("engine");
    setUpdateButtonBusy(els.installNextEngineBtn, false);
    renderSystemUpdateState();
  }
}

async function selectDownloadEngine(engine) {
  const button = engine === "next" ? els.selectNextEngineBtn : els.selectStableEngineBtn;
  setUpdateButtonBusy(button, true);
  invalidateSettingRead("engine");
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
    invalidateSettingRead("engine");
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
  await readSettingSnapshot("auth", "/auth/settings", applyAuthSettings);
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
  invalidateSettingRead("auth");
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
    invalidateSettingRead("auth");
    els.tokenAuthEnabled.disabled = tokenAuthManaged;
    KDComponents.setBusyState(els.tokenAuthEnabled, false, { manageDisabled: false });
  }
}

async function copyAPIToken() {
  KDComponents.setBusyState(els.copyApiTokenBtn, true);
  try {
    if (window.__TAURI__?.core?.invoke) {
      const copied = await invokeNative("copy_api_token");
      showToast(copied ? "API Key 已复制，请粘贴到浏览器扩展设置。" : "API Key 认证当前未启用。");
      return;
    }
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
