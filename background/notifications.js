// Shared system-notification presentation and Chrome callback handling.
export function notificationIconUrl(kind = 'info') {
  const name = ['error', 'warning', 'info', 'announcement', 'success'].includes(kind) ? kind : 'info';
  return chrome.runtime.getURL(`icons/notifications/${name}.png`);
}

function create(id, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(id, options, (notificationId) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message || 'Notification failed'));
      else resolve(notificationId);
    });
  });
}

export async function createNotification(id, { kind = 'info', ...options }) {
  const fallbackIcon = notificationIconUrl(kind);
  const presentation = {
    type: 'basic',
    contextMessage: 'KDownloader',
    eventTime: Date.now(),
    ...options,
    iconUrl: options.iconUrl || fallbackIcon,
  };
  // Preserve the business purpose when a creator avatar cannot be decoded.
  // If a generated icon is unavailable, the canonical brand is the final fallback.
  const candidates = [...new Set([presentation.iconUrl, fallbackIcon, chrome.runtime.getURL('icons/icon128.png')])];
  for (let index = 0; index < candidates.length; index++) {
    try {
      return await create(id, { ...presentation, iconUrl: candidates[index] });
    } catch (error) {
      if (index === candidates.length - 1) throw error;
    }
  }
}

export function clearNotification(id) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.clear(id, (cleared) => {
        const error = chrome.runtime.lastError;
        resolve(!error && cleared === true);
      });
    } catch {
      resolve(false);
    }
  });
}
