// background/messages.js - message router and RPC handlers
import { API } from './constants.js';
import UTIL from './util.js';
import { loadFavoritesConfig, saveFavoritesConfig, loadBackendConfig, saveBackendConfig, loadGistConfig, saveGistConfig } from './config.js';
import { loadDB, saveDB, checkDownloaded, markDownloaded, markMultipleDownloaded, exportDB, importDB, setLastAccess } from './db.js';
import { handleAPIRequest, getCookies } from './network.js';
import { startFullDownload } from './download.js';
import { gistUpload, gistDownload } from './gist.js';
import { setCreatorsOverrideEnabled, updateCacheFromNetwork, getCachedCreators, ensureRuleState } from './creators.js';

export function registerMessageHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (!message || !message.action) return false;

      switch (message.action) {
        case 'favorites.getConfig':
          loadFavoritesConfig().then(cfg => sendResponse({ success: true, config: cfg })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'favorites.setConfig':
          saveFavoritesConfig(message.config || {}).then(cfg => sendResponse({ success: true, config: cfg })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'favorites.forceCheck':
          (async () => { try { await runFavoritesCheck(); sendResponse({ success: true }); } catch (e) { sendResponse({ success: false, error: e.message }); } })();
          return true;
        case 'creator.recordAccess':
          (async () => { try { await setLastAccess(message.service, message.userId, message.when ? new Date(message.when) : new Date()); sendResponse({ success: true }); } catch (e) { sendResponse({ success: false, error: e.message }); } })();
          return true;

        case 'backend.getConfig':
          loadBackendConfig().then(cfg => sendResponse({ success: true, config: cfg })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'backend.setConfig':
          saveBackendConfig(message.config || {}).then(cfg => sendResponse({ success: true, config: cfg })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;

        case 'gist.getConfig':
          loadGistConfig().then(cfg => sendResponse({ success: true, config: cfg })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'gist.setConfig':
          saveGistConfig(message.config || {}).then(cfg => sendResponse({ success: true, config: cfg })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'gist.upload':
          gistUpload().then(res => sendResponse({ success: true, result: res })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'gist.download':
          gistDownload().then(res => sendResponse({ success: true, result: res })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;

        case 'fetchAPI':
          handleAPIRequest(message.url, message.headers).then(data => sendResponse({ success: true, data })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'getCookies':
          getCookies(message.domain).then(c => sendResponse({ success: true, cookies: c })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;

        case 'checkDownloaded':
          checkDownloaded(message.service, message.userId, message.postId).then(d => sendResponse({ success: true, downloaded: d })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;

        case 'startDownload':
          try { sendResponse({ success: true, accepted: true }); } catch (e) { }
          (async () => {
            try {
              const tabId = sender && sender.tab && sender.tab.id ? sender.tab.id : undefined;
              const r = await startFullDownload(message.service, message.userId, message.postId, message.path, sender && sender.tab && sender.tab.url ? sender.tab.url : undefined, tabId);
              try {
                const shouldMark = r && r.success && (r.backend === true || (typeof r.successCount === 'number' && r.successCount > 0));
                if (shouldMark) { try { await markDownloaded(message.service, message.userId, message.postId); } catch (e) { console.warn('[Background] markDownloaded failed', e); } }
              } catch (e) { }
              const payload = { action: 'downloadComplete', service: message.service, userId: message.userId, postId: message.postId, result: r };
              try { if (tabId) chrome.tabs.sendMessage(tabId, payload, () => { }); else chrome.runtime.sendMessage(payload, () => { }); } catch (e) { }
            } catch (err) {
              const payload = { action: 'downloadComplete', service: message.service, userId: message.userId, postId: message.postId, result: { success: false, error: err && err.message ? err.message : String(err) } };
              try { const tabId = sender && sender.tab && sender.tab.id ? sender.tab.id : undefined; if (tabId) chrome.tabs.sendMessage(tabId, payload, () => { }); else chrome.runtime.sendMessage(payload, () => { }); } catch (e) { }
            }
          })();
          return false;

        case 'startDownloadBatch':
          try { sendResponse({ success: true, accepted: true }); } catch (e) { }
          (async () => {
            const items = Array.isArray(message.items) ? message.items : [];
            const tabId = sender && sender.tab && sender.tab.id ? sender.tab.id : undefined;
            const total = items.length;
            let processed = 0;
            const succeeded = [];
            for (const it of items) {
              try {
                const res = await startFullDownload(it.service, it.userId, it.postId, it.path, sender && sender.tab && sender.tab.url ? sender.tab.url : undefined, tabId);
                const payload = { action: 'downloadComplete', service: it.service, userId: it.userId, postId: it.postId, result: res };
                try { if (tabId) chrome.tabs.sendMessage(tabId, payload, () => { }); else chrome.runtime.sendMessage(payload, () => { }); } catch (e) { }
                if (res && res.success && (res.backend === true || (typeof res.successCount === 'number' && res.successCount > 0))) succeeded.push({ service: it.service, userId: it.userId, postId: it.postId });
              } catch (e) {
                const payload = { action: 'downloadComplete', service: it.service, userId: it.userId, postId: it.postId, result: { success: false, error: e && e.message ? e.message : String(e) } };
                try { if (tabId) chrome.tabs.sendMessage(tabId, payload, () => { }); else chrome.runtime.sendMessage(payload, () => { }); } catch (ee) { }
              }
              processed++;
              const batchProgress = { action: 'downloadProgress', batch: true, service: items[0] && items[0].service, userId: items[0] && items[0].userId, sentCount: processed, totalCount: total, progress: Math.round(100 * processed / Math.max(1, total)) };
              try { if (tabId) chrome.tabs.sendMessage(tabId, batchProgress, () => { }); else chrome.runtime.sendMessage(batchProgress, () => { }); } catch (e) { }
              await new Promise(r => setTimeout(r, 200));
            }
            if (succeeded.length > 0) { try { await markMultipleDownloaded(succeeded); } catch (e) { console.warn('[Background] markMultipleDownloaded failed', e); } }
          })();
          return false;

        case 'util.extractExternalLinks':
          try { const links = UTIL.extractExternalLinks(message.content); sendResponse({ success: true, links }); } catch (e) { sendResponse({ success: false, error: e.message }); }
          return true;
        case 'util.sanitizeFileName':
          try { const name = UTIL.sanitizeFileName(message.name); sendResponse({ success: true, name }); } catch (e) { sendResponse({ success: false, error: e.message }); }
          return true;
        case 'util.getFileExtension':
          try { const ext = UTIL.getFileExtension(message.path); sendResponse({ success: true, ext }); } catch (e) { sendResponse({ success: false, error: e.message }); }
          return true;
        case 'util.buildDownloadTasks':
          try { const tasks = UTIL.buildDownloadTasks(message.postData, message.title, message.baseUrl); sendResponse({ success: true, tasks }); } catch (e) { sendResponse({ success: false, error: e.message }); }
          return true;

        case 'creators.getCached':
          (async () => { try { const c = await getCachedCreators(message.host); sendResponse({ success: true, cached: c }); } catch (e) { sendResponse({ success: false, error: e.message }); } })();
          return true;
        case 'creators.getSummary':
          (async () => {
            try {
              // return small metadata (updatedAt) for hosts to avoid shipping large payloads
              if (message && message.host) {
                const meta = await chrome.storage.local.get(`creatorsOverride_${message.host}_meta`);
                const item = meta && meta[`creatorsOverride_${message.host}_meta`] ? meta[`creatorsOverride_${message.host}_meta`] : null;
                sendResponse({ success: true, summary: item ? { updatedAt: item.updatedAt, sourceHost: item.sourceHost } : null });
              } else {
                const map = {};
                for (const h of API.HOSTS) {
                  const meta = await chrome.storage.local.get(`creatorsOverride_${h}_meta`);
                  const item = meta && meta[`creatorsOverride_${h}_meta`] ? meta[`creatorsOverride_${h}_meta`] : null;
                  map[h] = item ? { updatedAt: item.updatedAt, sourceHost: item.sourceHost } : null;
                }
                sendResponse({ success: true, summary: map });
              }
            } catch (e) { sendResponse({ success: false, error: e.message }); }
          })();
          return true;
        case 'creators.updateCache':
          try {
            // accept request immediately and perform cache update asynchronously to avoid sending large payloads back to popup
            try { sendResponse({ success: true, accepted: true }); } catch (e) { }
            (async () => {
              try {
                console.log('[Background] creators.updateCache', message.host);
                await updateCacheFromNetwork(message.host);
                console.log('[Background] creators.updateCache done', message.host);
              } catch (e) {
                console.error('[Background] creators.updateCache failed', message.host, e);
              }
            })();
          } catch (e) {
            try { sendResponse({ success: false, error: e.message }); } catch (ee) { }
          }
          return false;
        case 'creators.setEnabled':
          (async () => { try { await setCreatorsOverrideEnabled(!!message.enabled); sendResponse({ success: true }); } catch (e) { sendResponse({ success: false, error: e.message }); } })();
          return true;
        case 'creators.ensureRuleState':
          (async () => { try { await ensureRuleState(); sendResponse({ success: true }); } catch (e) { sendResponse({ success: false, error: e.message }); } })();
          return true;

        case 'storage.get':
          chrome.storage.sync.get(message.keys, (res) => { if (chrome.runtime.lastError) return sendResponse({ success: false, error: chrome.runtime.lastError.message }); sendResponse({ success: true, result: res }); });
          return true;
        case 'storage.set':
          chrome.storage.sync.set(message.items, () => { if (chrome.runtime.lastError) return sendResponse({ success: false, error: chrome.runtime.lastError.message }); sendResponse({ success: true }); });
          return true;
        case 'storage.getBytesInUse':
          chrome.storage.sync.getBytesInUse(message.keys, (b) => { if (chrome.runtime.lastError) return sendResponse({ success: false, error: chrome.runtime.lastError.message }); sendResponse({ success: true, bytes: b }); });
          return true;
        case 'storageLocal.getBytesInUse':
          chrome.storage.local.getBytesInUse(message.keys, (b) => { if (chrome.runtime.lastError) return sendResponse({ success: false, error: chrome.runtime.lastError.message }); sendResponse({ success: true, bytes: b }); });
          return true;

        case 'db.load':
          loadDB().then(db => sendResponse({ success: true, db })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'db.save':
          chrome.storage.local.set({ [STORAGE_KEY]: message.data }, () => {
            if (chrome.runtime.lastError) return sendResponse({ success: false, error: chrome.runtime.lastError.message });
            chrome.storage.sync.get(STORAGE_VERSION_KEY, (res) => { const v = (res[STORAGE_VERSION_KEY] || 0) + 1; chrome.storage.sync.set({ [STORAGE_VERSION_KEY]: v }, () => sendResponse({ success: true })); });
          });
          return true;
        case 'db.checkDownloaded':
          checkDownloaded(message.service, message.userId, message.postId).then(downloaded => sendResponse({ success: true, downloaded })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'db.markDownloaded':
          markDownloaded(message.service, message.userId, message.postId).then(() => sendResponse({ success: true })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'db.markMultiple':
          (async () => { try { await markMultipleDownloaded(message.items); sendResponse({ success: true }); } catch (e) { sendResponse({ success: false, error: e.message }); } })();
          return true;
        case 'db.export':
          exportDB().then(text => sendResponse({ success: true, text })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'db.import':
          importDB(message.text).then(ok => sendResponse({ success: ok })).catch(err => sendResponse({ success: false, error: err.message }));
          return true;
        case 'db.clear':
          (async () => { try { await chrome.storage.local.set({ [STORAGE_KEY]: {} }); await chrome.storage.sync.set({ [STORAGE_VERSION_KEY]: 0 }); sendResponse({ success: true }); } catch (e) { sendResponse({ success: false, error: e.message }); } })();
          return true;

        default:
          return false;
      }
    } catch (e) {
      console.error('[Background] onMessage error', e);
      try { sendResponse({ success: false, error: e && e.message ? e.message : String(e) }); } catch (er) { }
      return true;
    }
  });
}

// Favorites watcher helper will be injected by favorites.js (if present)
export async function runFavoritesCheck() { /* implemented in favorites.js */ }
