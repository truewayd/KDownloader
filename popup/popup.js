const STORAGE_VERSION_KEY = "version";
const BACKEND_CONFIG_KEY = "backendConfig";
const GIST_CONFIG_KEY = "gistConfig";
const CREATORS_OVERRIDE_ENABLED_KEY = "creatorsOverrideEnabled";
const GLOBAL_PROGRESS_KEY = "globalProgressSnapshot";

const CREATOR_FETCH_PLACEHOLDER =
    "https://kemono.cr/patreon/user/114514";
const t = (key, substitutions, fallback) => KDI18n.get(key, substitutions, fallback);
KDI18n.localize();
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const fileInput = document.getElementById("file-input");
const loading = document.getElementById("loading");
const loadingLabel = loading?.querySelector("div:last-child");
const successMessage = document.getElementById("success-message");
const errorMessage = document.getElementById("error-message");
const storageUsed = document.getElementById("storage-used");
const creatorUrlInput = document.getElementById("creator-url");
const creatorFetchBtn = document.getElementById("creator-fetch-btn");
const searchCachePanel = document.getElementById("search-cache-panel");
const creatorsUpdateCoomer = document.getElementById("creators-update-coomer");
const creatorsUpdateKemono = document.getElementById("creators-update-kemono");
const gistPanel = document.getElementById("gist-panel");
const gistUploadBtn = document.getElementById("gist-upload-btn");
const gistDownloadBtn = document.getElementById("gist-download-btn");
const globalProgressEl = document.getElementById("global-progress");
const globalProgressFill = document.getElementById("global-progress-fill");
const globalProgressLabel = document.getElementById("global-progress-label");

let backendReady = false;

try {
    const manifest = chrome.runtime.getManifest();
    const verEl = document.getElementById("popup-version");
    if (verEl) verEl.textContent = `v${manifest.version || "?"}`;
} catch (_) { }

function setLoading(show, label = null) {
    if (loading) loading.classList.toggle("active", !!show);
    if (loadingLabel) {
        loadingLabel.textContent = label || t("statusProcessing");
    }
}

function showMessage(el, message) {
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 3000);
}

function showSuccess(message) {
    showMessage(successMessage, message);
}

function showError(message) {
    showMessage(errorMessage, message);
}

function safeSendMessage(message, timeout = 7000, opts = { retries: 1, retryDelay: 300 }) {
    const attempt = () =>
        new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message || "runtime error"));
                        return;
                    }
                    if (!response) {
                        reject(new Error("No response from runtime"));
                        return;
                    }
                    if (response.success === false) {
                        reject(new Error(response.error || "Request failed"));
                        return;
                    }
                    resolve(response);
                });
            } catch (err) {
                reject(err);
            }
        });

    return (async () => {
        let lastErr = null;
        for (let i = 0; i <= (opts.retries || 1); i++) {
            try {
                const pending = attempt();
                if (timeout > 0) {
                    return await Promise.race([
                        pending,
                        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
                    ]);
                }
                return await pending;
            } catch (err) {
                lastErr = err;
                const msg = err && err.message ? err.message : "";
                if (/Receiving end does not exist|The message port closed/i.test(msg) && i < (opts.retries || 1)) {
                    await new Promise((resolve) => setTimeout(resolve, opts.retryDelay || 300));
                    continue;
                }
                break;
            }
        }
        throw lastErr || new Error("safeSendMessage failed");
    })();
}

function openOptionsPage() {
    try {
        chrome.runtime.openOptionsPage();
    } catch (_) {
        chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
    }
}

function setIconButton(button, iconId, label) {
    if (!button) return;

    const svg = button.querySelector("svg.button-icon") || document.createElementNS(SVG_NS, "svg");
    svg.classList.add("button-icon");

    const use = svg.querySelector("use") || document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", `#${iconId}`);
    use.setAttributeNS(XLINK_NS, "href", `#${iconId}`);
    if (!use.parentNode) svg.appendChild(use);

    const labelEl = button.querySelector("span") || document.createElement("span");
    labelEl.textContent = label;
    button.replaceChildren(svg, labelEl);
}

function setCreatorFetchAvailability(config) {
    backendReady = !!(config && config.enabled);
    if (creatorUrlInput && !creatorUrlInput.value) {
        creatorUrlInput.placeholder = backendReady ? CREATOR_FETCH_PLACEHOLDER : t("creatorFetchBackendRequiredPlaceholder");
    }
    if (!creatorFetchBtn) return;
    setIconButton(creatorFetchBtn, backendReady ? "icon-download" : "icon-server", backendReady ? t("creatorFetchAction") : t("settingsAction"));
    creatorFetchBtn.classList.toggle("secondary", !backendReady);
    creatorFetchBtn.title = backendReady ? t("creatorFetchTooltip") : t("openSettingsTooltip");
}

function parseCreatorUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        const host = u.hostname.toLowerCase();
        const parts = u.pathname.split("/").filter(Boolean);

        if ((host === "coomerfans.com" || host.endsWith(".coomerfans.com")) && parts[0] === "u" && parts.length >= 3) {
            return {
                origin: u.origin,
                host,
                service: parts[1].toLowerCase(),
                userId: parts[2],
                creatorName: parts[3] ? decodeURIComponent(parts[3]) : "",
                source: "coomerfans",
            };
        }

        if (parts.length < 3 || parts[1] !== "user") return null;
        return { origin: u.origin, host, service: parts[0], userId: parts[2] };
    } catch (_) {
        return null;
    }
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
    try {
        const creators = await safeSendMessage({ action: "creators.ensureRuleState" }, 3000, { retries: 1, retryDelay: 200 });
        searchCachePanel?.classList.toggle("hidden", !creators.enabled);
    } catch (err) {
        console.warn("[Popup] creators.ensureRuleState failed", err);
        searchCachePanel?.classList.add("hidden");
    }

    try {
        const gist = await safeSendMessage({ action: "gist.getConfig" }, 3000, { retries: 1, retryDelay: 200 });
        gistPanel?.classList.toggle("hidden", !(gist.config && gist.config.enabled));
    } catch (err) {
        console.warn("[Popup] gist.getConfig failed", err);
        gistPanel?.classList.add("hidden");
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
    chrome.tabs.query({ url: ["*://coomer.st/*", "*://kemono.cr/*", "*://coomerfans.com/*"] }, (tabs) => {
        tabs.forEach((tab) => {
            try {
                chrome.tabs.sendMessage(tab.id, { action: "updateUI" });
            } catch (_) { }
        });
    });
}

async function exportData() {
    try {
        setLoading(true);
        const envelope = await safeSendMessage(
            { action: "db.export.begin" },
            8000,
            { retries: 2, retryDelay: 300 }
        );
        const parts = [
            `{"schemaVersion":${envelope.schemaVersion},"exportedAt":${JSON.stringify(envelope.exportedAt)},"records":[`,
        ];
        let firstRecord = true;
        let afterKey = null;
        while (true) {
            const response = await safeSendMessage({
                action: "db.export.page",
                afterKey,
                generation: envelope.generation,
                maxBytes: 4 * 1024 * 1024,
            }, 30000, { retries: 2, retryDelay: 300 });
            const page = response.page;
            if (!page || !Array.isArray(page.records)) throw new Error("Invalid export page response");
            for (const record of page.records) {
                if (!firstRecord) parts.push(",");
                parts.push(JSON.stringify(record));
                firstRecord = false;
            }
            if (page.done) break;
            if (!page.nextKey || page.records.length === 0) throw new Error("Export paging did not advance");
            afterKey = page.nextKey;
        }
        parts.push("]}");
        const blob = new Blob(parts, { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        await chrome.downloads.download({ url, filename: `kemono_history_${timestamp}.json`, saveAs: true });
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        showSuccess(t("historyExported"));
    } catch (err) {
        console.error("[Popup] export failed", err);
        showError(`Export failed: ${err.message}`);
    } finally {
        setLoading(false);
    }
}

async function importData(file) {
    let sessionId = null;
    try {
        setLoading(true);
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

        const beginResponse = await safeSendMessage({
            action: "db.import.begin",
            schemaVersion: parsed.schemaVersion,
            exportedAt: parsed.exportedAt,
            expectedRecords: parsed.records.length,
        }, 15000, { retries: 2, retryDelay: 300 });
        sessionId = beginResponse.sessionId;
        if (!sessionId) throw new Error("Background did not create an import session");

        const maxChunkBytes = 4 * 1024 * 1024;
        let sequence = 0;
        let index = 0;
        while (index < parsed.records.length) {
            const chunk = [];
            let chunkBytes = 2;
            let hash = 2166136261;
            const startIndex = index;
            while (index < parsed.records.length) {
                const record = parsed.records[index];
                const recordText = JSON.stringify(record);
                // Three bytes per UTF-16 code unit is a conservative UTF-8
                // estimate for these mostly-ASCII records and avoids allocating
                // a temporary TextEncoder buffer for every one of 300k items.
                const recordBytes = recordText.length * 3 + 1;
                if (recordBytes > maxChunkBytes) {
                    throw new Error(`History record ${index + 1} is too large to import safely`);
                }
                if (chunk.length > 0 && chunkBytes + recordBytes > maxChunkBytes) break;
                chunk.push(record);
                chunkBytes += recordBytes;
                for (let i = 0; i < recordText.length; i++) {
                    hash ^= recordText.charCodeAt(i);
                    hash = Math.imul(hash, 16777619);
                }
                hash ^= 10;
                hash = Math.imul(hash, 16777619);
                index++;
            }

            try {
                await safeSendMessage({
                    action: "db.import.chunk",
                    sessionId,
                    sequence,
                    digest: (hash >>> 0).toString(16),
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
            setLoading(true, t("historyImportProgress", [index, parsed.records.length]));
        }

        setLoading(true, t("historyImportFinalizing"));
        try {
            await safeSendMessage(
                { action: "db.import.commit", sessionId },
                120000,
                { retries: 2, retryDelay: 500 }
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
        setLoading(false);
    }
}

async function handleCreatorFetchClick() {
    if (!backendReady) {
        openOptionsPage();
        return;
    }

    const urlStr = creatorUrlInput && creatorUrlInput.value && creatorUrlInput.value.trim();
    if (!urlStr) {
        showError(t("creatorUrlRequired"));
        return;
    }

    const parsed = parseCreatorUrl(urlStr);
    if (!parsed) {
        showError(t("creatorUrlInvalid"));
        return;
    }

    try {
        const ack = await safeSendMessage(
            {
                action: "creator.fetch",
                origin: parsed.origin,
                service: parsed.service,
                userId: parsed.userId,
                creatorName: parsed.creatorName,
                source: parsed.source,
            },
            7000,
            { retries: 2, retryDelay: 400 }
        );
        if (!ack || (!ack.accepted && !ack.success)) throw new Error("No ack");
        showSuccess(t("taskAdded"));
        creatorUrlInput.value = "";
        setCreatorFetchAvailability({ enabled: true });
        creatorFetchBtn.disabled = true;
        setTimeout(() => {
            creatorFetchBtn.disabled = false;
        }, 1200);
    } catch (err) {
        console.error("[Popup] creator.fetch failed", err);
        showError(`Creator Fetch failed: ${err.message}`);
    }
}

async function updateCreatorsCache(host) {
    try {
        setLoading(true);
        await safeSendMessage({ action: "creators.updateCache", host }, 5000, { retries: 2, retryDelay: 300 });
        showSuccess(t("cacheRefreshStarted"));
    } catch (err) {
        showError(`Cache failed: ${err.message}`);
    } finally {
        setLoading(false);
    }
}

async function uploadToGist() {
    try {
        setLoading(true);
        await safeSendMessage({ action: "gist.upload" }, 12000, { retries: 2, retryDelay: 300 });
        showSuccess(t("gistUploaded"));
    } catch (err) {
        showError(`Upload failed: ${err.message}`);
    } finally {
        setLoading(false);
    }
}

async function downloadFromGist() {
    try {
        setLoading(true);
        await safeSendMessage({ action: "gist.download" }, 12000, { retries: 2, retryDelay: 300 });
        await loadStats();
        notifyContentUpdate();
        showSuccess(t("gistDownloaded"));
    } catch (err) {
        showError(`Download failed: ${err.message}`);
    } finally {
        setLoading(false);
    }
}

function renderGlobalProgress(total, processed, acked) {
    if (!globalProgressEl || !globalProgressFill || !globalProgressLabel) return;
    total = Number(total || 0);
    processed = Number(processed || 0);
    acked = Number(acked || 0);
    const pct = total > 0 ? Math.round((100 * processed) / Math.max(1, total)) : 0;
    globalProgressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    globalProgressLabel.textContent = total > 0
        ? t("globalProgressActive", [processed, total, acked])
        : t("globalProgressIdle", [acked]);
    globalProgressEl.classList.remove("hidden");
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

exportBtn?.addEventListener("click", exportData);
importBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) await importData(file);
    event.target.value = "";
});
creatorFetchBtn?.addEventListener("click", handleCreatorFetchClick);
creatorsUpdateCoomer?.addEventListener("click", () => updateCreatorsCache("coomer.st"));
creatorsUpdateKemono?.addEventListener("click", () => updateCreatorsCache("kemono.cr"));
gistUploadBtn?.addEventListener("click", uploadToGist);
gistDownloadBtn?.addEventListener("click", downloadFromGist);

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
