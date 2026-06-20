// background/messages.js - message router and RPC handlers
import { API } from "./constants.js";
import UTIL from "./util.js";
import {
  loadFavoritesConfig,
  saveFavoritesConfig,
  loadBackendConfig,
  saveBackendConfig,
  loadGistConfig,
  saveGistConfig,
} from "./config.js";
import {
  loadDB,
  saveDB,
  checkDownloaded,
  markDownloaded,
  markMultipleDownloaded,
  exportDB,
  importDB,
  setLastAccess,
  getCreatorFlag,
  setCreatorFlag,
} from "./db.js";
import { handleAPIRequest, getCookies } from "./network.js";
import { startFullDownload, startPawchiveDownload } from "./download.js";
import { gistUpload, gistDownload } from "./gist.js";
import {
  setCreatorsOverrideEnabled,
  updateCacheFromNetwork,
  getCachedCreators,
  ensureRuleState,
} from "./creators.js";

// Global progress tracking for active batches (per-post granularity)
const GLOBAL_BATCHES = new Map(); // batchId -> { total, processed, acked }

function emitGlobalProgress() {
  let total = 0,
    processed = 0,
    acked = 0;
  for (const v of GLOBAL_BATCHES.values()) {
    total += v.total || 0;
    processed += v.processed || 0;
    acked += v.acked || 0;
  }
  try {
    console.debug("[Background] emitGlobalProgress", {
      total,
      processed,
      acked,
    });
    chrome.runtime.sendMessage({
      action: "globalProgress",
      total,
      processed,
      acked,
    });
  } catch (e) {
    console.warn("[Background] emitGlobalProgress failed", e);
  }
  // write snapshot to storage as a fallback so popup can read it when opening
  try {
    chrome.storage.local.set(
      {
        globalProgressSnapshot: {
          total,
          processed,
          acked,
          updatedAt: Date.now(),
        },
      },
      () => {
        /* ignore */
      }
    );
  } catch (e) {
    console.warn("[Background] write snapshot failed", e);
  }
}

// safe broadcast helper (swallow chrome.runtime.lastError so console doesn't spam)
function safeBroadcast(payload, tabId) {
  try {
    if (typeof tabId === "number") {
      chrome.tabs.sendMessage(tabId, payload, () => {
        void chrome.runtime.lastError;
      });
    } else {
      chrome.runtime.sendMessage(payload, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch (e) {
    /* ignore */
  }
}

function registerBatch(batchId, total) {
  GLOBAL_BATCHES.set(batchId, { total: total || 0, processed: 0, acked: 0 });
  emitGlobalProgress();
}
function updateProcessed(batchId, delta = 1) {
  const b = GLOBAL_BATCHES.get(batchId);
  if (!b) return;
  b.processed = (b.processed || 0) + delta;
  emitGlobalProgress();
}
function updateAcked(batchId, delta = 1) {
  const b = GLOBAL_BATCHES.get(batchId);
  if (!b) return;
  b.acked = (b.acked || 0) + delta;
  emitGlobalProgress();
}
function completeBatch(batchId) {
  GLOBAL_BATCHES.delete(batchId);
  emitGlobalProgress();
}

function shouldMarkResult(result) {
  if (!result || !result.success) return false;
  if (result.noFiles === true) return true;
  if (result.backend === true) return true;
  if (result.alreadyDownloaded === true) return true;
  if (typeof result.successCount === "number" && result.successCount > 0)
    return true;
  if (Array.isArray(result.results)) {
    return result.results.some((item) => item && item.success);
  }
  return false;
}

export function registerMessageHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (!message || !message.action) return false;

      switch (message.action) {
        case "favorites.getConfig":
          loadFavoritesConfig()
            .then((cfg) => sendResponse({ success: true, config: cfg }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "favorites.setConfig":
          saveFavoritesConfig(message.config || {})
            .then((cfg) => sendResponse({ success: true, config: cfg }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "favorites.forceCheck":
          (async () => {
            try {
              await runFavoritesCheck();
              sendResponse({ success: true });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;
        case "creator.recordAccess":
          (async () => {
            try {
              await setLastAccess(
                message.service,
                message.userId,
                message.when ? new Date(message.when) : new Date()
              );
              sendResponse({ success: true });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;

        case "backend.getConfig":
          loadBackendConfig()
            .then((cfg) => sendResponse({ success: true, config: cfg }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "backend.setConfig":
          saveBackendConfig(message.config || {})
            .then((cfg) => sendResponse({ success: true, config: cfg }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;

        case "gist.getConfig":
          loadGistConfig()
            .then((cfg) => sendResponse({ success: true, config: cfg }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "gist.setConfig":
          saveGistConfig(message.config || {})
            .then((cfg) => sendResponse({ success: true, config: cfg }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "gist.upload":
          gistUpload()
            .then((res) => sendResponse({ success: true, result: res }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "gist.download":
          gistDownload()
            .then((res) => sendResponse({ success: true, result: res }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;

        case "fetchAPI":
          handleAPIRequest(message.url, message.headers)
            .then((data) => sendResponse({ success: true, data }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "status.getGlobalProgress":
          // return aggregated progress for currently active batches
          (async () => {
            try {
              let total = 0,
                processed = 0,
                acked = 0;
              for (const v of GLOBAL_BATCHES.values()) {
                total += v.total || 0;
                processed += v.processed || 0;
                acked += v.acked || 0;
              }
              sendResponse({
                success: true,
                progress: { total, processed, acked },
              });
            } catch (e) {
              sendResponse({
                success: false,
                error: e && e.message ? e.message : String(e),
              });
            }
          })();
          return true;
        case "getCookies":
          getCookies(message.domain)
            .then((c) => sendResponse({ success: true, cookies: c }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;

        case "checkDownloaded":
          checkDownloaded(message.service, message.userId, message.postId)
            .then((d) => sendResponse({ success: true, downloaded: d }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;

        case "startDownload":
          try {
            sendResponse({ success: true, accepted: true });
          } catch (e) {}
          (async () => {
            try {
              const tabId =
                sender && sender.tab && sender.tab.id
                  ? sender.tab.id
                  : undefined;
              const isPaw = message.source === 'pawchive' ||
                (sender && sender.tab && sender.tab.url && sender.tab.url.includes('pawchive.st'));
              const r = isPaw
                ? await startPawchiveDownload(message.service, message.userId, message.postId, tabId)
                : await startFullDownload(
                    message.service,
                    message.userId,
                    message.postId,
                    message.path,
                    sender && sender.tab && sender.tab.url
                      ? sender.tab.url
                      : undefined,
                    tabId
                  );
              try {
                const shouldMark = shouldMarkResult(r);
                if (shouldMark) {
                  try {
                    await markDownloaded(
                      message.service,
                      message.userId,
                      message.postId
                    );
                  } catch (e) {
                    console.warn("[Background] markDownloaded failed", e);
                  }
                }
              } catch (e) {}
              const payload = {
                action: "downloadComplete",
                service: message.service,
                userId: message.userId,
                postId: message.postId,
                result: r,
              };
              try {
                safeBroadcast(payload, tabId);
              } catch (e) {}
            } catch (err) {
              const payload = {
                action: "downloadComplete",
                service: message.service,
                userId: message.userId,
                postId: message.postId,
                result: {
                  success: false,
                  error: err && err.message ? err.message : String(err),
                },
              };
              try {
                const tabId =
                  sender && sender.tab && sender.tab.id
                    ? sender.tab.id
                    : undefined;
                if (tabId) chrome.tabs.sendMessage(tabId, payload, () => {});
                else chrome.runtime.sendMessage(payload, () => {});
              } catch (e) {}
            }
          })();
          return false;

        case "startDownloadBatch":
          try {
            sendResponse({ success: true, accepted: true });
          } catch (e) {}
          (async () => {
            const items = Array.isArray(message.items) ? message.items : [];
            const tabId =
              sender && sender.tab && sender.tab.id ? sender.tab.id : undefined;
            const total = items.length;
            let processed = 0;
            const succeeded = [];
            const batchId = `batch:${Date.now()}:${Math.random()
              .toString(36)
              .slice(2, 8)}`;
            registerBatch(batchId, total);
            for (const it of items) {
              try {
                const isPaw = it.source === 'pawchive' ||
                  (sender && sender.tab && sender.tab.url && sender.tab.url.includes('pawchive.st'));
                const res = isPaw
                  ? await startPawchiveDownload(it.service, it.userId, it.postId, tabId)
                  : await startFullDownload(
                      it.service,
                      it.userId,
                      it.postId,
                      it.path,
                      sender && sender.tab && sender.tab.url
                        ? sender.tab.url
                        : undefined,
                      tabId
                    );
                const payload = {
                  action: "downloadComplete",
                  service: it.service,
                  userId: it.userId,
                  postId: it.postId,
                  result: res,
                };
                try {
                  safeBroadcast(payload, tabId);
                } catch (e) {}
                if (shouldMarkResult(res)) {
                  succeeded.push({
                    service: it.service,
                    userId: it.userId,
                    postId: it.postId,
                  });
                  updateAcked(batchId, 1);
                }
              } catch (e) {
                const payload = {
                  action: "downloadComplete",
                  service: it.service,
                  userId: it.userId,
                  postId: it.postId,
                  result: {
                    success: false,
                    error: e && e.message ? e.message : String(e),
                  },
                };
                try {
                  if (tabId) chrome.tabs.sendMessage(tabId, payload, () => {});
                  else chrome.runtime.sendMessage(payload, () => {});
                } catch (ee) {}
              }
              processed++;
              updateProcessed(batchId, 1);
              const batchProgress = {
                action: "downloadProgress",
                batch: true,
                service: items[0] && items[0].service,
                userId: items[0] && items[0].userId,
                sentCount: processed,
                totalCount: total,
                progress: Math.round((100 * processed) / Math.max(1, total)),
              };
              try {
                safeBroadcast(batchProgress, tabId);
              } catch (e) {}
              await new Promise((r) => setTimeout(r, 200));
            }
            if (succeeded.length > 0) {
              try {
                await markMultipleDownloaded(succeeded);
              } catch (e) {
                console.warn("[Background] markMultipleDownloaded failed", e);
              }
            }
            completeBatch(batchId);
          })();
          return false;

        case "creator.fetch":
          try {
            sendResponse({ success: true, accepted: true });
          } catch (e) {}
          (async () => {
            try {
              const origin = message.origin || API.DEFAULT_ORIGIN;
              const service = message.service;
              const userId = message.userId;
              if (!service || !userId) return;

              const profileUrl = `${origin}${API.API_PREFIX}/${service}/user/${userId}/profile`;
              const headers = {
                Accept: "text/css",
                "Content-Type": "text/css",
                Referer: `${origin}/${service}/user/${userId}`,
              };
              const profile = await handleAPIRequest(profileUrl, headers);
              const postCount =
                profile && typeof profile.post_count === "number"
                  ? profile.post_count
                  : 0;

              const perPage = 50;
              const allPosts = [];
              for (let o = 0; o < postCount; o += perPage) {
                try {
                  const url = `${origin}${API.API_PREFIX}/${service}/user/${userId}/posts?o=${o}`;
                  const pageData = await handleAPIRequest(url, headers);
                  if (Array.isArray(pageData)) allPosts.push(...pageData);
                  await new Promise((r) => setTimeout(r, 200));
                } catch (e) {
                  console.warn("[Background] fetch posts page failed", e);
                }
              }

              const postMap = new Map();
              for (const p of allPosts)
                if (p && p.id) postMap.set(String(p.id), p);
              const uniquePosts = Array.from(postMap.values());

              const toDispatch = [];
              for (const p of uniquePosts) {
                try {
                  const downloaded = await checkDownloaded(
                    service,
                    userId,
                    String(p.id)
                  );
                  if (!downloaded)
                    toDispatch.push({
                      service,
                      userId,
                      postId: String(p.id),
                      path: `${origin}${
                        p.file && p.file.path ? p.file.path : ""
                      }`,
                    });
                } catch (e) {
                  toDispatch.push({
                    service,
                    userId,
                    postId: String(p.id),
                    path: `${origin}${
                      p.file && p.file.path ? p.file.path : ""
                    }`,
                  });
                }
              }

              // dispatch via existing startFullDownload logic (reusing startDownloadBatch behavior)
              const tabId =
                sender && sender.tab && sender.tab.id
                  ? sender.tab.id
                  : undefined;
              const total = toDispatch.length;
              let processed = 0;
              const succeeded = [];
              const batchId = `batch:${Date.now()}:${Math.random()
                .toString(36)
                .slice(2, 8)}`;
              registerBatch(batchId, total);

              for (const it of toDispatch) {
                try {
                  const res = await startFullDownload(
                    it.service,
                    it.userId,
                    it.postId,
                    it.path,
                    sender && sender.tab && sender.tab.url
                      ? sender.tab.url
                      : undefined,
                    tabId
                  );
                  const payload = {
                    action: "downloadComplete",
                    service: it.service,
                    userId: it.userId,
                    postId: it.postId,
                    result: res,
                  };
                  try {
                    safeBroadcast(payload, tabId);
                  } catch (e) {}
                  if (shouldMarkResult(res)) {
                    succeeded.push({
                      service: it.service,
                      userId: it.userId,
                      postId: it.postId,
                    });
                    updateAcked(batchId, 1);
                  }
                } catch (e) {
                  const payload = {
                    action: "downloadComplete",
                    service: it.service,
                    userId: it.userId,
                    postId: it.postId,
                    result: {
                      success: false,
                      error: e && e.message ? e.message : String(e),
                    },
                  };
                  try {
                    if (tabId)
                      chrome.tabs.sendMessage(tabId, payload, () => {});
                    else chrome.runtime.sendMessage(payload, () => {});
                  } catch (ee) {}
                }
                processed++;
                updateProcessed(batchId, 1);
                const batchProgress = {
                  action: "downloadProgress",
                  batch: true,
                  service: service,
                  userId: userId,
                  sentCount: processed,
                  totalCount: total,
                  progress: Math.round((100 * processed) / Math.max(1, total)),
                };
                try {
                  safeBroadcast(batchProgress, tabId);
                } catch (e) {}
                await new Promise((r) => setTimeout(r, 200));
              }

              if (succeeded.length > 0) {
                try {
                  await markMultipleDownloaded(succeeded);
                } catch (e) {
                  console.warn("[Background] markMultipleDownloaded failed", e);
                }
              }
              completeBatch(batchId);
            } catch (e) {
              console.error("[Background] creator.fetch failed", e);
            }
          })();
          return false;

        case "creator.pageFetch":
          try {
            sendResponse({ success: true, accepted: true });
          } catch (e) {}
          (async () => {
            try {
              const service = message.service;
              const userId = message.userId;
              const offset = Number.isFinite(message.offset)
                ? Number(message.offset)
                : message.offset
                ? Number(message.offset)
                : null;
              const origin =
                sender && sender.tab && sender.tab.url
                  ? new URL(sender.tab.url).origin
                  : message.origin || API.DEFAULT_ORIGIN;
              if (!service || !userId) return;

              const headers = {
                Accept: "text/css",
                "Content-Type": "text/css",
                Referer: `${origin}/${service}/user/${userId}`,
              };
              const url = `${origin}${
                API.API_PREFIX
              }/${service}/user/${userId}/posts${offset ? "?o=" + offset : ""}`;
              let pageData = [];
              try {
                pageData = await handleAPIRequest(url, headers);
              } catch (e) {
                console.warn(
                  "[Background] creator.pageFetch page request failed",
                  e
                );
              }
              if (!Array.isArray(pageData)) pageData = [];

              const toDispatch = [];
              for (const p of pageData) {
                if (!p || !p.id) continue;
                try {
                  const downloaded = await checkDownloaded(
                    service,
                    userId,
                    String(p.id)
                  );
                  if (!downloaded)
                    toDispatch.push({
                      service,
                      userId,
                      postId: String(p.id),
                      path: `${origin}${
                        p.file && p.file.path ? p.file.path : ""
                      }`,
                    });
                } catch (e) {
                  toDispatch.push({
                    service,
                    userId,
                    postId: String(p.id),
                    path: `${origin}${
                      p.file && p.file.path ? p.file.path : ""
                    }`,
                  });
                }
              }

              const tabId =
                sender && sender.tab && sender.tab.id
                  ? sender.tab.id
                  : undefined;
              const total = toDispatch.length;
              let processed = 0;
              const succeeded = [];
              const batchId = `batch:${Date.now()}:${Math.random()
                .toString(36)
                .slice(2, 8)}`;
              registerBatch(batchId, total);

              for (const it of toDispatch) {
                try {
                  const res = await startFullDownload(
                    it.service,
                    it.userId,
                    it.postId,
                    it.path,
                    sender && sender.tab && sender.tab.url
                      ? sender.tab.url
                      : undefined,
                    tabId
                  );
                  const payload = {
                    action: "downloadComplete",
                    service: it.service,
                    userId: it.userId,
                    postId: it.postId,
                    result: res,
                  };
                  try {
                    safeBroadcast(payload, tabId);
                  } catch (e) {}
                  if (shouldMarkResult(res)) {
                    succeeded.push({
                      service: it.service,
                      userId: it.userId,
                      postId: it.postId,
                    });
                    updateAcked(batchId, 1);
                  }
                } catch (e) {
                  const payload = {
                    action: "downloadComplete",
                    service: it.service,
                    userId: it.userId,
                    postId: it.postId,
                    result: {
                      success: false,
                      error: e && e.message ? e.message : String(e),
                    },
                  };
                  try {
                    if (tabId)
                      chrome.tabs.sendMessage(tabId, payload, () => {});
                    else chrome.runtime.sendMessage(payload, () => {});
                  } catch (ee) {}
                }
                processed++;
                updateProcessed(batchId, 1);
                const batchProgress = {
                  action: "downloadProgress",
                  batch: true,
                  service: it.service,
                  userId: it.userId,
                  sentCount: processed,
                  totalCount: total,
                  progress: Math.round((100 * processed) / Math.max(1, total)),
                };
                try {
                  safeBroadcast(batchProgress, tabId);
                } catch (e) {}
                await new Promise((r) => setTimeout(r, 200));
              }

              if (succeeded.length > 0) {
                try {
                  await markMultipleDownloaded(succeeded);
                } catch (e) {
                  console.warn("[Background] markMultipleDownloaded failed", e);
                }
              }
              completeBatch(batchId);
            } catch (e) {
              console.error("[Background] creator.pageFetch failed", e);
            }
          })();
          return false;

        case "util.extractExternalLinks":
          try {
            const links = UTIL.extractExternalLinks(message.content);
            sendResponse({ success: true, links });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          return true;
        case "util.sanitizeFileName":
          try {
            const name = UTIL.sanitizeFileName(message.name);
            sendResponse({ success: true, name });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          return true;
        case "util.getFileExtension":
          try {
            const ext = UTIL.getFileExtension(message.path);
            sendResponse({ success: true, ext });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          return true;
        case "util.buildDownloadTasks":
          try {
            const tasks = UTIL.buildDownloadTasks(
              message.postData,
              message.title,
              message.baseUrl
            );
            sendResponse({ success: true, tasks });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          return true;

        case "creators.getCached":
          (async () => {
            try {
              const c = await getCachedCreators(message.host);
              sendResponse({ success: true, cached: c });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;
        case "creators.getSummary":
          (async () => {
            try {
              // return small metadata (updatedAt) for hosts to avoid shipping large payloads
              if (message && message.host) {
                const meta = await chrome.storage.local.get(
                  `creatorsOverride_${message.host}_meta`
                );
                const item =
                  meta && meta[`creatorsOverride_${message.host}_meta`]
                    ? meta[`creatorsOverride_${message.host}_meta`]
                    : null;
                sendResponse({
                  success: true,
                  summary: item
                    ? { updatedAt: item.updatedAt, sourceHost: item.sourceHost }
                    : null,
                });
              } else {
                const map = {};
                for (const h of API.HOSTS) {
                  const meta = await chrome.storage.local.get(
                    `creatorsOverride_${h}_meta`
                  );
                  const item =
                    meta && meta[`creatorsOverride_${h}_meta`]
                      ? meta[`creatorsOverride_${h}_meta`]
                      : null;
                  map[h] = item
                    ? { updatedAt: item.updatedAt, sourceHost: item.sourceHost }
                    : null;
                }
                sendResponse({ success: true, summary: map });
              }
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;
        case "creators.updateCache":
          try {
            // accept request immediately and perform cache update asynchronously to avoid sending large payloads back to popup
            try {
              sendResponse({ success: true, accepted: true });
            } catch (e) {}
            (async () => {
              try {
                console.log("[Background] creators.updateCache", message.host);
                await updateCacheFromNetwork(message.host);
                console.log(
                  "[Background] creators.updateCache done",
                  message.host
                );
              } catch (e) {
                console.error(
                  "[Background] creators.updateCache failed",
                  message.host,
                  e
                );
              }
            })();
          } catch (e) {
            try {
              sendResponse({ success: false, error: e.message });
            } catch (ee) {}
          }
          return false;
        case "creators.setEnabled":
          (async () => {
            try {
              await setCreatorsOverrideEnabled(!!message.enabled);
              sendResponse({ success: true });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;
        case "creators.ensureRuleState":
          (async () => {
            try {
              await ensureRuleState();
              sendResponse({ success: true });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;

        case "storage.get":
          chrome.storage.sync.get(message.keys, (res) => {
            if (chrome.runtime.lastError)
              return sendResponse({
                success: false,
                error: chrome.runtime.lastError.message,
              });
            sendResponse({ success: true, result: res });
          });
          return true;
        case "storage.set":
          chrome.storage.sync.set(message.items, () => {
            if (chrome.runtime.lastError)
              return sendResponse({
                success: false,
                error: chrome.runtime.lastError.message,
              });
            sendResponse({ success: true });
          });
          return true;
        case "storage.getBytesInUse":
          chrome.storage.sync.getBytesInUse(message.keys, (b) => {
            if (chrome.runtime.lastError)
              return sendResponse({
                success: false,
                error: chrome.runtime.lastError.message,
              });
            sendResponse({ success: true, bytes: b });
          });
          return true;
        case "storageLocal.getBytesInUse":
          chrome.storage.local.getBytesInUse(message.keys, (b) => {
            if (chrome.runtime.lastError)
              return sendResponse({
                success: false,
                error: chrome.runtime.lastError.message,
              });
            sendResponse({ success: true, bytes: b });
          });
          return true;

        case "db.load":
          loadDB()
            .then((db) => sendResponse({ success: true, db }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "db.save":
          chrome.storage.local.set({ [STORAGE_KEY]: message.data }, () => {
            if (chrome.runtime.lastError)
              return sendResponse({
                success: false,
                error: chrome.runtime.lastError.message,
              });
            chrome.storage.sync.get(STORAGE_VERSION_KEY, (res) => {
              const v = (res[STORAGE_VERSION_KEY] || 0) + 1;
              chrome.storage.sync.set({ [STORAGE_VERSION_KEY]: v }, () =>
                sendResponse({ success: true })
              );
            });
          });
          return true;
        case "db.checkDownloaded":
          checkDownloaded(message.service, message.userId, message.postId)
            .then((downloaded) => sendResponse({ success: true, downloaded }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "db.markDownloaded":
          markDownloaded(message.service, message.userId, message.postId)
            .then(() => sendResponse({ success: true }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "db.markMultiple":
          (async () => {
            try {
              await markMultipleDownloaded(message.items);
              sendResponse({ success: true });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;
        case "db.export":
          exportDB()
            .then((text) => sendResponse({ success: true, text }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "db.import":
          importDB(message.text)
            .then((ok) => sendResponse({ success: ok }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
          return true;
        case "db.clear":
          (async () => {
            try {
              await chrome.storage.local.set({ [STORAGE_KEY]: {} });
              await chrome.storage.sync.set({ [STORAGE_VERSION_KEY]: 0 });
              sendResponse({ success: true });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;

        case "flag.get":
          (async () => {
            try {
              console.log(
                `[Background] 📥 Received flag.get request for ${message.service}:${message.userId}`
              );
              const flag = await getCreatorFlag(
                message.service,
                message.userId
              );
              console.log(
                `[Background] 📬 Sending flag.get response for ${message.service}:${message.userId}, flag=${flag}`
              );
              sendResponse({ success: true, flag });
            } catch (e) {
              console.error(
                `[Background] ❌ Error in flag.get for ${message.service}:${message.userId}:`,
                e
              );
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;

        case "flag.set":
          (async () => {
            try {
              console.log(
                `[Background] 📥 Received flag.set request for ${message.service}:${message.userId}, value=${message.value}`
              );
              const flag = await setCreatorFlag(
                message.service,
                message.userId,
                message.value
              );
              console.log(
                `[Background] 📬 Sending flag.set response for ${message.service}:${message.userId}, result=${flag}`
              );
              sendResponse({ success: true, flag });
            } catch (e) {
              console.error(
                `[Background] ❌ Error in flag.set for ${message.service}:${message.userId}:`,
                e
              );
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;

        default:
          return false;
      }
    } catch (e) {
      console.error("[Background] onMessage error", e);
      try {
        sendResponse({
          success: false,
          error: e && e.message ? e.message : String(e),
        });
      } catch (er) {}
      return true;
    }
  });
}

// Favorites watcher helper will be injected by favorites.js (if present)
export async function runFavoritesCheck() {
  /* implemented in favorites.js */
}
