// background/messageHelpers.js - shared message handler utilities

export function respondWith(sendResponse, promise, mapValue = (value) => value) {
  promise
    .then((value) => sendResponse({ success: true, ...mapValue(value) }))
    .catch((err) =>
      sendResponse({
        success: false,
        error: err && err.message ? err.message : String(err),
      })
    );
  return true;
}

export function getSenderTabId(sender) {
  const id = sender && sender.tab ? sender.tab.id : undefined;
  return typeof id === "number" ? id : undefined;
}

export function getSenderUrl(sender) {
  return sender && sender.tab && sender.tab.url ? sender.tab.url : undefined;
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

  // Backend and Gopeed are fire-and-forget integrations. Once their endpoint
  // accepts a task, the extension has successfully completed its hand-off.
  if (result.backend === true && counts.successCount > 0) {
    return { ...identity, status: "complete", ...counts, updatedAt };
  }

  if (counts.totalCount > 0 && counts.successCount === counts.totalCount) {
    return { ...identity, status: "complete", ...counts, updatedAt };
  }

  if (counts.successCount > 0) {
    return { ...identity, status: "partial", ...counts, updatedAt };
  }

  return null;
}

export function shouldMarkResult(result) {
  return !!buildDownloadHistoryRecord({}, result);
}
