// content/helpers.js - utility helpers for content scripts

const CONFIG = { INIT_DELAY: 300 };

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
async function isPostDownloaded(service, userId, postId) {
  try {
    const response = await safeSendMessage({ action: 'checkDownloaded', service, userId, postId }, 5000, { retries: 2, retryDelay: 300 });
    return !!(response && response.downloaded);
  } catch (error) {
    console.warn('[Content] Check downloaded error:', error);
    return false;
  }
}

function downloadedKey(service, userId, postId) {
  return `${String(service || '')}:${String(userId || '')}:${String(postId || '')}`;
}

async function getDownloadedStatusMap(items) {
  const validItems = (Array.isArray(items) ? items : [])
    .filter(item => item && item.service && item.userId && item.postId)
    .map(item => ({
      service: String(item.service),
      userId: String(item.userId),
      postId: String(item.postId),
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
    const service = m[1];
    const userId = m[2];
    chrome.runtime.sendMessage({ action: 'creator.recordAccess', service, userId }, () => { });
  } catch (e) { }
}
