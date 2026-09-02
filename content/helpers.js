// content/helpers.js - utility helpers for content scripts

const CONFIG = { INIT_DELAY: 300 };
const EXTENSION_CONTEXT_INVALIDATED_EVENT = "kd:extensioncontextinvalidated";
let extensionContextInvalidated = false;

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error || "");
}

function isExtensionContextInvalidatedError(error) {
  return error?.code === "EXTENSION_CONTEXT_INVALIDATED"
    || /Extension context invalidated/i.test(getErrorMessage(error));
}

function createExtensionContextInvalidatedError(cause) {
  const error = new Error("Extension context invalidated");
  error.code = "EXTENSION_CONTEXT_INVALIDATED";
  if (cause !== undefined) error.cause = cause;
  return error;
}

function invalidateExtensionContext() {
  if (extensionContextInvalidated) return;
  extensionContextInvalidated = true;
  try {
    window.dispatchEvent(new Event(EXTENSION_CONTEXT_INVALIDATED_EVENT));
  } catch { }
}

function isExtensionContextAvailable() {
  if (extensionContextInvalidated) return false;
  try {
    if (!chrome?.runtime?.id) {
      invalidateExtensionContext();
      return false;
    }
  } catch {
    invalidateExtensionContext();
    return false;
  }
  return true;
}

// Parse URL path
function parseUrlPath(urlPath) {
  const path = String(urlPath || "");
  if (path.length > 4096) return null;
  const match = path.match(/^\/([^/]+)\/user\/([^/]+)(?:\/post\/([^/]+))?\/?$/);
  if (!match) return null;
  if (match[1].length > 128 || match[2].length > 512 || (match[3] && match[3].length > 512)) {
    return null;
  }
  return { service: match[1], userId: match[2], postId: match[3] || null };
}

function getSameOriginPath(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 8192) return null;
  try {
    const url = new URL(raw, location.href);
    return url.origin === location.origin ? url.pathname : null;
  } catch (error) {
    return null;
  }
}

// Safe wrapper around chrome.runtime.sendMessage with retries and timeout
function safeSendMessage(message, timeout = 5000, opts = { retries: 2, retryDelay: 300 }) {
  const attempt = (remainingRetries) => new Promise((resolve, reject) => {
    if (!isExtensionContextAvailable()) {
      reject(createExtensionContextInvalidatedError());
      return;
    }

    let finished = false;
    let timer = null;

    try {
      chrome.runtime.sendMessage(message, (response) => {
        try {
          if (finished) return;
          finished = true;
          if (timer) { clearTimeout(timer); timer = null; }
          if (chrome.runtime.lastError) {
            const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) ? chrome.runtime.lastError.message : '';
            if (isExtensionContextInvalidatedError(msg)) {
              invalidateExtensionContext();
              return reject(createExtensionContextInvalidatedError(msg));
            }
            if (remainingRetries > 0 && /message port closed|Could not establish connection/i.test(msg)) {
              setTimeout(() => { attempt(remainingRetries - 1).then(resolve).catch(reject); }, opts.retryDelay);
              return;
            }
            return reject(new Error(msg || 'Runtime lastError'));
          }
          if (!response) return reject(new Error('No response from extension'));
          if (response.success === false) {
            return reject(new Error(response.error || 'Extension request failed'));
          }
          return resolve(response);
        } catch (err) {
          if (isExtensionContextInvalidatedError(err)) {
            invalidateExtensionContext();
            return reject(createExtensionContextInvalidatedError(err));
          }
          return reject(err);
        }
      });
    } catch (err) {
      const emsg = getErrorMessage(err);
      if (isExtensionContextInvalidatedError(err)) {
        invalidateExtensionContext();
        return reject(createExtensionContextInvalidatedError(err));
      }
      if (remainingRetries > 0 && /message port closed|Could not establish connection/i.test(emsg)) {
        setTimeout(() => { attempt(remainingRetries - 1).then(resolve).catch(reject); }, opts.retryDelay);
        return;
      }
      return reject(err);
    }

    if (finished) return;
    timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        timer = null;
        const err = new Error('No response from extension (timeout)');
        // A timed-out request may already be executing in the service worker.
        // Retrying it can duplicate state-changing work, so only retry explicit
        // connection failures reported by the runtime callback.
        reject(err);
      }
    }, timeout);
  });

  return attempt(opts.retries);
}

function isHandledDownloadedStatus(status) {
  return status === 'complete' || status === 'empty';
}

// Read the persisted post state while preserving compatibility with older
// backgrounds that returned only a downloaded boolean.
async function getPostDownloadedStatus(service, userId, postId, options = {}) {
  try {
    const response = await safeSendMessage(
      { action: 'checkDownloaded', service, userId, postId, source: options.source },
      5000,
      { retries: 2, retryDelay: 300 }
    );
    if (response && ['complete', 'partial', 'empty'].includes(response.status)) {
      return response.status;
    }
    return response?.downloaded ? 'complete' : null;
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) throw error;
    console.warn('[Content] Check downloaded error:', error);
    return null;
  }
}

function downloadedKey(service, userId, postId, source) {
  const normalizedSource = String(source || '').toLowerCase() === 'coomerfans'
    ? 'coomerfans'
    : 'default';
  return JSON.stringify([
    normalizedSource,
    String(service || ''),
    String(userId || ''),
    String(postId || ''),
  ]);
}

function isActiveDownloadButton(btn) {
  const status = btn && btn.getAttribute('data-status');
  return status === 'SCANNING' || status === 'SENDING';
}

function isRenderCurrent(context) {
  return !context || typeof context.isCurrent !== 'function' || context.isCurrent();
}

function findDownloadButtonByPath(container, selector, path) {
  for (const button of container.querySelectorAll(selector)) {
    if (button.getAttribute('data-path') === path) return button;
  }
  return undefined;
}

function removeStaleDownloadButtons(selector, livePaths) {
  document.querySelectorAll(selector).forEach((btn) => {
    const path = btn.getAttribute('data-path');
    if (livePaths.has(path)) return;
    const parent = btn.parentElement;
    btn.remove();
    if (typeof releasePositionContext === 'function') releasePositionContext(parent);
  });
}

async function getDownloadedStatusMap(items) {
  const uniqueItems = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.service || !item.userId || !item.postId) continue;
    const normalized = {
      service: String(item.service),
      userId: String(item.userId),
      postId: String(item.postId),
      source: item.source,
    };
    uniqueItems.set(
      downloadedKey(normalized.service, normalized.userId, normalized.postId, normalized.source),
      normalized
    );
  }
  const validItems = Array.from(uniqueItems.values());
  if (validItems.length === 0) return new Map();

  try {
    const response = await safeSendMessage(
      { action: 'checkDownloadedMany', items: validItems },
      8000,
      { retries: 2, retryDelay: 300 }
    );
    const rawStatuses = response && response.statuses ? response.statuses : {};
    const rawDownloaded = response && response.downloaded ? response.downloaded : {};
    const statuses = new Map();
    for (const item of validItems) {
      const key = downloadedKey(item.service, item.userId, item.postId, item.source);
      const status = rawStatuses[key];
      statuses.set(
        key,
        ['complete', 'partial', 'empty'].includes(status)
          ? status
          : (rawDownloaded[key] ? 'complete' : null)
      );
    }
    return statuses;
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) throw error;
    console.warn('[Content] Batch downloaded check error:', error);
    return new Map();
  }
}
