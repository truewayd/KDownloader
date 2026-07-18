// content/helpers.js - utility helpers for content scripts

const CONFIG = { INIT_DELAY: 300 };
const accessReports = new Map();
const ACCESS_REPORT_INTERVAL_MS = 5 * 60 * 1000;
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
  const match = urlPath.match(/\/([^\/]+)\/user\/([^\/]+)(?:\/post\/([^\/]+))?/);
  if (!match) return null;
  return { service: match[1], userId: match[2], postId: match[3] || null };
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
        if (remainingRetries > 0) {
          setTimeout(() => { attempt(remainingRetries - 1).then(resolve).catch(reject); }, opts.retryDelay);
        } else {
          reject(err);
        }
      }
    }, timeout);
  });

  return attempt(opts.retries);
}

// Check if post is downloaded
async function isPostDownloaded(service, userId, postId, options = {}) {
  try {
    const response = await safeSendMessage(
      { action: 'checkDownloaded', service, userId, postId, source: options.source },
      5000,
      { retries: 2, retryDelay: 300 }
    );
    return !!(response && response.downloaded);
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) throw error;
    console.warn('[Content] Check downloaded error:', error);
    return false;
  }
}

function downloadedKey(service, userId, postId, source) {
  const prefix = String(source || '').toLowerCase() === 'coomerfans' ? 'coomerfans:' : '';
  return `${prefix}${String(service || '')}:${String(userId || '')}:${String(postId || '')}`;
}

function isActiveDownloadButton(btn) {
  const status = btn && btn.getAttribute('data-status');
  return status === 'SCANNING' || status === 'SENDING';
}

function isRenderCurrent(context) {
  return !context || typeof context.isCurrent !== 'function' || context.isCurrent();
}

function findDownloadButtonByPath(container, selector, path) {
  return Array.from(container.querySelectorAll(selector)).find((btn) =>
    btn.getAttribute('data-path') === path
  );
}

function removeStaleDownloadButtons(selector, livePaths) {
  document.querySelectorAll(selector).forEach((btn) => {
    const path = btn.getAttribute('data-path');
    if (!livePaths.has(path)) btn.remove();
  });
}

async function getDownloadedStatusMap(items) {
  const validItems = (Array.isArray(items) ? items : [])
    .filter(item => item && item.service && item.userId && item.postId)
    .map(item => ({
      service: String(item.service),
      userId: String(item.userId),
      postId: String(item.postId),
      source: item.source,
    }));
  if (validItems.length === 0) return new Map();

  try {
    const response = await safeSendMessage(
      { action: 'checkDownloadedMany', items: validItems },
      8000,
      { retries: 2, retryDelay: 300 }
    );
    const raw = response && response.downloaded ? response.downloaded : {};
    return new Map(Object.entries(raw));
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) throw error;
    console.warn('[Content] Batch downloaded check error:', error);
    return new Map();
  }
}

// Report access helper
function reportAccessIfApplicable() {
  try {
    const m = location.pathname.match(/\/([^\/]+)\/user\/([^\/]+)/);
    if (!m) return;
    reportCreatorAccess(m[1], m[2]);
  } catch (e) { }
}

function reportCreatorAccess(service, userId) {
  if (!service || !userId || !isExtensionContextAvailable()) return;
  const key = `${service}:${userId}`;
  const now = Date.now();
  if (now - (accessReports.get(key) || 0) < ACCESS_REPORT_INTERVAL_MS) return;
  accessReports.set(key, now);
  try {
    chrome.runtime.sendMessage(
      { action: 'creator.recordAccess', service, userId },
      () => {
        const error = chrome.runtime.lastError;
        if (isExtensionContextInvalidatedError(error)) invalidateExtensionContext();
      }
    );
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) invalidateExtensionContext();
  }
}
