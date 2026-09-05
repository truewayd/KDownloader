const STORAGE_VERSION_KEY = "version";
const BACKEND_CONFIG_KEY = "backendConfig";
const GIST_CONFIG_KEY = "gistConfig";
const CREATORS_OVERRIDE_ENABLED_KEY = "creatorsOverrideEnabled";
const GLOBAL_PROGRESS_KEY = "globalProgressSnapshot";
const MAX_HISTORY_FILE_BYTES = 64 * 1024 * 1024;
const exportTextEncoder = new TextEncoder();

const CREATOR_FETCH_PLACEHOLDER =
    "https://kemono.cr/patreon/user/114514";
const PAWCHIVE_DMS_PLACEHOLDER =
    "https://pawchive.pw/patreon/user/114514";
const t = (key, substitutions, fallback) => KDI18n.get(key, substitutions, fallback);
KDI18n.localize();
const safeSendMessage = (...args) => KDUI.sendMessage(...args);

const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const fileInput = document.getElementById("file-input");
const loading = document.getElementById("loading");
const loadingLabel = loading?.querySelector("div:last-child");
const popupToast = KDUI.createToast(document.getElementById("toast"), { duration: 3000 });
const storageUsed = document.getElementById("storage-used");
const creatorUrlInput = document.getElementById("creator-url");
const creatorFetchBtn = document.getElementById("creator-fetch-btn");
const creatorFetchMode = document.getElementById("creator-fetch-mode");
const searchCachePanel = document.getElementById("search-cache-panel");
const creatorsUpdateCoomer = document.getElementById("creators-update-coomer");
const creatorsUpdateKemono = document.getElementById("creators-update-kemono");
const gistPanel = document.getElementById("gist-panel");
const gistUploadBtn = document.getElementById("gist-upload-btn");
const gistDownloadBtn = document.getElementById("gist-download-btn");
const globalProgressEl = document.getElementById("global-progress");
const globalProgressFill = document.getElementById("global-progress-fill");
const globalProgressTrack = document.getElementById("global-progress-track");
const globalProgressLabel = document.getElementById("global-progress-label");
const globalProgress = KDUI.createProgress({
    root: globalProgressEl,
    fill: globalProgressFill,
    track: globalProgressTrack,
    label: globalProgressLabel,
});
const siteSearchForm = document.getElementById("site-search-form");
const siteSearchSite = document.getElementById("site-search-site");
const siteSearchQuery = document.getElementById("site-search-query");

let backendReady = false;
let loadingDepth = 0;
let popupRequestSequence = 0;

try {
    const manifest = chrome.runtime.getManifest();
    const verEl = document.getElementById("popup-version");
    if (verEl) verEl.textContent = `v${manifest.version || "?"}`;
} catch (_) { }

function createPopupRequestId() {
    try {
        const uuid = globalThis.crypto?.randomUUID?.();
        if (uuid) return `popup:${uuid}`;
    } catch (_) { }
    popupRequestSequence += 1;
    return `popup:${Date.now()}:${popupRequestSequence}`;
}

function renderLoading(label = null) {
    if (loading) {
        loading.classList.toggle("is-visible", loadingDepth > 0);
        loading.setAttribute("aria-hidden", String(loadingDepth === 0));
    }
    if (loadingLabel) {
        loadingLabel.textContent = label || t("statusProcessing");
    }
}

function beginLoading(label = null) {
    loadingDepth += 1;
    renderLoading(label);
}

function updateLoading(label = null) {
    if (loadingDepth > 0) renderLoading(label);
}

function endLoading() {
    loadingDepth = Math.max(0, loadingDepth - 1);
    renderLoading();
}

function showSuccess(message) {
    popupToast.show(message, "success");
}

function showError(message) {
    popupToast.show(message, "error");
}

function openOptionsPage() {
    try {
        chrome.runtime.openOptionsPage();
    } catch (_) {
        chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
    }
}

function handleSiteSearch(event) {
    event.preventDefault();
    const url = KDPopupSearch.buildSearchUrl(siteSearchSite?.value, siteSearchQuery?.value);
    if (!url) {
        showError(t("searchQueryRequired"));
        siteSearchQuery?.focus();
        return;
    }
    chrome.tabs.create({ url });
}

function setIconButton(button, iconId, label) {
    KDUI.setIconButton(button, iconId, label, "../shared/icons.svg");
}

function setCreatorFetchAvailability(config) {
    backendReady = !!(config && config.enabled);
    const directMode = creatorFetchMode?.value === "links" || creatorFetchMode?.value === "dms";
    const fetchReady = backendReady || directMode;
    if (creatorUrlInput && !creatorUrlInput.value) {
        const readyPlaceholder = creatorFetchMode?.value === "dms"
            ? PAWCHIVE_DMS_PLACEHOLDER
            : CREATOR_FETCH_PLACEHOLDER;
        creatorUrlInput.placeholder = fetchReady ? readyPlaceholder : t("creatorFetchBackendRequiredPlaceholder");
    }
    if (!creatorFetchBtn) return;
    setIconButton(creatorFetchBtn, fetchReady ? "icon-download" : "icon-server", fetchReady ? t("creatorFetchAction") : t("settingsAction"));
    creatorFetchBtn.classList.toggle("primary", fetchReady);
    creatorFetchBtn.classList.toggle("secondary", !fetchReady);
    creatorFetchBtn.title = fetchReady ? t("creatorFetchTooltip") : t("openSettingsTooltip");
}

async function loadBackendState() {
    try {
        const response = await safeSendMessage({ action: "backend.getConfig" }, 3000, { retries: 1, retryDelay: 200 });
        setCreatorFetchAvailability(response.config);
    } catch (err) {
        console.warn("[Popup] backend.getConfig failed", err);
        setCreatorFetchAvailability(null);
    }
}

async function loadFeatureVisibility() {
    const [creatorsResult, gistResult] = await Promise.allSettled([
        safeSendMessage({ action: "creators.ensureRuleState" }, 3000, { retries: 1, retryDelay: 200 }),
        safeSendMessage({ action: "gist.getConfig" }, 3000, { retries: 1, retryDelay: 200 }),
    ]);
    if (creatorsResult.status === "fulfilled") {
        const creators = creatorsResult.value;
        searchCachePanel?.classList.toggle("kd-hidden", !creators.enabled);
    } else {
        console.warn("[Popup] creators.ensureRuleState failed", creatorsResult.reason);
        searchCachePanel?.classList.add("kd-hidden");
    }

    if (gistResult.status === "fulfilled") {
        const gist = gistResult.value;
        gistPanel?.classList.toggle("kd-hidden", !(gist.config && gist.config.enabled));
    } else {
        console.warn("[Popup] gist.getConfig failed", gistResult.reason);
        gistPanel?.classList.add("kd-hidden");
    }
}

async function loadStats() {
    try {
        const response = await safeSendMessage({ action: "db.stats" }, 10000, { retries: 1, retryDelay: 200 });
        const stats = response.stats || response;
        const bytes = Math.max(0, Number(stats.bytes || 0));
        const records = Math.max(0, Number(stats.records || 0));
        const size = bytes >= 1024 * 1024
            ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
            : `${(bytes / 1024).toFixed(2)} KB`;
        const recordCount = new Intl.NumberFormat().format(records);
        storageUsed.textContent = `${size} · ${recordCount}`;
        storageUsed.title = `${t("historyTitle")}: ${recordCount}`;
    } catch (err) {
        console.warn("[Popup] loadStats failed", err);
        if (storageUsed) storageUsed.textContent = t("statusError");
    }
}

function notifyContentUpdate() {
    chrome.tabs.query({
        url: [
            "https://coomer.st/*",
            "https://*.coomer.st/*",
            "https://kemono.cr/*",
            "https://*.kemono.cr/*",
            "https://coomerfans.com/*",
            "https://*.coomerfans.com/*",
            "https://pawchive.pw/*",
        ],
    }, (tabs) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError || !Array.isArray(tabs)) return;
        tabs.forEach((tab) => {
            if (!Number.isInteger(tab?.id)) return;
            try {
                chrome.tabs.sendMessage(tab.id, { action: "updateUI" }, () => {
                    void chrome.runtime.lastError;
                });
            } catch (_) { }
        });
    });
}

function appendHistoryExportPart(parts, state, text, reservedBytes = 0, knownByteLength = null) {
    const byteLength = knownByteLength ?? exportTextEncoder.encode(text).byteLength;
    if (byteLength > MAX_HISTORY_FILE_BYTES - state.bytes - reservedBytes) {
        throw new Error("History export exceeds the 64 MiB file safety limit");
    }
    state.bytes += byteLength;
    parts.push(text);
}

async function exportData() {
    let objectUrl = null;
    try {
        beginLoading();
        const envelope = await safeSendMessage(
            { action: "db.export.begin" },
            8000,
            { retries: 2, retryDelay: 300 }
        );
        if (envelope.schemaVersion !== 2
            || typeof envelope.exportedAt !== "string"
            || (envelope.revision !== null && typeof envelope.revision !== "string")) {
            throw new Error("Invalid export envelope response");
        }
        const suffix = "]}";
        const suffixBytes = exportTextEncoder.encode(suffix).byteLength;
        const parts = [];
        const exportSize = { bytes: 0 };
        appendHistoryExportPart(
            parts,
            exportSize,
            `{"schemaVersion":${envelope.schemaVersion},"exportedAt":${JSON.stringify(envelope.exportedAt)},"records":[`,
            suffixBytes
        );
        let firstRecord = true;
        let afterKey = null;
        const seenPageKeys = new Set();
        while (true) {
            const response = await safeSendMessage({
                action: "db.export.page",
                afterKey,
                generation: envelope.generation,
                revision: envelope.revision,
                maxBytes: 4 * 1024 * 1024,
            }, 30000, { retries: 2, retryDelay: 300 });
            const page = response.page;
            if (!page || !Array.isArray(page.records)) throw new Error("Invalid export page response");
            if (page.records.length > 0) {
                const pageParts = new Array(page.records.length);
                for (let index = 0; index < page.records.length; index++) {
                    const recordText = JSON.stringify(page.records[index]);
                    if (typeof recordText !== "string") {
                        throw new Error("Invalid export record response");
                    }
                    pageParts[index] = recordText;
                }
                appendHistoryExportPart(
                    parts,
                    exportSize,
                    `${firstRecord ? "" : ","}${pageParts.join(",")}`,
                    suffixBytes
                );
                firstRecord = false;
            }
            if (page.done) break;
            if (!page.nextKey || page.records.length === 0) throw new Error("Export paging did not advance");
            const nextKeyToken = JSON.stringify(page.nextKey);
            if (!nextKeyToken || seenPageKeys.has(nextKeyToken)) {
                throw new Error("Export paging repeated a cursor");
            }
            seenPageKeys.add(nextKeyToken);
            afterKey = page.nextKey;
        }
        appendHistoryExportPart(parts, exportSize, suffix, 0, suffixBytes);
        const blob = new Blob(parts, { type: "application/json" });
        objectUrl = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        await chrome.downloads.download({ url: objectUrl, filename: `kemono_history_${timestamp}.json`, saveAs: true });
        showSuccess(t("historyExported"));
    } catch (err) {
        console.error("[Popup] export failed", err);
        showError(`Export failed: ${err.message}`);
    } finally {
        if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        endLoading();
    }
}

async function importData(file) {
    let sessionId = null;
    try {
        beginLoading();
        if (!file || file.size > 64 * 1024 * 1024) {
            throw new Error("History import file exceeds the 64 MiB safety limit");
        }
        let text = await file.text();
        const parsed = JSON.parse(text);
        text = null;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Invalid file format");
        }
        if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.records) ||
            typeof parsed.exportedAt !== "string") {
            throw new Error("Invalid history schema");
        }
        if (parsed.records.length > 1_000_000) {
            throw new Error("History import exceeds the 1,000,000 record safety limit");
        }

        const beginResponse = await safeSendMessage({
            action: "db.import.begin",
            schemaVersion: parsed.schemaVersion,
            exportedAt: parsed.exportedAt,
            expectedRecords: parsed.records.length,
        }, 15000, { retries: 0, retryDelay: 0 });
        sessionId = beginResponse.sessionId;
        if (!sessionId) throw new Error("Background did not create an import session");

        const maxChunkBytes = 4 * 1024 * 1024;
        let sequence = 0;
        let index = 0;
        while (index < parsed.records.length) {
            const chunk = [];
            let chunkBytes = 2;
            const startIndex = index;
            while (index < parsed.records.length && chunk.length < 5000) {
                const record = parsed.records[index];
                const recordText = JSON.stringify(record);
                if (typeof recordText !== "string") {
                    throw new Error(`History record ${index + 1} is not serializable`);
                }
                // Three bytes per UTF-16 code unit is a conservative UTF-8
                // estimate for these mostly-ASCII records and avoids allocating
                // a temporary TextEncoder buffer for every imported item.
                const recordBytes = recordText.length * 3 + 1;
                if (recordBytes > maxChunkBytes) {
                    throw new Error(`History record ${index + 1} is too large to import safely`);
                }
                if (chunk.length > 0 && chunkBytes + recordBytes > maxChunkBytes) break;
                chunk.push(record);
                chunkBytes += recordBytes;
                index++;
            }

            try {
                await safeSendMessage({
                    action: "db.import.chunk",
                    sessionId,
                    sequence,
                    records: chunk,
                }, 120000, { retries: 2, retryDelay: 300 });
            } catch (chunkError) {
                const statusResponse = await safeSendMessage(
                    { action: "db.import.status", sessionId },
                    30000,
                    { retries: 2, retryDelay: 500 }
                );
                if (Number(statusResponse.status?.receivedRecords || 0) < index) throw chunkError;
            }

            for (let i = startIndex; i < index; i++) parsed.records[i] = null;
            sequence++;
            updateLoading(t("historyImportProgress", [index, parsed.records.length]));
        }

        updateLoading(t("historyImportFinalizing"));
        try {
            await safeSendMessage(
                { action: "db.import.commit", sessionId },
                120000,
                { retries: 0, retryDelay: 0 }
            );
        } catch (commitError) {
            const statusResponse = await safeSendMessage(
                { action: "db.import.status", sessionId },
                30000,
                { retries: 2, retryDelay: 500 }
            );
            if (statusResponse.status?.state !== "committed") throw commitError;
        }
        sessionId = null;
        await loadStats();
        notifyContentUpdate();
        showSuccess(t("historyImported"));
    } catch (err) {
        if (sessionId) {
            safeSendMessage(
                { action: "db.import.abort", sessionId },
                10000,
                { retries: 0, retryDelay: 0 }
            ).catch(() => {});
        }
        console.error("[Popup] import failed", err);
        showError(`Import failed: ${err.message}`);
    } finally {
        endLoading();
    }
}

async function handleCreatorFetchClick() {
    const mode = creatorFetchMode?.value || "default";
    if (!backendReady && mode !== "links" && mode !== "dms") {
        openOptionsPage();
        return;
    }

    const urlStr = creatorUrlInput && creatorUrlInput.value && creatorUrlInput.value.trim();
    if (!urlStr) {
        showError(t("creatorUrlRequired"));
        return;
    }

    const parsed = KDPopupSearch.parseCreatorUrl(urlStr);
    if (!parsed) {
        showError(t("creatorUrlInvalid"));
        return;
    }
    if (mode === "dms" && parsed.host !== "pawchive.pw") {
        showError(t("creatorFetchDmsPawchiveOnly"));
        return;
    }

    try {
        const requestId = createPopupRequestId();
        const ack = await safeSendMessage(
            {
                action: "creator.fetch",
                origin: parsed.origin,
                service: parsed.service,
                userId: parsed.userId,
                creatorName: parsed.creatorName,
                source: parsed.source,
                mode,
                requestId,
            },
            7000,
            { retries: 0, retryDelay: 0 }
        );
        if (!ack || (!ack.accepted && !ack.success)) throw new Error("No ack");
        showSuccess(t("taskAdded"));
        creatorUrlInput.value = "";
        setCreatorFetchAvailability({ enabled: backendReady });
    } catch (err) {
        console.error("[Popup] creator.fetch failed", err);
        showError(`Creator Fetch failed: ${err.message}`);
    }
}

async function updateCreatorsCache(host) {
    try {
        beginLoading();
        await safeSendMessage(
            { action: "creators.updateCache", host, requestId: createPopupRequestId() },
            5000,
            { retries: 0, retryDelay: 0 }
        );
        showSuccess(t("cacheRefreshStarted"));
    } catch (err) {
        showError(`Cache failed: ${err.message}`);
    } finally {
        endLoading();
    }
}

async function uploadToGist() {
    try {
        beginLoading();
        await safeSendMessage({ action: "gist.upload" }, 12000, { retries: 0, retryDelay: 0 });
        showSuccess(t("gistUploaded"));
    } catch (err) {
        showError(`Upload failed: ${err.message}`);
    } finally {
        endLoading();
    }
}

async function downloadFromGist() {
    try {
        beginLoading();
        await safeSendMessage({ action: "gist.download" }, 12000, { retries: 0, retryDelay: 0 });
        await loadStats();
        notifyContentUpdate();
        showSuccess(t("gistDownloaded"));
    } catch (err) {
        showError(`Download failed: ${err.message}`);
    } finally {
        endLoading();
    }
}

function renderGlobalProgress(total, processed, acked) {
    if (!globalProgressEl || !globalProgressFill || !globalProgressLabel) return;
    total = Number(total || 0);
    processed = Number(processed || 0);
    acked = Number(acked || 0);
    if (total <= 0) {
        globalProgress.hide();
        return;
    }
    const pct = total > 0 ? Math.round((100 * processed) / Math.max(1, total)) : 0;
    globalProgress.show({
        value: pct,
        text: t("globalProgressActive", [processed, total, acked]),
    });
}

chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.action) return;
    if (message.action === "globalProgress") {
        renderGlobalProgress(message.total, message.processed, message.acked);
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[BACKEND_CONFIG_KEY]) loadBackendState();
    if (
        (area === "sync" && changes[GIST_CONFIG_KEY]) ||
        (area === "local" && changes[CREATORS_OVERRIDE_ENABLED_KEY])
    ) {
        loadFeatureVisibility();
    }
    if (area === "local" && changes[GLOBAL_PROGRESS_KEY]?.newValue) {
        const snap = changes[GLOBAL_PROGRESS_KEY].newValue;
        renderGlobalProgress(snap.total, snap.processed, snap.acked);
    }
    if (changes[STORAGE_VERSION_KEY]) loadStats();
});

exportBtn?.addEventListener("click", () => KDUI.withBusyButton(exportBtn, exportData));
importBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) await KDUI.withBusyButton(importBtn, () => importData(file));
    event.target.value = "";
});
creatorFetchBtn?.addEventListener("click", () => KDUI.withBusyButton(creatorFetchBtn, handleCreatorFetchClick));
creatorFetchMode?.addEventListener("change", () => setCreatorFetchAvailability({ enabled: backendReady }));
siteSearchForm?.addEventListener("submit", handleSiteSearch);
creatorsUpdateCoomer?.addEventListener("click", () =>
    KDUI.withBusyButton(creatorsUpdateCoomer, () => updateCreatorsCache("coomer.st"))
);
creatorsUpdateKemono?.addEventListener("click", () =>
    KDUI.withBusyButton(creatorsUpdateKemono, () => updateCreatorsCache("kemono.cr"))
);
gistUploadBtn?.addEventListener("click", () => KDUI.withBusyButton(gistUploadBtn, uploadToGist));
gistDownloadBtn?.addEventListener("click", () => KDUI.withBusyButton(gistDownloadBtn, downloadFromGist));

loadStats();
loadBackendState();
loadFeatureVisibility();
safeSendMessage({ action: "status.getGlobalProgress" }, 3000, { retries: 1, retryDelay: 200 })
    .then((response) => {
        if (response && response.progress) {
            renderGlobalProgress(response.progress.total, response.progress.processed, response.progress.acked);
        }
    })
    .catch(() => { });
