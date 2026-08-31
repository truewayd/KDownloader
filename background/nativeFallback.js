// background/nativeFallback.js - persistent backend-failure confirmation queue
import { API, NATIVE_FALLBACK_KEY, PAW } from './constants.js';

const MAX_PENDING_AGE_MS = 60 * 60 * 1000;
const MAX_FALLBACK_REQUESTS = 5000;
const MAX_FALLBACK_TASKS_PER_REQUEST = 1000;
const MAX_FALLBACK_TASKS_TOTAL = 5000;
const MAX_PENDING_NOTIFICATIONS = 50;
const MAX_URL_LENGTH = 8192;
const MAX_EXTERNAL_LINKS_TOTAL = 5000;
const MAX_PENDING_STORAGE_BYTES = 8 * 1024 * 1024;
const TRUSTED_MEDIA_HOSTS = new Set([...API.HOSTS, API.COOMERFANS_HOST, PAW.HOST, PAW.FILE_HOST]);

export const NATIVE_FALLBACK_LIMITS = Object.freeze({
  maxRequests: MAX_FALLBACK_REQUESTS,
  maxTasksPerRequest: MAX_FALLBACK_TASKS_PER_REQUEST,
  maxTasksTotal: MAX_FALLBACK_TASKS_TOTAL,
  maxExternalLinksTotal: MAX_EXTERNAL_LINKS_TOTAL,
  maxStorageBytes: MAX_PENDING_STORAGE_BYTES,
});

function serializedStringByteLength(value) {
  const text = String(value || '');
  let bytes = 2;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code <= 0x1f) bytes += 6;
    else if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00
        && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

export function measureNativeFallbackRequest(request) {
  const rawTasks = Array.isArray(request?.tasks) ? request.tasks : [];
  const rawLinks = Array.isArray(request?.externalLinks) ? request.externalLinks : [];
  if (rawTasks.length > MAX_FALLBACK_TASKS_PER_REQUEST) {
    throw new Error(`Native fallback request exceeds ${MAX_FALLBACK_TASKS_PER_REQUEST} tasks`);
  }
  if (rawLinks.length > MAX_EXTERNAL_LINKS_TOTAL) {
    throw new Error(`Native fallback request exceeds ${MAX_EXTERNAL_LINKS_TOTAL} external links`);
  }

  const item = request?.item && typeof request.item === 'object' ? request.item : {};
  let bytes = 256;
  for (const value of [item.source, item.service, item.userId, item.postId, item.requestId]) {
    bytes += serializedStringByteLength(value);
  }
  for (const task of rawTasks) {
    const rawUrl = String(task?.url || '');
    const rawFileName = String(task?.fileName || '');
    const rawType = String(task?.type || '');
    if (rawUrl.length > MAX_URL_LENGTH || rawFileName.length > 1024 || rawType.length > 64) {
      throw new Error('Native fallback request contains oversized task metadata');
    }
    bytes += 96
      + serializedStringByteLength(rawUrl)
      + serializedStringByteLength(rawFileName)
      + serializedStringByteLength(rawType);
    if (bytes > MAX_PENDING_STORAGE_BYTES) {
      throw new Error('Native fallback request exceeds the 8 MiB safety limit');
    }
  }
  for (const link of rawLinks) {
    const rawLink = String(link || '');
    if (rawLink.length > MAX_URL_LENGTH) {
      throw new Error('Native fallback request contains an oversized external link');
    }
    bytes += 32 + serializedStringByteLength(rawLink);
    if (bytes > MAX_PENDING_STORAGE_BYTES) {
      throw new Error('Native fallback request exceeds the 8 MiB safety limit');
    }
  }
  return {
    requestCount: 1,
    taskCount: rawTasks.length,
    externalLinkCount: rawLinks.length,
    bytes,
  };
}

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
  stateQueue = run.then(() => undefined, () => undefined);
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.create(null);
  const pending = Object.create(null);
  for (const [id, entry] of Object.entries(value)) {
    if (typeof id === 'string' && id.length <= 256) pending[id] = entry;
  }
  return pending;
}

async function savePending(pending) {
  if (Object.keys(pending).length === 0) {
    await chrome.storage.session.remove(NATIVE_FALLBACK_KEY);
  } else {
    const serializable = Object.fromEntries(Object.entries(pending));
    if (new TextEncoder().encode(JSON.stringify(serializable)).byteLength > MAX_PENDING_STORAGE_BYTES) {
      throw new Error('Pending native fallback state exceeds the 8 MiB safety limit');
    }
    await chrome.storage.session.set({ [NATIVE_FALLBACK_KEY]: serializable });
  }
}

function normalizeRequest(request) {
  const item = request && request.item ? request.item : {};
  const tasks = Array.isArray(request && request.tasks)
    ? request.tasks.slice(0, MAX_FALLBACK_TASKS_PER_REQUEST).map((task) => {
        if (!task || typeof task !== 'object') return null;
        let url;
        try {
          const rawUrl = String(task.url || '');
          if (rawUrl.length > MAX_URL_LENGTH) return null;
          const parsed = new URL(rawUrl);
          if (!isTrustedMediaUrl(parsed)) return null;
          url = parsed.toString();
        } catch (error) {
          return null;
        }
        const fileName = String(task.fileName || '').trim();
        if (!fileName || fileName.length > 1024 || /[\x00-\x1f\x7f]/.test(fileName)) return null;
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
    || [service, userId, postId].some((value) => value.length > 512 || /[\x00-\x1f\x7f]/.test(value))
  ) return null;
  const requestId = typeof item.requestId === 'string' && item.requestId.length <= 128
    && !/[\x00-\x1f\x7f]/.test(item.requestId)
    ? item.requestId
    : undefined;
  return {
    item: {
      source: item.source === 'coomerfans'
        ? 'coomerfans'
        : (['default', 'pawchive'].includes(item.source) ? 'default' : undefined),
      service,
      userId,
      postId,
      requestId,
    },
    tasks,
    externalLinks: Array.isArray(request.externalLinks)
      ? request.externalLinks.slice(0, 5000).map((value) => {
          try {
            const rawUrl = String(value || '');
            if (rawUrl.length > MAX_URL_LENGTH) return null;
            const parsed = new URL(rawUrl);
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
  let rawTaskCount = 0;
  let rawExternalLinkCount = 0;
  let rawBytes = 0;
  for (const request of input) {
    const measured = measureNativeFallbackRequest(request);
    rawTaskCount += measured.taskCount;
    rawExternalLinkCount += measured.externalLinkCount;
    rawBytes += measured.bytes;
    if (rawTaskCount > MAX_FALLBACK_TASKS_TOTAL) throw new Error('Too many native fallback tasks');
    if (rawExternalLinkCount > MAX_EXTERNAL_LINKS_TOTAL) throw new Error('Too many native fallback external links');
    if (rawBytes > MAX_PENDING_STORAGE_BYTES) {
      throw new Error('Native fallback request exceeds the 8 MiB safety limit');
    }
  }
  const normalized = input
    .map(normalizeRequest)
    .filter(Boolean);
  if (normalized.length === 0) throw new Error('No native fallback tasks');
  const taskCount = normalized.reduce((count, request) => count + request.tasks.length, 0);
  if (taskCount > MAX_FALLBACK_TASKS_TOTAL) throw new Error('Too many native fallback tasks');

  const notificationSuffix = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const notificationId = `native-fallback-${notificationSuffix}`;
  await withStateMutation(async () => {
    const pending = await loadPending();
    const now = Date.now();
    for (const [id, entry] of Object.entries(pending)) {
      if (!entry || now - Number(entry.createdAt || 0) > MAX_PENDING_AGE_MS) delete pending[id];
    }
    const pendingEntries = Object.values(pending);
    const pendingTaskCount = pendingEntries.reduce((total, entry) => {
      const requests = Array.isArray(entry?.requests) ? entry.requests : [];
      return total + requests.reduce(
        (count, request) => count + (Array.isArray(request?.tasks) ? request.tasks.length : 0),
        0
      );
    }, 0);
    if (pendingEntries.length >= MAX_PENDING_NOTIFICATIONS) {
      throw new Error('Too many pending native fallback prompts');
    }
    if (pendingTaskCount + taskCount > MAX_FALLBACK_TASKS_TOTAL) {
      throw new Error('Too many pending native fallback tasks');
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
    if (Date.now() - Number(entry.createdAt || 0) > MAX_PENDING_AGE_MS) return null;
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
