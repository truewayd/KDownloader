// background/nativeFallback.js - persistent backend-failure confirmation queue
import { API, NATIVE_FALLBACK_KEY, PAW } from './constants.js';

const MAX_PENDING_AGE_MS = 60 * 60 * 1000;
const MAX_FALLBACK_REQUESTS = 5000;
const MAX_FALLBACK_TASKS_PER_REQUEST = 1000;
const MAX_FALLBACK_TASKS_TOTAL = 5000;
const TRUSTED_MEDIA_HOSTS = new Set([...API.HOSTS, API.COOMERFANS_HOST, PAW.HOST, PAW.FILE_HOST]);

function isTrustedMediaUrl(url) {
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  for (const trustedHost of TRUSTED_MEDIA_HOSTS) {
    if (host === trustedHost || host.endsWith(`.${trustedHost}`)) return true;
  }
  return false;
}

let stateQueue = Promise.resolve();

function withStateMutation(task) {
  const run = stateQueue.then(task, task);
  stateQueue = run.catch(() => {});
  return run;
}

function message(key, substitutions, fallback) {
  try {
    const localized = substitutions == null
      ? chrome.i18n.getMessage(key)
      : chrome.i18n.getMessage(key, substitutions);
    return localized || fallback;
  } catch (error) {
    return fallback;
  }
}

function notificationCreate(id, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(id, options, (notificationId) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(lastError.message || 'Notification failed'));
      else resolve(notificationId);
    });
  });
}

function notificationClear(id) {
  return new Promise((resolve) => {
    chrome.notifications.clear(id, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function loadPending() {
  const stored = await chrome.storage.session.get(NATIVE_FALLBACK_KEY);
  const value = stored[NATIVE_FALLBACK_KEY];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function savePending(pending) {
  if (Object.keys(pending).length === 0) {
    await chrome.storage.session.remove(NATIVE_FALLBACK_KEY);
  } else {
    await chrome.storage.session.set({ [NATIVE_FALLBACK_KEY]: pending });
  }
}

function normalizeRequest(request) {
  const item = request && request.item ? request.item : {};
  const tasks = Array.isArray(request && request.tasks)
    ? request.tasks.slice(0, MAX_FALLBACK_TASKS_PER_REQUEST).map((task) => {
        if (!task || typeof task !== 'object') return null;
        let url;
        try {
          const parsed = new URL(String(task.url || ''));
          if (!isTrustedMediaUrl(parsed)) return null;
          url = parsed.toString();
        } catch (error) {
          return null;
        }
        const fileName = String(task.fileName || '').trim();
        if (!fileName || fileName.length > 1024 || /[\0\r\n]/.test(fileName)) return null;
        return {
          url,
          fileName,
          type: String(task.type || '').slice(0, 64),
        };
      }).filter(Boolean)
    : [];
  const service = String(item.service || '').trim();
  const userId = String(item.userId || '').trim();
  const postId = String(item.postId || '').trim();
  if (
    !service || !userId || !postId || tasks.length === 0
    || [service, userId, postId].some((value) => value.length > 512 || /[\0\r\n]/.test(value))
  ) return null;
  const requestId = typeof item.requestId === 'string' && item.requestId.length <= 128
    ? item.requestId
    : undefined;
  return {
    item: {
      source: ['default', 'pawchive', 'coomerfans'].includes(item.source) ? item.source : undefined,
      service,
      userId,
      postId,
      requestId,
    },
    tasks,
    externalLinks: Array.isArray(request.externalLinks)
      ? request.externalLinks.slice(0, 5000).map((value) => {
          try {
            const parsed = new URL(String(value || ''));
            return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
              ? parsed.toString()
              : null;
          } catch (error) {
            return null;
          }
        }).filter(Boolean)
      : [],
    tabId: typeof request.tabId === 'number' ? request.tabId : null,
  };
}

export async function enqueueNativeFallback(requests) {
  const input = Array.isArray(requests) ? requests : [requests];
  if (input.length > MAX_FALLBACK_REQUESTS) throw new Error('Too many native fallback requests');
  const normalized = input
    .map(normalizeRequest)
    .filter(Boolean);
  if (normalized.length === 0) throw new Error('No native fallback tasks');
  const taskCount = normalized.reduce((count, request) => count + request.tasks.length, 0);
  if (taskCount > MAX_FALLBACK_TASKS_TOTAL) throw new Error('Too many native fallback tasks');

  const notificationId = `native-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await withStateMutation(async () => {
    const pending = await loadPending();
    const now = Date.now();
    for (const [id, entry] of Object.entries(pending)) {
      if (!entry || now - Number(entry.createdAt || 0) > MAX_PENDING_AGE_MS) delete pending[id];
    }
    pending[notificationId] = { createdAt: now, requests: normalized };
    await savePending(pending);
  });

  const fileCount = taskCount;
  try {
    await notificationCreate(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title: message('nativeFallbackTitle', null, 'Download backend unavailable'),
      message: message(
        'nativeFallbackMessage',
        [String(fileCount)],
        `The backend rejected ${fileCount} files. Continue with Chrome downloads?`
      ),
      buttons: [
        { title: message('continueDownloadAction', null, 'Continue download') },
        { title: message('cancelDownloadAction', null, 'Cancel download') },
      ],
      requireInteraction: true,
      priority: 2,
    });
    return notificationId;
  } catch (error) {
    await takeNativeFallback(notificationId);
    throw error;
  }
}

export function takeNativeFallback(notificationId) {
  return withStateMutation(async () => {
    const pending = await loadPending();
    const entry = pending[notificationId] || null;
    if (!entry) return null;
    delete pending[notificationId];
    await savePending(pending);
    const requests = [];
    let taskCount = 0;
    for (const value of (Array.isArray(entry.requests) ? entry.requests : []).slice(0, MAX_FALLBACK_REQUESTS)) {
      const request = normalizeRequest(value);
      if (!request || taskCount + request.tasks.length > MAX_FALLBACK_TASKS_TOTAL) continue;
      requests.push(request);
      taskCount += request.tasks.length;
    }
    return { createdAt: Number(entry.createdAt) || 0, requests };
  });
}

export async function clearNativeFallbackNotification(notificationId) {
  await notificationClear(notificationId);
}
