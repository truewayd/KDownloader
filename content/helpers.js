// content/helpers.js - utility helpers for content scripts

const CONFIG = { INIT_DELAY: 300 };
const accessReports = new Map();
const ACCESS_REPORT_INTERVAL_MS = 5 * 60 * 1000;

// Parse URL path
function parseUrlPath(urlPath) {
  const match = urlPath.match(/\/([^\/]+)\/user\/([^\/]+)(?:\/post\/([^\/]+))?/);
  if (!match) return null;
  return { service: match[1], userId: match[2], postId: match[3] || null };
}

// Safe wrapper around chrome.runtime.sendMessage with retries and timeout
function safeSendMessage(message, timeout = 5000, opts = { retries: 2, retryDelay: 300 }) {
  const attempt = (remainingRetries) => new Promise((resolve, reject) => {
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
            if (remainingRetries > 0 && /context invalidated|message port closed|Could not establish connection|Extension context invalidated/i.test(msg)) {
              setTimeout(() => { attempt(remainingRetries - 1).then(resolve).catch(reject); }, opts.retryDelay);
              return;
            }
            return reject(new Error(msg || 'Runtime lastError'));
          }
          return resolve(response);
        } catch (err) { return reject(err); }
      });
    } catch (err) {
      const emsg = err && err.message ? err.message : String(err);
      if (remainingRetries > 0 && /context invalidated|Extension context invalidated|message port closed/i.test(emsg)) {
        setTimeout(() => { attempt(remainingRetries - 1).then(resolve).catch(reject); }, opts.retryDelay);
        return;
      }
      return reject(err);
    }

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
  if (!service || !userId) return;
  const key = `${service}:${userId}`;
  const now = Date.now();
  if (now - (accessReports.get(key) || 0) < ACCESS_REPORT_INTERVAL_MS) return;
  accessReports.set(key, now);
  try {
    chrome.runtime.sendMessage(
      { action: 'creator.recordAccess', service, userId },
      () => { void chrome.runtime.lastError; }
    );
  } catch (e) { }
}
