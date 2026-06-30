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

export function shouldMarkResult(result) {
  if (!result || !result.success) return false;
  if (result.noFiles === true) return true;
  if (result.backend === true) return true;
  if (result.alreadyDownloaded === true) return true;
  if (typeof result.successCount === "number" && result.successCount > 0) {
    return true;
  }
  if (Array.isArray(result.results)) {
    return result.results.some((item) => item && item.success);
  }
  return false;
}
