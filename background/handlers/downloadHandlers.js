// background/handlers/downloadHandlers.js - download and creator fetch RPCs
import { API, PAW } from "../constants.js";
import UTIL from "../util.js";
import { handleAPIRequest, readLimitedResponseText } from "../network.js";
import {
  dispatchExternalLinksTextTask,
  dispatchTextDownloadTask,
  startCoomerFansDownload,
  startFullDownload,
  startPawchiveDownload,
  runSequentialDownloads,
} from "../download.js";
import {
  fetchAllPawchiveCreatorPosts,
  fetchPawchiveDms,
  fetchPawchiveCreatorPage,
  formatPawchiveDmsText,
  isCompletePawchivePost,
} from "../pawchive.js";
import {
  checkDownloadedMany,
  downloadedItemKey,
  markDownloaded,
  markMultipleDownloaded,
} from "../db.js";
import {
  registerBatch,
  updateProcessed,
  updateAcked,
  completeBatch,
} from "../progress.js";
import {
  delay,
  buildDownloadHistoryRecord,
  getSenderTabId,
  getSenderUrl,
  safeBroadcast,
} from "../messageHelpers.js";
import {
  clearNativeFallbackNotification,
  enqueueNativeFallback,
  takeNativeFallback,
} from "../nativeFallback.js";
import { loadExternalLinkFilterConfig } from "../config.js";

function createBatchId() {
  return `batch:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function isPawRequest(item, senderUrl) {
  let isPawSender = false;
  if (typeof senderUrl === "string") {
    try {
      isPawSender = PAW.HOSTS.includes(new URL(senderUrl).hostname.toLowerCase());
    } catch (e) {
      isPawSender = false;
    }
  }
  return (
    item.source === "pawchive" ||
    item.site === "pawchive" ||
    isPawSender
  );
}

async function runSingleDownload(item, sender, tabId) {
  const senderUrl = getSenderUrl(sender);
  if (isPawRequest(item, senderUrl)) {
    return startPawchiveDownload(item.service, item.userId, item.postId, tabId, item.postData, item.requestId);
  }
  if (item.source === "coomerfans") {
    return startCoomerFansDownload(
      item.service,
      item.userId,
      item.postId,
      item.creatorName,
      tabId,
      item.requestId
    );
  }
  return startFullDownload(
    item.service,
    item.userId,
    item.postId,
    item.path,
    senderUrl,
    tabId,
    item.requestId
  );
}

function broadcastComplete(item, result, tabId, requestId = item?.requestId) {
  safeBroadcast(
    {
      action: "downloadComplete",
      requestId,
      service: item.service,
      userId: item.userId,
      postId: item.postId,
      result,
    },
    tabId
  );
}

function broadcastBatchProgress(scope, processed, total, tabId) {
  safeBroadcast(
    {
      action: "downloadProgress",
      requestId: scope.requestId,
      batch: true,
      service: scope.service,
      userId: scope.userId,
      sentCount: processed,
      totalCount: total,
      progress: Math.round((100 * processed) / Math.max(1, total)),
    },
    tabId
  );
}

function broadcastBatchError(scope, err, tabId) {
  safeBroadcast(
    {
      action: "downloadProgress",
      requestId: scope.requestId,
      batch: true,
      service: scope.service,
      userId: scope.userId,
      sentCount: 0,
      totalCount: 0,
      progress: 0,
      error: err && err.message ? err.message : String(err),
    },
    tabId
  );
}

function itemPostUrl(item, senderUrl) {
  if (item && item.postUrl) return item.postUrl;
  const service = encodeURIComponent(String(item && item.service || ""));
  const userId = encodeURIComponent(String(item && item.userId || ""));
  const postId = encodeURIComponent(String(item && item.postId || ""));
  if (item && item.source === "coomerfans") {
    return `${item.origin || API.COOMERFANS_ORIGIN}/p/${postId}/${userId}/${service}`;
  }

  let origin = item && item.origin;
  if (!origin && senderUrl) {
    try {
      origin = new URL(senderUrl).origin;
    } catch (error) {
      origin = "";
    }
  }
  if (!origin && item && item.postData) origin = PAW.ORIGIN;
  return `${origin || API.DEFAULT_ORIGIN}/${service}/user/${userId}/post/${postId}`;
}

function collectExternalLinkEntries(target, item, result, senderUrl) {
  if (!result || !Array.isArray(result.externalLinks)) return;
  const sourceUrl = itemPostUrl(item, senderUrl);
  for (const url of result.externalLinks) target.push({ url, sourceUrl });
}

async function extractItemExternalLinks(item, filterConfig) {
  let links;
  if (item.source === "coomerfans") {
    const html = await fetchCoomerFansCreatorHtml(item.postUrl || item.path);
    links = UTIL.extractExternalLinks(html);
  } else if (item.postData && typeof item.postData === "object") {
    links = UTIL.extractPostExternalLinks(item.postData);
  } else if (item.site === "pawchive") {
    links = [];
  } else {
    const origin = item.origin || API.DEFAULT_ORIGIN;
    const postUrl = `${origin}/${encodeURIComponent(item.service)}/user/${encodeURIComponent(item.userId)}/post/${encodeURIComponent(item.postId)}`;
    const apiUrl = `${origin}${API.API_PREFIX}/${encodeURIComponent(item.service)}/user/${encodeURIComponent(item.userId)}/post/${encodeURIComponent(item.postId)}`;
    const postData = await handleAPIRequest(apiUrl, {
      Accept: "text/css",
      "Content-Type": "text/css",
      Referer: postUrl,
    });
    links = UTIL.extractPostExternalLinks(postData);
  }
  return UTIL.filterExternalLinks(links, filterConfig);
}

async function runLinksOnlyBatch(items, sender, scope = {}) {
  const tabId = getSenderTabId(sender);
  const total = items.length;
  const batchId = createBatchId();
  const externalLinkEntries = [];
  const filterConfig = await loadExternalLinkFilterConfig();
  let processed = 0;

  registerBatch(batchId, total);
  try {
    broadcastBatchProgress(scope, 0, total, tabId);
    for (const item of items) {
      try {
        const links = await extractItemExternalLinks(item, filterConfig);
        collectExternalLinkEntries(externalLinkEntries, item, { externalLinks: links }, getSenderUrl(sender));
        updateAcked(batchId, 1);
      } catch (error) {
        console.warn("[Background] creator links-only extraction failed", item.postId, error);
      }
      processed++;
      updateProcessed(batchId, 1);
      broadcastBatchProgress(scope, processed, total, tabId);
      await delay(200);
    }

    const linkResult = await dispatchExternalLinksTextTask(externalLinkEntries, {
      fileName: scope.linksFileName,
    });
    if (!linkResult.success && !linkResult.skipped) {
      console.warn("[Background] external links TXT Chrome download failed", linkResult.error || linkResult.results);
    }
  } finally {
    completeBatch(batchId);
  }
}

async function runDownloadBatch(items, sender, scope = {}) {
  const tabId = getSenderTabId(sender);
  const senderUrl = getSenderUrl(sender);
  const total = items.length;
  const historyRecords = [];
  const fallbackRequests = [];
  const externalLinkEntries = [];
  const batchId = createBatchId();
  let processed = 0;
  const progressScope = {
    service: scope.service || (items[0] && items[0].service),
    userId: scope.userId || (items[0] && items[0].userId),
    requestId: scope.requestId,
  };

  registerBatch(batchId, total);
  try {
    broadcastBatchProgress(progressScope, 0, total, tabId);
    if (total === 0) return;

    for (const item of items) {
      try {
        const result = await runSingleDownload(item, sender, tabId);
        if (scope.aggregateExternalLinks === true) {
          collectExternalLinkEntries(externalLinkEntries, item, result, senderUrl);
        }
        if (result && result.backendFailed && Array.isArray(result.fallbackTasks)) {
          fallbackRequests.push({
            item: { ...item, requestId: scope.requestId },
            tasks: result.fallbackTasks,
            externalLinks: result.externalLinks,
            tabId,
          });
        } else {
          broadcastComplete(item, result, tabId, scope.requestId);
          const historyRecord = buildDownloadHistoryRecord(item, result);
          if (historyRecord) {
            historyRecords.push(historyRecord);
            if (historyRecord.status !== "partial") updateAcked(batchId, 1);
          }
        }
      } catch (err) {
        broadcastComplete(
          item,
          {
            success: false,
            error: err && err.message ? err.message : String(err),
          },
          tabId,
          scope.requestId
        );
      }

      processed++;
      updateProcessed(batchId, 1);
      broadcastBatchProgress(progressScope, processed, total, tabId);
      await delay(200);
    }

    if (historyRecords.length > 0) {
      try {
        await markMultipleDownloaded(historyRecords);
      } catch (err) {
        console.warn("[Background] markMultipleDownloaded failed", err);
      }
    }
    if (fallbackRequests.length > 0) {
      try {
        await enqueueNativeFallback(fallbackRequests);
      } catch (err) {
        for (const request of fallbackRequests) {
          broadcastComplete(request.item, {
            success: false,
            error: err && err.message ? err.message : String(err),
          }, request.tabId);
        }
      }
    }
    if (scope.aggregateExternalLinks === true && externalLinkEntries.length > 0) {
      try {
        const linkResult = await dispatchExternalLinksTextTask(externalLinkEntries, {
          fileName: scope.linksFileName,
          origin: scope.origin,
          referer: scope.referer,
          service: progressScope.service,
          userId: progressScope.userId,
          postId: scope.linksPostId,
        });
        if (!linkResult.success && !linkResult.skipped) {
          console.warn("[Background] external links TXT Chrome download failed", linkResult.error || linkResult.results);
        }
      } catch (err) {
        console.warn("[Background] external links TXT task failed", err);
      }
    }
  } finally {
    completeBatch(batchId);
  }
}

function fallbackProgress(request, progress) {
  safeBroadcast({
    action: "downloadProgress",
    requestId: request.item.requestId,
    service: request.item.service,
    userId: request.item.userId,
    postId: request.item.postId,
    progress: Math.round((100 * progress.processed) / Math.max(1, progress.total)),
    sentCount: progress.processed,
    totalCount: progress.total,
  }, request.tabId);
}

function fallbackCancelledMessage() {
  try {
    return chrome.i18n.getMessage("nativeFallbackCancelled") || "Chrome fallback download cancelled";
  } catch (error) {
    return "Chrome fallback download cancelled";
  }
}

async function completeNativeFallbackRequest(request, shouldContinue) {
  if (!shouldContinue) {
    broadcastComplete(request.item, {
      success: false,
      cancelled: true,
      error: fallbackCancelledMessage(),
    }, request.tabId);
    return;
  }

  try {
    const { successCount, results } = await runSequentialDownloads(
      request.tasks,
      (progress) => fallbackProgress(request, progress)
    );
    const result = {
      success: successCount > 0,
      successCount,
      results,
      externalLinks: request.externalLinks,
      error: successCount > 0 ? undefined : "Chrome downloads failed",
    };
    const historyRecord = buildDownloadHistoryRecord(request.item, result);
    if (historyRecord) {
      try {
        await markDownloaded(historyRecord);
      } catch (error) {
        console.warn("[Background] native fallback history write failed", error);
      }
    }
    broadcastComplete(request.item, result, request.tabId);
  } catch (error) {
    broadcastComplete(request.item, {
      success: false,
      error: error && error.message ? error.message : String(error),
    }, request.tabId);
  }
}

export async function handleNativeFallbackDecision(notificationId, shouldContinue) {
  const pending = await takeNativeFallback(notificationId);
  if (!pending) return false;
  await clearNativeFallbackNotification(notificationId);
  for (const request of (pending.requests || []).slice(0, 5000)) {
    await completeNativeFallbackRequest(request, shouldContinue === true);
  }
  return true;
}

function postToDownloadItem(origin, service, userId, post, includePostData = false) {
  const item = {
    service,
    userId,
    postId: String(post.id),
    path: `${origin}${post.file && post.file.path ? post.file.path : ""}`,
    origin,
    postUrl: `${origin}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}/post/${encodeURIComponent(String(post.id))}`,
  };
  if (includePostData) item.postData = post;
  return item;
}

function pawPostToDownloadItem(service, userId, post) {
  return {
    source: "default",
    site: "pawchive",
    service,
    userId,
    postId: String(post.id),
    postData: post,
    origin: PAW.ORIGIN,
    postUrl: `${PAW.ORIGIN}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}/post/${encodeURIComponent(String(post.id))}`,
  };
}

function isCoomerFansOrigin(origin) {
  try {
    const url = new URL(origin || API.COOMERFANS_ORIGIN);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && (host === API.COOMERFANS_HOST || host.endsWith(`.${API.COOMERFANS_HOST}`));
  } catch (e) {
    return false;
  }
}

function coomerFansCreatorUrl(origin, service, userId, creatorName) {
  const name = creatorName ? `/${encodeURIComponent(creatorName)}` : "";
  return `${origin}/u/${encodeURIComponent(service)}/${encodeURIComponent(userId)}${name}`;
}

function getCoomerFansPostIdentity(rawUrl, expectedService, expectedUserId) {
  try {
    const u = new URL(rawUrl, API.COOMERFANS_ORIGIN);
    if (!isCoomerFansOrigin(u.origin)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const service = String(expectedService || "").toLowerCase();
    if (
      parts.length >= 4 &&
      parts[0] === "p" &&
      parts[2] === String(expectedUserId) &&
      parts[3].toLowerCase() === service
    ) {
      return { postId: parts[1], postUrl: u.toString() };
    }
    if (
      parts.length >= 5 &&
      parts[0].toLowerCase() === service &&
      parts[1] === "user" &&
      parts[2] === String(expectedUserId) &&
      parts[3] === "post"
    ) {
      return { postId: parts[4], postUrl: u.toString() };
    }
  } catch (e) {
    /* ignore malformed links */
  }
  return null;
}

async function fetchCoomerFansCreatorHtml(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error("Invalid CoomerFans URL");
  }
  if (!isCoomerFansOrigin(parsed.origin)) throw new Error("Unexpected CoomerFans URL");
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Cache-Control": "no-cache",
    "User-Agent": "Mozilla/5.0",
  };
  const resp = await fetch(parsed.toString(), {
    method: "GET",
    headers,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(45 * 1000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return readLimitedResponseText(resp, 16 * 1024 * 1024, "CoomerFans");
}

async function fetchCoomerFansCreatorItems(origin, service, userId, creatorName) {
  const baseProfile = coomerFansCreatorUrl(origin, service, userId, creatorName);
  const perPage = 50;
  const maxPages = 200;
  const maxRequests = 400;
  const maxConsecutiveFailures = 8;
  const postMap = new Map();
  let requestCount = 0;
  let consecutiveFailures = 0;

  for (let pageIdx = 1; pageIdx <= maxPages; pageIdx++) {
    const candidates = pageIdx === 1 ? [baseProfile] : [];
    candidates.push(`${baseProfile}?page=${pageIdx}`);
    candidates.push(`${baseProfile}?o=${(pageIdx - 1) * perPage}`);

    let fetchedAny = false;
    let foundThisPage = 0;
    for (const listUrl of candidates) {
      if (requestCount >= maxRequests) break;
      try {
        requestCount++;
        const html = await fetchCoomerFansCreatorHtml(listUrl);
        fetchedAny = true;
        consecutiveFailures = 0;
        const linkRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
        let match;
        while ((match = linkRe.exec(html)) !== null) {
          const href = (match[1] || match[2] || match[3] || "").replace(/&amp;/g, "&");
          const identity = getCoomerFansPostIdentity(href, service, userId);
          if (!identity || postMap.has(identity.postId)) continue;
          postMap.set(identity.postId, {
            source: "coomerfans",
            service,
            userId,
            postId: identity.postId,
            path: identity.postUrl,
            postUrl: identity.postUrl,
            origin,
            creatorName,
          });
          foundThisPage++;
        }
        if (foundThisPage > 0) break;
      } catch (err) {
        consecutiveFailures++;
        console.warn("[Background] fetch CoomerFans listing failed", listUrl, err);
        if (consecutiveFailures >= maxConsecutiveFailures) break;
        await delay(Math.min(2000, 200 * consecutiveFailures));
      }
    }
    if (requestCount >= maxRequests || consecutiveFailures >= maxConsecutiveFailures) break;
    if (!fetchedAny) break;

    if (foundThisPage === 0) break;
    await delay(200);
  }

  return Array.from(postMap.values());
}

async function filterUndownloaded(items) {
  const downloaded = await checkDownloadedMany(items);
  return items.filter((item) => {
    const key = downloadedItemKey(item.service, item.userId, item.postId, item.source);
    return !downloaded[key];
  });
}

async function runFilteredDownloadBatch(allItems, sender, scope = {}) {
  const items = scope.fullMode === true ? allItems : await filterUndownloaded(allItems);
  await runDownloadBatch(items, sender, scope);
}

async function runCreatorFetchBatch(allItems, sender, scope = {}) {
  if (scope.mode === "links") {
    await runLinksOnlyBatch(allItems, sender, scope);
    return;
  }
  await runFilteredDownloadBatch(allItems, sender, scope);
}

async function runPawchiveDmsFetch(service, userId, sender, scope) {
  const tabId = getSenderTabId(sender);
  const batchId = createBatchId();
  registerBatch(batchId, 1);
  try {
    broadcastBatchProgress(scope, 0, 1, tabId);
    const { url, messages } = await fetchPawchiveDms(service, userId);
    const text = formatPawchiveDmsText(messages, {
      service,
      userId,
      sourceUrl: url,
    });
    const result = await dispatchTextDownloadTask(text, {
      fileName: `${service}_${userId}_dms.txt`,
      type: "pawchive_dms_txt",
    });
    if (!result.success) throw new Error(result.error || "Pawchive DMs TXT download failed");
    updateAcked(batchId, 1);
    updateProcessed(batchId, 1);
    broadcastBatchProgress(scope, 1, 1, tabId);
  } finally {
    completeBatch(batchId);
  }
}

function linksFileName(kind, service, userId, qualifier = "") {
  const suffix = qualifier === "" || qualifier === null || qualifier === undefined ? "" : `_${qualifier}`;
  return `${service}_${userId}_${kind}${suffix}_links.txt`;
}

function runAcceptedTask(label, task, scope, tabId) {
  task().catch((err) => {
    console.error(`[Background] ${label} failed`, err);
    broadcastBatchError(scope, err, tabId);
  });
}

async function fetchCreatorPosts(origin, service, userId) {
  const encodedService = encodeURIComponent(service);
  const encodedUserId = encodeURIComponent(userId);
  const headers = {
    Accept: "text/css",
    "Content-Type": "text/css",
    Referer: `${origin}/${encodedService}/user/${encodedUserId}`,
  };
  const profileUrl = `${origin}${API.API_PREFIX}/${encodedService}/user/${encodedUserId}/profile`;
  const profile = await handleAPIRequest(profileUrl, headers);
  const postCount = Math.min(
    10000,
    profile && Number.isFinite(profile.post_count)
      ? Math.max(0, Math.floor(profile.post_count))
      : 0
  );
  const perPage = 50;
  const postMap = new Map();

  for (let offset = 0; offset < postCount; offset += perPage) {
    try {
      const url = `${origin}${API.API_PREFIX}/${encodedService}/user/${encodedUserId}/posts?o=${offset}`;
      const pageData = await handleAPIRequest(url, headers);
      if (Array.isArray(pageData)) {
        for (const post of pageData) {
          if (post && post.id) postMap.set(String(post.id), post);
        }
      }
      await delay(200);
    } catch (err) {
      console.warn("[Background] fetch creator posts page failed", err);
    }
  }

  return Array.from(postMap.values());
}

async function fetchCreatorPage(origin, service, userId, offset) {
  if (isPawOrigin(origin)) {
    return fetchPawchiveCreatorPage(service, userId, offset || 0);
  }
  const headers = {
    Accept: "text/css",
    "Content-Type": "text/css",
    Referer: `${origin}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}`,
  };
  const suffix = offset ? `?o=${offset}` : "";
  const url = `${origin}${API.API_PREFIX}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}/posts${suffix}`;
  try {
    const pageData = await handleAPIRequest(url, headers);
    return Array.isArray(pageData) ? pageData : [];
  } catch (err) {
    console.warn("[Background] creator.pageFetch request failed", err);
    return [];
  }
}

function isPawOrigin(origin) {
  try {
    return new URL(origin).origin === PAW.ORIGIN;
  } catch (error) {
    return false;
  }
}

function normalizeSupportedOrigin(value) {
  const url = new URL(String(value || API.DEFAULT_ORIGIN));
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Unsupported creator origin");
  }
  const host = url.hostname.toLowerCase();
  if (host === PAW.HOST) return PAW.ORIGIN;
  if (API.HOSTS.includes(host)) return `https://${host}`;
  if (host === API.COOMERFANS_HOST || host.endsWith(`.${API.COOMERFANS_HOST}`)) {
    return API.COOMERFANS_ORIGIN;
  }
  throw new Error("Unsupported creator origin");
}

function requiredIdentity(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 512 || /[\0\r\n]/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function optionalShortString(value, maxLength = 512) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > maxLength || /[\0\r\n]/.test(normalized)) {
    throw new Error("Invalid download metadata");
  }
  return normalized;
}

function normalizeDownloadItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid download item");
  }
  const source = optionalShortString(value.source, 32);
  if (source && !["default", "pawchive", "coomerfans"].includes(source)) {
    throw new Error("Unsupported download source");
  }
  const item = {
    service: requiredIdentity(value.service, "service"),
    userId: requiredIdentity(value.userId, "creator id"),
    postId: requiredIdentity(value.postId, "post id"),
    path: optionalShortString(value.path, 8192),
    source,
    creatorName: optionalShortString(value.creatorName, 512),
    requestId: normalizeRequestId(value.requestId),
  };
  if (source === "coomerfans" && !getCoomerFansPostIdentity(item.path, item.service, item.userId)) {
    throw new Error("Invalid CoomerFans post URL");
  }
  return item;
}

function normalizePageOffset(value) {
  if (value === undefined || value === null || value === "") return 0;
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) {
    throw new Error("Invalid creator page offset");
  }
  return offset;
}

function normalizeRequestId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= 128 ? normalized : undefined;
}

function resolveOrigin(message, sender) {
  const senderUrl = getSenderUrl(sender);
  if (senderUrl) {
    try {
      return normalizeSupportedOrigin(new URL(senderUrl).origin);
    } catch (e) {
      /* fall through */
    }
  }
  return normalizeSupportedOrigin(message.origin || API.DEFAULT_ORIGIN);
}

export function createDownloadHandlers() {
  return {
    startDownload: ({ message, sender, sendResponse }) => {
      let item;
      try {
        item = normalizeDownloadItem(message);
        sendResponse({ success: true, accepted: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error) });
        return false;
      }

      (async () => {
        const tabId = getSenderTabId(sender);
        try {
          const result = await runSingleDownload(item, sender, tabId);
          if (result && result.backendFailed && Array.isArray(result.fallbackTasks)) {
            try {
              await enqueueNativeFallback({
                item,
                tasks: result.fallbackTasks,
                externalLinks: result.externalLinks,
                tabId,
              });
            } catch (error) {
              broadcastComplete(item, {
                success: false,
                error: error && error.message ? error.message : String(error),
              }, tabId);
            }
            return;
          }
          const historyRecord = buildDownloadHistoryRecord(item, result);
          if (historyRecord) {
            try {
              await markDownloaded(historyRecord);
            } catch (err) {
              console.warn("[Background] markDownloaded failed", err);
            }
          }
          broadcastComplete(item, result, tabId);
        } catch (err) {
          broadcastComplete(
            item,
            {
              success: false,
              error: err && err.message ? err.message : String(err),
            },
            tabId
          );
        }
      })();
      return false;
    },

    startDownloadBatch: ({ message, sender, sendResponse }) => {
      let items;
      let scope;
      try {
        if (!Array.isArray(message.items) || message.items.length === 0 || message.items.length > 5000) {
          throw new Error("Invalid or oversized download batch");
        }
        items = message.items.map(normalizeDownloadItem);
        const first = items[0];
        const service = message.service
          ? requiredIdentity(message.service, "service")
          : first.service;
        const userId = message.userId
          ? requiredIdentity(message.userId, "creator id")
          : first.userId;
        if (items.some((item) => item.service !== service || item.userId !== userId)) {
          throw new Error("Mixed-creator download batches are not supported");
        }
        scope = {
          service,
          userId,
          aggregateExternalLinks: message.aggregateExternalLinks === true,
          linksFileName: optionalShortString(message.linksFileName, 512),
          linksPostId: optionalShortString(message.linksPostId, 512),
          requestId: normalizeRequestId(message.requestId),
        };
        sendResponse({ success: true, accepted: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error) });
        return false;
      }
      const tabId = getSenderTabId(sender);
      runAcceptedTask(
        "startDownloadBatch",
        () => runDownloadBatch(items, sender, scope),
        scope,
        tabId
      );
      return false;
    },

    "creator.fetch": ({ message, sender, sendResponse }) => {
      let origin;
      let service;
      let userId;
      const mode = UTIL.normalizeCreatorFetchMode(message.mode, message.fullMode);
      try {
        origin = normalizeSupportedOrigin(message.origin || API.DEFAULT_ORIGIN);
        service = requiredIdentity(message.service, "service");
        userId = requiredIdentity(message.userId, "creator id");
        if (mode === "dms" && !isPawOrigin(origin)) {
          throw new Error("DM fetch is available only for Pawchive creator URLs");
        }
        if (message.source === "coomerfans" && !isCoomerFansOrigin(origin)) {
          throw new Error("Invalid CoomerFans creator origin");
        }
        sendResponse({ success: true, accepted: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error) });
        return false;
      }
      const tabId = getSenderTabId(sender);
      runAcceptedTask("creator.fetch", async () => {
        const { creatorName } = message;
        const scope = {
          service,
          userId,
          origin,
          referer: `${origin}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}`,
          mode,
          fullMode: mode === "full",
          aggregateExternalLinks: true,
          linksFileName: linksFileName("creator", service, userId),
          linksPostId: "creator-links",
          requestId: normalizeRequestId(message.requestId),
        };

        if (mode === "dms") {
          await runPawchiveDmsFetch(service, userId, sender, scope);
          return;
        }

        if (message.source === "coomerfans" || isCoomerFansOrigin(origin)) {
          const allItems = await fetchCoomerFansCreatorItems(origin, service, userId, creatorName);
          await runCreatorFetchBatch(allItems, sender, scope);
          return;
        }

        if (isPawOrigin(origin)) {
          const posts = await fetchAllPawchiveCreatorPosts(service, userId);
          const allItems = posts
            .filter(isCompletePawchivePost)
            .map((post) => pawPostToDownloadItem(service, userId, post));
          await runCreatorFetchBatch(allItems, sender, scope);
          return;
        }

        const posts = await fetchCreatorPosts(origin, service, userId);
        const allItems = posts.map((post) =>
          postToDownloadItem(origin, service, userId, post, mode === "links")
        );
        await runCreatorFetchBatch(allItems, sender, scope);
      }, { service, userId, requestId: normalizeRequestId(message.requestId) }, tabId);
      return false;
    },

    "creator.pageFetch": ({ message, sender, sendResponse }) => {
      let service;
      let userId;
      let origin;
      let offset;
      try {
        service = requiredIdentity(message.service, "service");
        userId = requiredIdentity(message.userId, "creator id");
        origin = resolveOrigin(message, sender);
        offset = normalizePageOffset(message.offset);
        sendResponse({ success: true, accepted: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error) });
        return false;
      }
      const tabId = getSenderTabId(sender);
      runAcceptedTask("creator.pageFetch", async () => {
        const posts = await fetchCreatorPage(origin, service, userId, offset);
        const allItems = isPawOrigin(origin)
          ? posts.filter(isCompletePawchivePost).map((post) => pawPostToDownloadItem(service, userId, post))
          : posts.filter((post) => post && post.id).map((post) => postToDownloadItem(origin, service, userId, post));
        await runFilteredDownloadBatch(allItems, sender, {
          service,
          userId,
          origin,
          referer: `${origin}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}`,
          aggregateExternalLinks: true,
          linksFileName: linksFileName("page", service, userId, offset),
          linksPostId: `page-links-${offset}`,
          requestId: normalizeRequestId(message.requestId),
        });
      }, { service, userId, requestId: normalizeRequestId(message.requestId) }, tabId);
      return false;
    },
  };
}
