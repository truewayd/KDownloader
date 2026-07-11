// background/handlers/downloadHandlers.js - download and creator fetch RPCs
import { API, PAW } from "../constants.js";
import { handleAPIRequest } from "../network.js";
import {
  startCoomerFansDownload,
  startFullDownload,
  startPawchiveDownload,
} from "../download.js";
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
    isPawSender
  );
}

async function runSingleDownload(item, sender, tabId) {
  const senderUrl = getSenderUrl(sender);
  if (isPawRequest(item, senderUrl)) {
    return startPawchiveDownload(item.service, item.userId, item.postId, tabId, senderUrl);
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

async function runDownloadBatch(items, sender, scope = {}) {
  const tabId = getSenderTabId(sender);
  const total = items.length;
  const historyRecords = [];
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
        broadcastComplete(item, result, tabId);
        const historyRecord = buildDownloadHistoryRecord(item, result);
        if (historyRecord) {
          historyRecords.push(historyRecord);
          if (historyRecord.status !== "partial") updateAcked(batchId, 1);
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
  } finally {
    completeBatch(batchId);
  }
}

function postToDownloadItem(origin, service, userId, post) {
  return {
    service,
    userId,
    postId: String(post.id),
    path: `${origin}${post.file && post.file.path ? post.file.path : ""}`,
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

async function runFilteredDownloadBatch(allItems, sender, scope) {
  const items = await filterUndownloaded(allItems);
  await runDownloadBatch(items, sender, scope);
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
        () => runDownloadBatch(items, sender),
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

        if (message.source === "coomerfans" || isCoomerFansOrigin(origin)) {
          const allItems = await fetchCoomerFansCreatorItems(origin, service, userId, creatorName);
          await runFilteredDownloadBatch(allItems, sender, { service, userId });
          return;
        }

        const posts = await fetchCreatorPosts(origin, service, userId);
        const allItems = posts.map((post) =>
          postToDownloadItem(origin, service, userId, post)
        );
        await runFilteredDownloadBatch(allItems, sender, { service, userId });
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
        const allItems = posts
          .filter((post) => post && post.id)
          .map((post) => postToDownloadItem(origin, service, userId, post));
        await runFilteredDownloadBatch(allItems, sender, { service, userId });
      }, { service: message.service, userId: message.userId }, tabId);
      return false;
    },
  };
}
