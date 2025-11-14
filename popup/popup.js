// popup.js - Popup UI logic (migrated to popup/ folder)

const STORAGE_KEY = 'downloaded';
const STORAGE_VERSION_KEY = 'version';

// Populate version from manifest
try {
    const manifest = chrome.runtime.getManifest();
    const verEl = document.getElementById('popup-version');
    if (verEl) verEl.textContent = `v${manifest.version || '?'}`;
} catch (e) {
    // ignore
}

// Storage helper to centralize chrome.storage.sync access and wrap callbacks as Promises
const storage = {
    get: (keys) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'storage.get', keys }, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
            if (!res) return reject(new Error('No response from background.storage.get'));
            if (!res.success) return reject(new Error(res.error || 'storage.get failed'));
            resolve(res.result);
        });
    }),

    set: (items) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'storage.set', items }, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
            if (!res) return reject(new Error('No response from background.storage.set'));
            if (!res.success) return reject(new Error(res.error || 'storage.set failed'));
            resolve();
        });
    }),

    getBytesInUse: (keys) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'storage.getBytesInUse', keys }, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
            if (!res) return reject(new Error('No response from background.storage.getBytesInUse'));
            if (!res.success) return reject(new Error(res.error || 'storage.getBytesInUse failed'));
            resolve(res.bytes);
        });
    }),

    // proxy for onChanged listener: background will still emit chrome.storage.onChanged, so we can listen locally
    onChangedAddListener: (cb) => chrome.storage.onChanged.addListener(cb),
};

// DOM elements
const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');
const clearBtn = document.getElementById('clear-btn');
const fileInput = document.getElementById('file-input');
const loading = document.getElementById('loading');
const successMessage = document.getElementById('success-message');
const errorMessage = document.getElementById('error-message');
const storageUsed = document.getElementById('storage-used');
// Favorites controls
const favEnabled = document.getElementById('fav-enabled');
const favEnabledLabel = document.getElementById('fav-enabled-label');
const favInterval = document.getElementById('fav-interval');
const favSaveBtn = document.getElementById('fav-save-btn');
const favCheckBtn = document.getElementById('fav-check-btn');
// Backend controls
const backendEnabled = document.getElementById('backend-enabled');
const backendEnabledLabel = document.getElementById('backend-enabled-label');
const backendHost = document.getElementById('backend-host');
const backendPort = document.getElementById('backend-port');
const backendSaveBtn = document.getElementById('backend-save-btn');

// Creators override controls
const creatorsEnabled = document.getElementById('creators-enabled');
const creatorsEnabledLabel = document.getElementById('creators-enabled-label');
const creatorsUpdateCoomer = document.getElementById('creators-update-coomer');
const creatorsLastUpdatedCoomer = document.getElementById('creators-last-updated-coomer');
const creatorsUpdateKemono = document.getElementById('creators-update-kemono');
const creatorsLastUpdatedKemono = document.getElementById('creators-last-updated-kemono');





// Show/hide loading
function setLoading(show) {
    if (!loading) return;
    loading.classList.toggle('active', show);
}

// Show success message
function showSuccess(message) {
    if (!successMessage) return;
    successMessage.textContent = message;
    successMessage.classList.add('show');
    setTimeout(() => {
        successMessage.classList.remove('show');
    }, 3000);
}

// Show error message
function showError(message) {
    if (!errorMessage) return;
    errorMessage.textContent = message;
    errorMessage.classList.add('show');
    setTimeout(() => {
        errorMessage.classList.remove('show');
    }, 3000);
}

// Backend config
async function loadBackendConfig() {
    try {
        const res = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'backend.getConfig' }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from background backend.getConfig'));
                if (!r.success) return reject(new Error(r.error || 'backend.getConfig failed'));
                resolve(r.config);
            });
        });
        backendEnabled.checked = !!res.enabled;
        backendEnabledLabel.textContent = res.enabled ? 'On' : 'Off';
        backendHost.value = res.host || '';
        backendPort.value = res.port || '';

    } catch (e) {
        console.error('[Popup] loadBackendConfig error', e);
    }
}

async function saveBackendConfig() {
    try {
        const config = {
            enabled: !!backendEnabled.checked,
            host: (backendHost.value || '').trim() || '127.0.0.1',
            port: Math.max(1, parseInt(backendPort.value || '15151', 10) || 15151)
        };

        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'backend.setConfig', config }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from backend.setConfig'));
                if (!r.success) return reject(new Error(r.error || 'backend.setConfig failed'));
                resolve();
            });
        });
        backendEnabledLabel.textContent = config.enabled ? 'On' : 'Off';
        showSuccess('✓ Backend saved');
    } catch (e) {
        showError('✗ Save backend failed: ' + e.message);
    }
}


// Load statistics
async function loadStats() {
    try {
        // Calculate storage usage of history in storage.local
        const bytes = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'storageLocal.getBytesInUse', keys: [STORAGE_KEY] }, (res) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!res) return reject(new Error('No response from storageLocal.getBytesInUse'));
                if (!res.success) return reject(new Error(res.error || 'storageLocal.getBytesInUse failed'));
                resolve(res.bytes);
            });
        });
        const kb = (bytes / 1024).toFixed(2);
        const mb = (bytes / (1024 * 1024)).toFixed(2);
        storageUsed.textContent = bytes > 1024 * 1024 ? `${mb} MB` : `${kb} KB`;
    } catch (error) {
        console.error('[Popup] Failed to load stats:', error);
        if (storageUsed) storageUsed.textContent = 'Error';
    }
}

// Export data
async function exportData() {
    try {
        setLoading(true);
        // Request exported JSON from background (single source of truth)
        const jsonString = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'db.export' }, (res) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!res) return reject(new Error('No response from background for db.export'));
                if (!res.success) return reject(new Error(res.error || 'db.export failed'));
                resolve(res.text);
            });
        });
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `kemono_history_${timestamp}.json`;

        await chrome.downloads.download({ url: url, filename: filename, saveAs: true });

        setTimeout(() => URL.revokeObjectURL(url), 60000);

        setLoading(false);
        showSuccess('✓ History exported successfully!');
    } catch (error) {
        setLoading(false);
        showError('✗ Export failed: ' + error.message);
        console.error('[Popup] Export failed:', error);
    }
}

// Import data
async function importData(file) {
    try {
        setLoading(true);

        const text = await file.text();
        const imported = JSON.parse(text);

        // Validate structure
        if (typeof imported !== 'object' || imported === null) {
            throw new Error('Invalid file format');
        }
        // Delegate import to background (single source of truth)
        const ok = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'db.import', text }, (res) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!res) return reject(new Error('No response from background db.import'));
                if (!res.success) return reject(new Error(res.error || 'db.import failed'));
                resolve(true);
            });
        });
        if (!ok) throw new Error('Import failed');

        setLoading(false);
        showSuccess('✓ History imported successfully!');

        // Reload stats
        await loadStats();

        // Notify content scripts to update UI
        chrome.tabs.query({ url: ['*://coomer.st/*', '*://kemono.cr/*'] }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: 'updateUI' }).catch(() => { });
            });
        });
    } catch (error) {
        setLoading(false);
        showError('✗ Import failed: ' + error.message);
        console.error('[Popup] Import failed:', error);
    }
}

// Clear all data
async function clearData() {
    const confirmed = confirm('⚠️ Warning!\n\n' + 'This will permanently delete all download history.\n' + 'This action cannot be undone.\n\n' + 'Are you sure you want to continue?');

    if (!confirmed) return;

    try {
        setLoading(true);
        // Delegate clear to background
        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'db.clear' }, (res) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!res) return reject(new Error('No response from background db.clear'));
                if (!res.success) return reject(new Error(res.error || 'db.clear failed'));
                resolve();
            });
        });

        setLoading(false);
        showSuccess('✓ All history cleared!');

        // Reload stats
        await loadStats();

        // Notify content scripts to update UI
        chrome.tabs.query({ url: ['*://coomer.st/*', '*://kemono.cr/*'] }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: 'updateUI' }).catch(() => { });
            });
        });
    } catch (error) {
        setLoading(false);
        showError('✗ Clear failed: ' + error.message);
        console.error('[Popup] Clear failed:', error);
    }
}

// Event listeners
if (exportBtn) exportBtn.addEventListener('click', exportData);
if (importBtn) importBtn.addEventListener('click', () => fileInput.click());

if (fileInput) fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        await importData(file);
        fileInput.value = ''; // Reset input
    }
});

if (clearBtn) clearBtn.addEventListener('click', clearData);

// Initialize
loadStats();
loadFavoritesConfig();
// (Lazy config removed)
loadBackendConfig();
loadGistConfig();
loadCreatorsState();

// Global progress UI
const globalProgressEl = document.getElementById('global-progress');
const globalProgressFill = document.getElementById('global-progress-fill');
const globalProgressLabel = document.getElementById('global-progress-label');

function renderGlobalProgress(total, processed, acked) {
    if (!globalProgressEl || !globalProgressFill || !globalProgressLabel) return;
    total = Number(total || 0);
    processed = Number(processed || 0);
    acked = Number(acked || 0);
    // Always show the progress header. When no tasks, display 0/0 or Idle.
    const pct = total > 0 ? Math.round(100 * (processed / Math.max(1, total))) : 0;
    globalProgressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    if (total > 0) {
        globalProgressLabel.textContent = `${processed}/${total} sent · ${acked} ACK`;
    } else {
        globalProgressLabel.textContent = `Idle · ${acked} ACK`;
    }
    globalProgressEl.classList.remove('hidden');
}


// request initial global progress when popup opens
(async function initGlobalProgress() {
    try {
        console.debug('[Popup] initGlobalProgress request');
        const r = await safeSendMessage({ action: 'status.getGlobalProgress' }, 3000, { retries: 1, retryDelay: 200 }).catch(() => null);
        console.debug('[Popup] initGlobalProgress response', r);
        if (r && r.success && r.progress) {
            renderGlobalProgress(r.progress.total, r.progress.processed, r.progress.acked);
        } else {
            // fallback: try to read snapshot from storage.local
            chrome.storage.local.get(['globalProgressSnapshot'], (res) => {
                try {
                    const snap = res && res.globalProgressSnapshot ? res.globalProgressSnapshot : null;
                    if (snap && (snap.total || snap.processed)) {
                        renderGlobalProgress(snap.total || 0, snap.processed || 0, snap.acked || 0);
                    }
                } catch (e) { console.warn('[Popup] read globalProgressSnapshot failed', e); }
            });
        }
    } catch (e) { console.warn('[Popup] initGlobalProgress failed', e); }
})();

// Listen for storage changes so popup updates if background wrote a snapshot
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.globalProgressSnapshot && changes.globalProgressSnapshot.newValue) {
        const v = changes.globalProgressSnapshot.newValue;
        renderGlobalProgress(v.total || 0, v.processed || 0, v.acked || 0);
    }
});




// Creator Fetch elements (now nested under ABDM accordion in popup.html)
const creatorUrlInput = document.getElementById('creator-url');
const creatorFetchBtn = document.getElementById('creator-fetch-btn');
const creatorStatus = document.getElementById('creator-status');

// ABDM accordion controls
const abdmAccordion = document.getElementById('abdm-accordion');



// Safe send message helper (robust to service worker cold start)
async function safeSendMessage(message, timeout = 7000, opts = { retries: 1, retryDelay: 300 }) {
    const attempt = () => new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(message, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from runtime')); // treat as error
                resolve(r);
            });
        } catch (e) { reject(e); }
    });

    let lastErr = null;
    for (let i = 0; i <= (opts.retries || 1); i++) {
        try {
            const p = attempt();
            if (typeof timeout === 'number' && timeout > 0) {
                const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout))]);
                return r;
            }
            return await p;
        } catch (e) {
            lastErr = e;
            // retry on specific transient errors
            const msg = (e && e.message) ? e.message : '';
            if (/Receiving end does not exist|The message port closed/i.test(msg) && i < (opts.retries || 1)) {
                await new Promise(r => setTimeout(r, opts.retryDelay || 300));
                continue;
            }
            break;
        }
    }
    throw lastErr || new Error('safeSendMessage failed');
}


// Listen for storage changes
storage.onChangedAddListener((changes, namespace) => {
    // Refresh when our version (sync) increments or the local downloaded key changes
    const hasVersion = !!changes[STORAGE_VERSION_KEY];
    const hasDownloaded = !!changes[STORAGE_KEY];
    if (hasVersion || hasDownloaded) loadStats();
});

// ---------------- Creator Fetch logic ----------------
function parseCreatorUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        const host = u.hostname.toLowerCase();
        // path pattern: /{service}/user/{user}
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length < 3) return null;
        const service = parts[0];
        if (parts[1] !== 'user') return null;
        const userId = parts[2];
        const offset = u.searchParams.get('o') ? Number(u.searchParams.get('o')) : null;
        return { origin: u.origin, host, service, userId, offset };
    } catch (e) { return null; }
}



// Track batch state in popup to support retry and per-task marking
let currentBatchState = null; // { items: [...], total, processed, ackedMap, retried, service, userId }

function resetCreatorStatus() { /* no-op; global progress bar displays status */ }

function updateCreatorStatus(text) { /* intentionally no-op: global progress bar is authoritative */ }


// Local aggregator as a fallback (aggregate downloadProgress if globalProgress not received)
const AGG_MAP = new Map(); // key -> { total, processed }
const AGG_ACK = new Map(); // key -> ackedCount
function aggKey(service, userId) { return `${service}::${userId}`; }
function computeAggTotals() {
    let total = 0, processed = 0, acked = 0;
    for (const v of AGG_MAP.values()) { total += Number(v.total || 0); processed += Number(v.processed || 0); }
    for (const a of AGG_ACK.values()) acked += Number(a || 0);
    return { total, processed, acked };
}

function isResultSuccessful(res) {
    if (!res || !res.success) return false;
    if (res.noFiles === true) return true;
    if (res.backend === true) return true;
    if (res.alreadyDownloaded === true) return true;
    if (typeof res.successCount === 'number' && res.successCount > 0) return true;
    if (Array.isArray(res.results)) {
        return res.results.some(item => item && item.success);
    }
    return false;
}

// Handle runtime messages (progress & completion)
chrome.runtime.onMessage.addListener((message) => {

    if (!message || !message.action) return;

    if (message.action === 'globalProgress') {
        // live update global progress bar
        const total = Number(message.total || 0);
        const processed = Number(message.processed || 0);
        const acked = Number(message.acked || 0);
        console.debug('[Popup] globalProgress received', { total, processed, acked });
        renderGlobalProgress(total, processed, acked);
        return;
    }

    if (message.action === 'downloadProgress' && message.batch) {
        // update local aggregator fallback
        try {
            const srv = message.service || '__unknown__';
            const uid = message.userId || '__unknown__';
            const key = aggKey(srv, uid);
            const t = Number(message.totalCount || 0);
            const p = Number(message.sentCount || 0);
            const prev = AGG_MAP.get(key) || { total: 0, processed: 0 };
            // keep latest numbers (total and processed for that batch)
            prev.total = t;
            prev.processed = p;
            AGG_MAP.set(key, prev);
            const agg = computeAggTotals();
            renderGlobalProgress(agg.total, agg.processed, agg.acked);
        } catch (e) { console.warn('[Popup] aggregate downloadProgress failed', e); }


        if (!currentBatchState) return;
        // match service/user
        if (message.service !== currentBatchState.service || message.userId !== currentBatchState.userId) return;
        currentBatchState.processed = message.sentCount || currentBatchState.processed;
        // if total provided, set it
        if (message.totalCount) currentBatchState.total = message.totalCount;
        updateCreatorStatus(`Sent: ${currentBatchState.processed}/${currentBatchState.total || '?'} | ACKed: ${Object.keys(currentBatchState.ackedMap || {}).length}`);
    }

    if (message.action === 'downloadComplete') {
        const pid = message.postId;
        const res = message.result || {};
        // update aggregator ack counts (only when a file was actually dispatched)
        try {
            const srv = message.service || '__unknown__';
            const uid = message.userId || '__unknown__';
            const key = aggKey(srv, uid);
            if (isResultSuccessful(res)) {
                AGG_ACK.set(key, (AGG_ACK.get(key) || 0) + 1);
            }

            const agg = computeAggTotals();
            renderGlobalProgress(agg.total, agg.processed, agg.acked);
        } catch (e) { console.warn('[Popup] aggregate ACK update failed', e); }


        // If we have an active currentBatchState for this creator, update it as before
        if (!currentBatchState) return;
        if (message.service !== currentBatchState.service || message.userId !== currentBatchState.userId) return;

        if (isResultSuccessful(res)) {
            currentBatchState.ackedMap[pid] = true;
            // mark downloaded in DB immediately
            try { chrome.runtime.sendMessage({ action: 'db.markDownloaded', service: message.service, userId: message.userId, postId: pid }); } catch (e) { }
        }


        // update status
        updateCreatorStatus(`Sent: ${currentBatchState.processed}/${currentBatchState.total || '?'} | ACKed: ${Object.keys(currentBatchState.ackedMap || {}).length}`);

        // if processed reached total, handle retry of unacked once
        if (currentBatchState.total && currentBatchState.processed >= currentBatchState.total) {
            const unacked = currentBatchState.items.filter(it => !currentBatchState.ackedMap[it.postId]);
            if (unacked.length > 0 && !currentBatchState.retried) {
                currentBatchState.retried = true;
                updateCreatorStatus(`Retrying ${unacked.length} unacked tasks...`);
                // resend once
                safeSendMessage({ action: 'startDownloadBatch', items: unacked }, 7000, { retries: 2, retryDelay: 400 }).then(ack => {
                    if (ack && ack.accepted) {
                        // merge items (they may overlap) and keep existing ack map
                        currentBatchState.items = currentBatchState.items.concat(unacked);
                        currentBatchState.total += unacked.length;
                        updateCreatorStatus(`Retry sent: ${Object.keys(currentBatchState.ackedMap).length}/${currentBatchState.total}`);
                    }
                }).catch(err => {
                    console.warn('[Popup] retry send failed', err);
                    updateCreatorStatus(`Retry failed: ${err && err.message ? err.message : err}`);
                });
            } else {
                updateCreatorStatus(`Completed. ACKed: ${Object.keys(currentBatchState.ackedMap || {}).length}/${currentBatchState.total}`);
                // finalize and reset state after short delay
                setTimeout(() => { currentBatchState = null; resetCreatorStatus(); }, 5000);
            }
        }
    }

});



// Creators override handlers
async function loadCreatorsState() {
    try {
        chrome.storage.local.get(['creatorsOverrideEnabled', 'creatorsOverride_coomer.st_meta', 'creatorsOverride_kemono.cr_meta'], (res) => {
            try {
                const coomer = res && res['creatorsOverride_coomer.st_meta'] ? res['creatorsOverride_coomer.st_meta'] : null;
                const kemono = res && res['creatorsOverride_kemono.cr_meta'] ? res['creatorsOverride_kemono.cr_meta'] : null;
                if (coomer && coomer.updatedAt) creatorsLastUpdatedCoomer.textContent = new Date(coomer.updatedAt).toLocaleString(); else creatorsLastUpdatedCoomer.textContent = 'Never';
                if (kemono && kemono.updatedAt) creatorsLastUpdatedKemono.textContent = new Date(kemono.updatedAt).toLocaleString(); else creatorsLastUpdatedKemono.textContent = 'Never';
                const enabled = !!res['creatorsOverrideEnabled'];
                creatorsEnabled.checked = enabled;
                creatorsEnabledLabel.textContent = enabled ? 'On' : 'Off';
            } catch (e) {
                console.error('[Popup] loadCreatorsState parse error', e);
                creatorsLastUpdatedCoomer.textContent = 'Error';
                creatorsLastUpdatedKemono.textContent = 'Error';
                creatorsEnabled.checked = false;
                creatorsEnabledLabel.textContent = 'Off';
            }
        });
    } catch (e) {
        console.error('[Popup] loadCreatorsState error', e);
        creatorsLastUpdatedCoomer.textContent = 'Error';
        creatorsLastUpdatedKemono.textContent = 'Error';
        creatorsEnabled.checked = false;
        creatorsEnabledLabel.textContent = 'Off';
    }
}

// Creator Fetch button handlers
async function handleCreatorFetchClick() {
    try {
        updateCreatorStatus('Preparing...');
        const urlStr = creatorUrlInput && creatorUrlInput.value && creatorUrlInput.value.trim();
        if (!urlStr) return updateCreatorStatus('Please enter a creator URL');
        const parsed = parseCreatorUrl(urlStr);
        if (!parsed) return updateCreatorStatus('Invalid creator URL');

        // ensure backend configured
        const backendCfg = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'backend.getConfig' }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from backend.getConfig'));
                if (!r.success) return reject(new Error(r.error || 'backend.getConfig failed'));
                resolve(r.config);
            });
        });
        if (!backendCfg.enabled) return updateCreatorStatus('Please configure and enable backend first');

        // delegate fetch + dispatch to background to centralize paging/concurrency
        currentBatchState = { items: [], total: 0, processed: 0, ackedMap: {}, service: parsed.service, userId: parsed.userId, retried: false };
        const ack = await safeSendMessage({ action: 'creator.fetch', origin: parsed.origin, service: parsed.service, userId: parsed.userId }, 7000, { retries: 2, retryDelay: 400 });
        if (ack && (ack.accepted || ack.success)) {
            // show success and clear input to avoid duplicate submissions
            showSuccess('✓ Task added');
            try { creatorUrlInput.value = ''; creatorUrlInput.blur(); } catch (e) { }
            // briefly disable button to avoid accidental double clicks
            try { creatorFetchBtn.disabled = true; setTimeout(() => { creatorFetchBtn.disabled = false; }, 1200); } catch (e) { }
            // keep global progress reliance; no per-creator text shown here
        } else {
            updateCreatorStatus('Failed to dispatch request');
            currentBatchState = null;
        }

    } catch (e) {
        console.error('[Popup] handleCreatorFetchClick error', e);
        updateCreatorStatus('Error: ' + (e && e.message ? e.message : String(e)));
    }
}

// attach handler
if (creatorFetchBtn) creatorFetchBtn.addEventListener('click', handleCreatorFetchClick);

// Accordion behaviour: toggle expand/collapse
function enableAccordion(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const header = el.querySelector('.accordion-header');
    if (!header) return;
    header.addEventListener('click', () => {
        const expanded = el.getAttribute('aria-expanded') === 'true';
        el.setAttribute('aria-expanded', String(!expanded));
    });
    header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.click(); }
    });
}

enableAccordion('abdm-accordion');
enableAccordion('creators-accordion');
enableAccordion('gist-accordion');








async function updateCreatorsCache(host) {
    try {
        setLoading(true);
        // robust send: retry once on service worker cold start/port closed
        const sendOnce = () => new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage({ action: 'creators.updateCache', host }, (r) => {
                    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                    if (!r) return reject(new Error('No response from creators.updateCache'));
                    if (!r.success) return reject(new Error(r.error || 'creators.updateCache failed'));
                    resolve();
                });
            } catch (e) { reject(e); }
        });
        try {
            await sendOnce();
        } catch (err) {
            const msg = (err && err.message) ? err.message : '';
            if (/Receiving end does not exist|The message port closed/i.test(msg)) {
                await new Promise(r => setTimeout(r, 300));
                await sendOnce();
            } else {
                throw err;
            }
        }
        // reload state from storage to get updatedAt
        await loadCreatorsState();
        showSuccess('✓ Creators cache updated');
    } catch (e) {
        showError('✗ Update failed: ' + (e && e.message ? e.message : String(e)));
        console.error('[Popup] updateCreatorsCache error', e);
    } finally {
        setLoading(false);
    }
}



async function setCreatorsEnabled(enabled) {
    try {
        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'creators.setEnabled', enabled }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from creators.setEnabled'));
                if (!r.success) return reject(new Error(r.error || 'creators.setEnabled failed'));
                resolve();
            });
        });
        creatorsEnabledLabel.textContent = enabled ? 'On' : 'Off';
        showSuccess(enabled ? '✓ Creators override enabled' : '✓ Creators override disabled');
    } catch (e) {
        showError('✗ Save failed: ' + (e && e.message ? e.message : String(e)));
    }
}

if (creatorsUpdateCoomer) creatorsUpdateCoomer.addEventListener('click', () => updateCreatorsCache('coomer.st'));
if (creatorsUpdateKemono) creatorsUpdateKemono.addEventListener('click', () => updateCreatorsCache('kemono.cr'));
if (creatorsEnabled) creatorsEnabled.addEventListener('change', () => setCreatorsEnabled(!!creatorsEnabled.checked));


console.log('[Popup] Initialized');

// ----- Favorites Watcher integration -----
async function loadFavoritesConfig() {
    try {
        const res = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'favorites.getConfig' }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from background favorites.getConfig'));
                if (!r.success) return reject(new Error(r.error || 'favorites.getConfig failed'));
                resolve(r.config);
            });
        });
        favEnabled.checked = !!res.enabled;
        favEnabledLabel.textContent = res.enabled ? 'On' : 'Off';
        // Always retrieve all creators (maxCreators no longer supported)
        favInterval.value = Number.isFinite(res.intervalMinutes) ? res.intervalMinutes : 360;
    } catch (e) {
        console.error('[Popup] loadFavoritesConfig error', e);
    }
}

async function saveFavoritesConfig() {
    try {
        const config = {
            enabled: !!favEnabled.checked,
            // maxCreators removed: always consider all downloaded creators
            intervalMinutes: Math.max(1, parseInt(favInterval.value || '360', 10) || 360)
        };

        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'favorites.setConfig', config }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from favorites.setConfig'));
                if (!r.success) return reject(new Error(r.error || 'favorites.setConfig failed'));
                resolve();
            });
        });
        favEnabledLabel.textContent = config.enabled ? 'On' : 'Off';
        showSuccess('✓ Settings saved');
    } catch (e) {
        showError('✗ Save failed: ' + e.message);
    }
}

async function manualFavoritesCheck() {
    try {
        setLoading(true);
        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'favorites.forceCheck' }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from favorites.forceCheck'));
                if (!r.success) return reject(new Error(r.error || 'favorites.forceCheck failed'));
                resolve();
            });
        });
        setLoading(false);
        showSuccess('✓ Check triggered');
    } catch (e) {
        setLoading(false);
        showError('✗ Check failed: ' + e.message);
    }
}

if (favEnabled) favEnabled.addEventListener('change', () => favEnabledLabel.textContent = favEnabled.checked ? 'On' : 'Off');

if (favSaveBtn) favSaveBtn.addEventListener('click', saveFavoritesConfig);
if (favCheckBtn) favCheckBtn.addEventListener('click', manualFavoritesCheck);

// (Lazy Download integration removed)
if (backendSaveBtn) backendSaveBtn.addEventListener('click', saveBackendConfig);

if (backendEnabled) backendEnabled.addEventListener('change', () => backendEnabledLabel.textContent = backendEnabled.checked ? 'On' : 'Off');

// ---- Gist Sync ----
const gistTokenInput = document.getElementById('gist-token');
const gistIdInput = document.getElementById('gist-id');
const gistUploadBtn = document.getElementById('gist-upload-btn');
const gistDownloadBtn = document.getElementById('gist-download-btn');


async function loadGistConfig() {
    try {
        const res = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'gist.getConfig' }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from gist.getConfig'));
                if (!r.success) return reject(new Error(r.error || 'gist.getConfig failed'));
                resolve(r.config);
            });
        });
        if (gistTokenInput) gistTokenInput.value = res.token || '';
        if (gistIdInput) gistIdInput.value = res.gistId || '';
    } catch (e) {
        console.error('[Popup] loadGistConfig error', e);
    }
}

async function saveGistConfig() {
    try {
        const cfg = {
            token: (gistTokenInput?.value || '').trim(),
            gistId: (gistIdInput?.value || '').trim()
        };
        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'gist.setConfig', config: cfg }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from gist.setConfig'));
                if (!r.success) return reject(new Error(r.error || 'gist.setConfig failed'));
                resolve();
            });
        });
        showSuccess('✓ Gist config saved');
    } catch (e) {
        showError('✗ Save Gist config failed: ' + e.message);
    }
}

async function uploadToGist() {
    try {
        setLoading(true);
        await saveGistConfig();
        const res = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'gist.upload' }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from gist.upload'));
                if (!r.success) return reject(new Error(r.error || 'gist.upload failed'));
                resolve(r.result);
            });
        });
        if (res && res.gistId && gistIdInput) gistIdInput.value = res.gistId;
        setLoading(false);
        showSuccess('✓ Uploaded to Gist');
    } catch (e) {
        setLoading(false);
        showError('✗ Upload failed: ' + e.message);
    }
}

async function downloadFromGist() {
    try {
        setLoading(true);
        await saveGistConfig();
        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'gist.download' }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if (!r) return reject(new Error('No response from gist.download'));
                if (!r.success) return reject(new Error(r.error || 'gist.download failed'));
                resolve();
            });
        });
        setLoading(false);
        showSuccess('✓ Downloaded from Gist');
        await loadStats();
        chrome.tabs.query({ url: ['*://coomer.st/*', '*://kemono.cr/*'] }, (tabs) => {
            tabs.forEach(tab => {
                try { chrome.tabs.sendMessage(tab.id, { action: 'updateUI' }); } catch (_) { }
            });
        });
    } catch (e) {
        setLoading(false);
        showError('✗ Download failed: ' + e.message);
    }
}

if (gistUploadBtn) gistUploadBtn.addEventListener('click', uploadToGist);
if (gistDownloadBtn) gistDownloadBtn.addEventListener('click', downloadFromGist);
