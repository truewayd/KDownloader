// background/handlers/downloadHandlers.js - download and creator fetch RPCs
import { API, PAW } from "../constants.js";
import UTIL from "../util.js";
import { handleAPIRequest } from "../network.js";
import {
  dispatchExternalLinksTextTask,
  startCoomerFansDownload,
  startFullDownload,
  startPawchiveDownload,
  runSequentialDownloads,
} from "../download.js";
import {
  fetchAllPawchiveCreatorPosts,
  fetchPawchiveCreatorPage,
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
    return startPawchiveDownload(item.service, item.userId, item.postId, tabId, item.postData);
  }
  if (item.source === "coomerfans") {
    return startCoomerFansDownload(
      item.service,
      item.userId,
      item.postId,
      item.creatorName,
      tabId
    );
  }
  return startFullDownload(
    item.service,
    item.userId,
    item.postId,
    item.path,
    senderUrl,
    tabId
  );
}

function broadcastComplete(item, result, tabId) {
  safeBroadcast(
    {
      action: "downloadComplete",
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

function postContent(postData) {
  if (typeof postData?.content === "string") return postData.content;
  if (typeof postData?.post?.content === "string") return postData.post.content;
  return null;
}

async function extractItemExternalLinks(item) {
  if (item.source === "coomerfans") {
    const html = await fetchCoomerFansCreatorHtml(item.postUrl || item.path);
    return UTIL.extractExternalLinks(html);
  }

  const prefetchedContent = postContent(item.postData);
  if (prefetchedContent !== null) return UTIL.extractExternalLinks(prefetchedContent);
  if (item.site === "pawchive") return [];

  const origin = item.origin || API.DEFAULT_ORIGIN;
  const postUrl = `${origin}/${encodeURIComponent(item.service)}/user/${encodeURIComponent(item.userId)}/post/${encodeURIComponent(item.postId)}`;
  const apiUrl = `${origin}${API.API_PREFIX}/${encodeURIComponent(item.service)}/user/${encodeURIComponent(item.userId)}/post/${encodeURIComponent(item.postId)}`;
  const postData = await handleAPIRequest(apiUrl, {
    Accept: "text/css",
    "Content-Type": "text/css",
    Referer: postUrl,
  });
  return UTIL.extractExternalLinks(postContent(postData) || "");
}

async function runLinksOnlyBatch(items, sender, scope = {}) {
  const tabId = getSenderTabId(sender);
  const total = items.length;
  const batchId = createBatchId();
  const externalLinkEntries = [];
  let processed = 0;

  registerBatch(batchId, total);
  try {
    broadcastBatchProgress(scope, 0, total, tabId);
    for (const item of items) {
      try {
        const links = await extractItemExternalLinks(item);
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
            item,
            tasks: result.fallbackTasks,
            externalLinks: result.externalLinks,
            tabId,
          });
        } else {
          broadcastComplete(item, result, tabId);
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
          tabId
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
  for (const request of pending.requests || []) {
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
    const host = new URL(origin || API.COOMERFANS_ORIGIN).hostname.toLowerCase();
    return host === API.COOMERFANS_HOST || host.endsWith(`.${API.COOMERFANS_HOST}`);
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
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Cache-Control": "no-cache",
    "User-Agent": "Mozilla/5.0",
  };
  const resp = await fetch(url, { method: "GET", headers, credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
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
  const headers = {
    Accept: "text/css",
    "Content-Type": "text/css",
    Referer: `${origin}/${service}/user/${userId}`,
  };
  const profileUrl = `${origin}${API.API_PREFIX}/${service}/user/${userId}/profile`;
  const profile = await handleAPIRequest(profileUrl, headers);
  const postCount =
    profile && typeof profile.post_count === "number" ? profile.post_count : 0;
  const perPage = 50;
  const postMap = new Map();

  for (let offset = 0; offset < postCount; offset += perPage) {
    try {
      const url = `${origin}${API.API_PREFIX}/${service}/user/${userId}/posts?o=${offset}`;
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
    Referer: `${origin}/${service}/user/${userId}`,
  };
  const suffix = offset ? `?o=${offset}` : "";
  const url = `${origin}${API.API_PREFIX}/${service}/user/${userId}/posts${suffix}`;
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
    return new URL(origin).hostname.toLowerCase() === PAW.HOST;
  } catch (error) {
    return false;
  }
}

function resolveOrigin(message, sender) {
  const senderUrl = getSenderUrl(sender);
  if (senderUrl) {
    try {
      return new URL(senderUrl).origin;
    } catch (e) {
      /* fall through */
    }
  }
  return message.origin || API.DEFAULT_ORIGIN;
}

export function createDownloadHandlers() {
  return {
    startDownload: ({ message, sender, sendResponse }) => {
      try {
        sendResponse({ success: true, accepted: true });
      } catch (e) {
        /* ignore */
      }

      (async () => {
        const tabId = getSenderTabId(sender);
        const item = {
          service: message.service,
          userId: message.userId,
          postId: message.postId,
          path: message.path,
          source: message.source,
          creatorName: message.creatorName,
        };
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
      try {
        sendResponse({ success: true, accepted: true });
      } catch (e) {
        /* ignore */
      }
      const items = Array.isArray(message.items) ? message.items : [];
      const first = items[0] || {};
      const tabId = getSenderTabId(sender);
      runAcceptedTask(
        "startDownloadBatch",
        () => runDownloadBatch(items, sender, {
          service: message.service || first.service,
          userId: message.userId || first.userId,
          origin: message.origin,
          referer: message.referer,
          aggregateExternalLinks: message.aggregateExternalLinks === true,
          linksFileName: message.linksFileName,
          linksPostId: message.linksPostId,
        }),
        { service: first.service, userId: first.userId },
        tabId
      );
      return false;
    },

    "creator.fetch": ({ message, sender, sendResponse }) => {
      try {
        sendResponse({ success: true, accepted: true });
      } catch (e) {
        /* ignore */
      }
      const tabId = getSenderTabId(sender);
      runAcceptedTask("creator.fetch", async () => {
        const origin = message.origin || API.DEFAULT_ORIGIN;
        const { service, userId, creatorName } = message;
        if (!service || !userId) return;
        const mode = UTIL.normalizeCreatorFetchMode(message.mode, message.fullMode);
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
        };

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
      }, { service: message.service, userId: message.userId }, tabId);
      return false;
    },

    "creator.pageFetch": ({ message, sender, sendResponse }) => {
      try {
        sendResponse({ success: true, accepted: true });
      } catch (e) {
        /* ignore */
      }
      const tabId = getSenderTabId(sender);
      runAcceptedTask("creator.pageFetch", async () => {
        const { service, userId } = message;
        if (!service || !userId) return;
        const origin = resolveOrigin(message, sender);
        const offset =
          Number.isFinite(message.offset) || message.offset
            ? Number(message.offset)
            : null;
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
          linksFileName: linksFileName("page", service, userId, Number.isFinite(offset) ? offset : 0),
          linksPostId: `page-links-${Number.isFinite(offset) ? offset : 0}`,
        });
      }, { service: message.service, userId: message.userId }, tabId);
      return false;
    },
  };
}
