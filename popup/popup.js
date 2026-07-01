const STORAGE_KEY = "downloaded";
const COOMERFANS_STORAGE_KEY = "coomerfansDownloaded";
const STORAGE_VERSION_KEY = "version";
const BACKEND_CONFIG_KEY = "backendConfig";
const GIST_CONFIG_KEY = "gistConfig";
const CREATORS_OVERRIDE_ENABLED_KEY = "creatorsOverrideEnabled";
const GLOBAL_PROGRESS_KEY = "globalProgressSnapshot";

const CREATOR_FETCH_PLACEHOLDER =
    "https://kemono.cr/patreon/user/114514";
const CREATOR_FETCH_BACKEND_PLACEHOLDER = "Configure and enable backend first";

const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const fileInput = document.getElementById("file-input");
const loading = document.getElementById("loading");
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

function setLoading(show) {
    if (loading) loading.classList.toggle("active", !!show);
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

function setCreatorFetchAvailability(config) {
    backendReady = !!(config && config.enabled);
    if (creatorUrlInput && !creatorUrlInput.value) {
        creatorUrlInput.placeholder = backendReady ? CREATOR_FETCH_PLACEHOLDER : CREATOR_FETCH_BACKEND_PLACEHOLDER;
    }
    if (!creatorFetchBtn) return;
    creatorFetchBtn.textContent = backendReady ? "Creator Fetch" : "Settings";
    creatorFetchBtn.classList.toggle("secondary", !backendReady);
    creatorFetchBtn.title = backendReady ? "Fetch creator posts" : "Open advanced settings";
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
        const response = await safeSendMessage(
            { action: "storageLocal.getBytesInUse", keys: [STORAGE_KEY, COOMERFANS_STORAGE_KEY] },
            3000,
            { retries: 1, retryDelay: 200 }
        );
        const bytes = Number(response.bytes || 0);
        storageUsed.textContent =
            bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${(bytes / 1024).toFixed(2)} KB`;
    } catch (err) {
        console.warn("[Popup] loadStats failed", err);
        if (storageUsed) storageUsed.textContent = "Error";
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
        const response = await safeSendMessage({ action: "db.export" }, 8000, { retries: 2, retryDelay: 300 });
        const blob = new Blob([response.text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        await chrome.downloads.download({ url, filename: `kemono_history_${timestamp}.json`, saveAs: true });
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        showSuccess("History exported");
    } catch (err) {
        console.error("[Popup] export failed", err);
        showError(`Export failed: ${err.message}`);
    } finally {
        setLoading(false);
    }
}

async function importData(file) {
    try {
        setLoading(true);
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") throw new Error("Invalid file format");
        await safeSendMessage({ action: "db.import", text }, 10000, { retries: 2, retryDelay: 300 });
        await loadStats();
        notifyContentUpdate();
        showSuccess("History imported");
    } catch (err) {
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
        showError("Please enter a creator URL");
        return;
    }

    const parsed = parseCreatorUrl(urlStr);
    if (!parsed) {
        showError("Invalid creator URL");
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
        showSuccess("Task added");
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
        showSuccess("Cache refresh started");
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
        showSuccess("Uploaded to Gist");
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
        showSuccess("Downloaded from Gist");
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
    globalProgressLabel.textContent = total > 0 ? `${processed}/${total} sent · ${acked} ACK` : `Idle · ${acked} ACK`;
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
    if (changes[STORAGE_VERSION_KEY] || changes[STORAGE_KEY] || changes[COOMERFANS_STORAGE_KEY]) loadStats();
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
