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

// Listen for storage changes
storage.onChangedAddListener((changes, namespace) => {
    // Refresh when our version (sync) increments or the local downloaded key changes
    const hasVersion = !!changes[STORAGE_VERSION_KEY];
    const hasDownloaded = !!changes[STORAGE_KEY];
    if (hasVersion || hasDownloaded) loadStats();
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
