// background/db.js - database helpers for download history & access
import { STORAGE_KEY, STORAGE_VERSION_KEY, LAST_ACCESS_KEY, SYNC_VERSION_ALARM } from './constants.js';

export async function loadDB() {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  const raw = r[STORAGE_KEY] || {};
  const normalized = {};
  for (const [service, users] of Object.entries(raw)) {
    normalized[service] = {};
    for (const [userId, posts] of Object.entries(users)) {
      normalized[service][userId] = new Set(Array.isArray(posts) ? posts : []);
    }
  }
  return normalized;
}

export async function saveDB(data) {
  const serial = {};
  for (const [service, users] of Object.entries(data)) {
    serial[service] = {};
    for (const [userId, posts] of Object.entries(users)) {
      serial[service][userId] = Array.from(posts);
    }
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: serial });
}

export async function checkDownloaded(service, userId, postId) {
  const db = await loadDB();
  return !!(db[service] && db[service][userId] && db[service][userId].has(postId));
}

export async function safeIncrementStorageVersion() {
  try {
    const res = await chrome.storage.sync.get(STORAGE_VERSION_KEY);
    const v = (res[STORAGE_VERSION_KEY] || 0) + 1;
    await chrome.storage.sync.set({ [STORAGE_VERSION_KEY]: v });
  } catch (e) {
    console.warn('[Background] safeIncrementStorageVersion failed', e && e.message ? e.message : e);
    try {
      if (e && e.message && e.message.includes('MAX_WRITE_OPERATIONS_PER_MINUTE')) {
        try { chrome.alarms.create(SYNC_VERSION_ALARM, { delayInMinutes: 1 }); } catch (alarmErr) { console.warn('[Background] create alarm failed', alarmErr); }
      }
    } catch (ee) { }
  }
}

export async function markDownloaded(service, userId, postId) {
  const db = await loadDB();
  if (!db[service]) db[service] = {};
  if (!db[service][userId]) db[service][userId] = new Set();
  db[service][userId].add(postId);
  await saveDB(db);
  await safeIncrementStorageVersion();
}

export async function markMultipleDownloaded(items) {
  const db = await loadDB();
  for (const { service, userId, postId } of items) {
    if (!db[service]) db[service] = {};
    if (!db[service][userId]) db[service][userId] = new Set();
    db[service][userId].add(postId);
  }
  await saveDB(db);
  await safeIncrementStorageVersion();
}

export async function exportDB() {
  const db = await loadDB();
  const out = {};
  for (const [service, users] of Object.entries(db)) {
    out[service] = {};
    for (const [userId, posts] of Object.entries(users)) {
      out[service][userId] = Array.from(posts);
    }
  }
  return JSON.stringify(out, null, 2);
}

export async function importDB(jsonString) {
  try {
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (parseErr) {
      console.warn('[Background] Initial JSON parse failed, attempting repair', parseErr);
      const cleaned = jsonString
        .replace(/\r\n/g, '\\n')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
      parsed = JSON.parse(cleaned);
    }
    const data = {};
    for (const [service, users] of Object.entries(parsed)) {
      data[service] = {};
      for (const [userId, posts] of Object.entries(users)) {
        data[service][userId] = Array.isArray(posts) ? posts : [];
      }
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
    const res = await chrome.storage.sync.get(STORAGE_VERSION_KEY);
    const v = (res[STORAGE_VERSION_KEY] || 0) + 1;
    await chrome.storage.sync.set({ [STORAGE_VERSION_KEY]: v });
    return true;
  } catch (e) {
    console.error('[Background] importDB failed', e);
    return false;
  }
}

export async function loadLastAccess() {
  const r = await chrome.storage.sync.get(LAST_ACCESS_KEY);
  const raw = r[LAST_ACCESS_KEY] || {};
  const out = {};
  for (const [svc, users] of Object.entries(raw)) {
    out[svc] = { ...users };
  }
  return out;
}

export async function saveLastAccess(map) {
  await chrome.storage.sync.set({ [LAST_ACCESS_KEY]: map });
}

export async function setLastAccess(service, userId, when = new Date()) {
  const map = await loadLastAccess();
  if (!map[service]) map[service] = {};
  map[service][userId] = (when instanceof Date ? when.toISOString() : new Date(when).toISOString());
  await saveLastAccess(map);
}
