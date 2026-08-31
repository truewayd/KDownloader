// background/messageHelpers.js - shared message handler utilities

export function respondWith(sendResponse, promise, mapValue = (value) => value) {
  Promise.resolve(promise).then(
    (value) => {
      let response;
      try {
        response = { success: true, ...mapValue(value) };
      } catch (error) {
        try {
          sendResponse({
            success: false,
            error: error && error.message ? error.message : String(error),
          });
        } catch (sendError) {
          // The response port has already closed.
        }
        return;
      }
      try {
        sendResponse(response);
      } catch (error) {
        // The message port may close while an asynchronous operation is in
        // flight. There is no useful recovery once the caller has gone away.
      }
    },
    (err) => {
      try {
        sendResponse({
          success: false,
          error: err && err.message ? err.message : String(err),
        });
      } catch (error) {
        // Ignore a closed response port for the same reason as above.
      }
    }
  );
  return true;
}

export function getSenderTabId(sender) {
  const id = sender && sender.tab ? sender.tab.id : undefined;
  return typeof id === "number" ? id : undefined;
}

export function getSenderUrl(sender) {
  if (sender && typeof sender.url === "string") return sender.url;
  return sender && sender.tab && sender.tab.url ? sender.tab.url : undefined;
}

export function isExtensionPageSender(sender) {
  if (!sender) return true;
  const senderUrl = getSenderUrl(sender);
  if (!senderUrl) return !sender.tab;
  try {
    const parsed = new URL(senderUrl);
    if (parsed.protocol !== "chrome-extension:") return false;
    const extensionId = globalThis.chrome?.runtime?.id;
    return !extensionId || parsed.hostname === extensionId;
  } catch (error) {
    return false;
  }
}

export function requireExtensionPage(sender, operation) {
  if (!isExtensionPageSender(sender)) {
    throw new Error(`${operation} is restricted to extension pages`);
  }
}

export function requireTrustedWebSender(sender, hosts, operation, { allowSubdomains = false } = {}) {
  const senderUrl = getSenderUrl(sender);
  try {
    const parsed = new URL(senderUrl);
    const hostname = parsed.hostname.toLowerCase();
    const trusted = (Array.isArray(hosts) ? hosts : []).some((host) => {
      const normalizedHost = String(host || "").toLowerCase();
      return hostname === normalizedHost
        || (allowSubdomains && hostname.endsWith(`.${normalizedHost}`));
    });
    if (
      parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && trusted
    ) return;
  } catch (error) {
    // Fall through to the uniform authorization error below.
  }
  throw new Error(`${operation} is restricted to supported site pages`);
}

export function safeBroadcast(payload, tabId) {
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
    /* ignore broadcast failures */
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ACCEPTED_REQUESTS = new Map();
const MAX_ACCEPTED_REQUESTS = 4096;
const ACTIVE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_REQUEST_TTL_MS = 10 * 60 * 1000;
const ACCEPTED_REQUEST_PRUNE_INTERVAL_MS = 60 * 1000;
let nextAcceptedRequestPruneAt = 0;

function pruneAcceptedRequests(now) {
  if (now < nextAcceptedRequestPruneAt
      && nextAcceptedRequestPruneAt - now <= ACCEPTED_REQUEST_PRUNE_INTERVAL_MS) return;
  nextAcceptedRequestPruneAt = now + ACCEPTED_REQUEST_PRUNE_INTERVAL_MS;
  for (const [key, entry] of ACCEPTED_REQUESTS) {
    const ttl = entry.active ? ACTIVE_REQUEST_TTL_MS : RECENT_REQUEST_TTL_MS;
    if (now - entry.updatedAt < ttl) continue;
    ACCEPTED_REQUESTS.delete(key);
  }
}

function makeAcceptedRequestRoom() {
  if (ACCEPTED_REQUESTS.size < MAX_ACCEPTED_REQUESTS) return;
  // Preserve every in-flight operation, but do not let a burst of completed
  // request IDs deny all new work for the full recent-request TTL.
  for (const [key, entry] of ACCEPTED_REQUESTS) {
    if (entry.active) continue;
    ACCEPTED_REQUESTS.delete(key);
    if (ACCEPTED_REQUESTS.size < MAX_ACCEPTED_REQUESTS) return;
  }
  throw new Error("Too many active background requests");
}

function acceptedRequestSenderKey(sender) {
  const tabId = getSenderTabId(sender);
  if (tabId !== undefined) return `tab:${tabId}`;
  return `page:${getSenderUrl(sender) || "extension"}`;
}

export function beginAcceptedRequest(action, requestId, sender) {
  if (requestId === undefined || requestId === null || requestId === "") {
    return { duplicate: false, token: null };
  }
  if (
    typeof requestId !== "string"
    || !requestId.trim()
    || requestId.length > 128
    || /[\x00-\x1f\x7f]/.test(requestId)
  ) {
    throw new Error("Invalid request id");
  }

  const now = Date.now();
  pruneAcceptedRequests(now);
  const key = JSON.stringify([String(action), acceptedRequestSenderKey(sender), requestId.trim()]);
  if (ACCEPTED_REQUESTS.has(key)) return { duplicate: true, token: null };
  makeAcceptedRequestRoom();
  const entry = { active: true, updatedAt: now };
  const token = { key, entry };
  ACCEPTED_REQUESTS.set(key, entry);
  return { duplicate: false, token };
}

export function completeAcceptedRequest(token) {
  if (!token || typeof token.key !== "string") return;
  const entry = ACCEPTED_REQUESTS.get(token.key);
  if (!entry || entry !== token.entry) return;
  entry.active = false;
  entry.updatedAt = Date.now();
}

function getResultCounts(result) {
  const results = Array.isArray(result && result.results) ? result.results : [];
  const countedSuccesses = results.reduce(
    (count, item) => count + (item && item.success ? 1 : 0),
    0
  );
  const rawSuccessCount = Number.isFinite(result && result.successCount)
    ? Math.max(0, Math.floor(result.successCount))
    : countedSuccesses;
  const totalCount = results.length > 0 ? results.length : rawSuccessCount;
  const successCount = totalCount > 0
    ? Math.min(rawSuccessCount, totalCount)
    : rawSuccessCount;

  return {
    totalCount,
    successCount,
    failedCount: Math.max(0, totalCount - successCount),
  };
}

export function buildDownloadHistoryRecord(item, result) {
  if (!item || !result || !result.success || result.alreadyDownloaded === true || result.skippedByFilter === true) {
    return null;
  }

  const identity = {
    source: item.source,
    service: item.service,
    userId: item.userId,
    postId: item.postId,
  };
  const counts = getResultCounts(result);
  const updatedAt = new Date().toISOString();

  if (result.noFiles === true) {
    return { ...identity, status: "empty", ...counts, updatedAt };
  }

  if (counts.totalCount > 0 && counts.successCount === counts.totalCount) {
    return { ...identity, status: "complete", ...counts, updatedAt };
  }

  if (counts.successCount > 0) {
    return { ...identity, status: "partial", ...counts, updatedAt };
  }

  return null;
}
