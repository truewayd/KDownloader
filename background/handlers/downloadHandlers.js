// background/handlers/downloadHandlers.js - download and creator fetch RPCs
import { API } from "../constants.js";
import { handleAPIRequest } from "../network.js";
import { startFullDownload, startPawchiveDownload } from "../download.js";
import {
  checkDownloadedMany,
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
  getSenderTabId,
  getSenderUrl,
  safeBroadcast,
  shouldMarkResult,
} from "../messageHelpers.js";

function createBatchId() {
  return `batch:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function isPawRequest(item, senderUrl) {
  return (
    item.source === "pawchive" ||
    (typeof senderUrl === "string" && senderUrl.includes("pawchive.st"))
  );
}

async function runSingleDownload(item, sender, tabId) {
  const senderUrl = getSenderUrl(sender);
  if (isPawRequest(item, senderUrl)) {
    return startPawchiveDownload(item.service, item.userId, item.postId, tabId);
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

async function runDownloadBatch(items, sender, scope = {}) {
  const tabId = getSenderTabId(sender);
  const total = items.length;
  const succeeded = [];
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
        if (shouldMarkResult(result)) {
          succeeded.push({
            service: item.service,
            userId: item.userId,
            postId: item.postId,
          });
          updateAcked(batchId, 1);
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

    if (succeeded.length > 0) {
      try {
        await markMultipleDownloaded(succeeded);
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

async function filterUndownloaded(items) {
  const downloaded = await checkDownloadedMany(items);
  return items.filter((item) => {
    const key = `${item.service}:${item.userId}:${item.postId}`;
    return !downloaded[key];
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
        };
        try {
          const result = await runSingleDownload(item, sender, tabId);
          if (shouldMarkResult(result)) {
            try {
              await markDownloaded(item.service, item.userId, item.postId);
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
      runDownloadBatch(items, sender).catch((err) =>
        console.error("[Background] startDownloadBatch failed", err)
      );
      return false;
    },

    "creator.fetch": ({ message, sender, sendResponse }) => {
      try {
        sendResponse({ success: true, accepted: true });
      } catch (e) {
        /* ignore */
      }
      (async () => {
        const origin = message.origin || API.DEFAULT_ORIGIN;
        const { service, userId } = message;
        if (!service || !userId) return;

        const posts = await fetchCreatorPosts(origin, service, userId);
        const allItems = posts.map((post) =>
          postToDownloadItem(origin, service, userId, post)
        );
        const items = await filterUndownloaded(allItems);
        await runDownloadBatch(items, sender, { service, userId });
      })().catch((err) => console.error("[Background] creator.fetch failed", err));
      return false;
    },

    "creator.pageFetch": ({ message, sender, sendResponse }) => {
      try {
        sendResponse({ success: true, accepted: true });
      } catch (e) {
        /* ignore */
      }
      (async () => {
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
        const items = await filterUndownloaded(allItems);
        await runDownloadBatch(items, sender, { service, userId });
      })().catch((err) => console.error("[Background] creator.pageFetch failed", err));
      return false;
    },
  };
}
