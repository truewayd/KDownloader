// background/nativeFallback.js - persistent backend-failure confirmation queue
import { NATIVE_FALLBACK_KEY } from './constants.js';

const MAX_PENDING_AGE_MS = 60 * 60 * 1000;

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
    ? request.tasks.filter((task) => task && task.url && task.fileName).map((task) => ({
        url: String(task.url),
        fileName: String(task.fileName),
        type: String(task.type || ''),
      }))
    : [];
  if (!item.service || !item.userId || !item.postId || tasks.length === 0) return null;
  return {
    item: {
      source: item.source,
      service: String(item.service),
      userId: String(item.userId),
      postId: String(item.postId),
    },
    tasks,
    externalLinks: Array.isArray(request.externalLinks) ? request.externalLinks.map(String) : [],
    tabId: typeof request.tabId === 'number' ? request.tabId : null,
  };
}

export async function enqueueNativeFallback(requests) {
  const normalized = (Array.isArray(requests) ? requests : [requests])
    .map(normalizeRequest)
    .filter(Boolean);
  if (normalized.length === 0) throw new Error('No native fallback tasks');

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

  const fileCount = normalized.reduce((count, request) => count + request.tasks.length, 0);
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
    return entry;
  });
}

export async function clearNativeFallbackNotification(notificationId) {
  await notificationClear(notificationId);
}
