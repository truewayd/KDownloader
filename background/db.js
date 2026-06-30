// background/db.js - database helpers for download history & access
import {
  STORAGE_KEY,
  STORAGE_VERSION_KEY,
  LAST_ACCESS_KEY,
  SYNC_VERSION_ALARM,
  CREATOR_FLAG_KEY,
} from "./constants.js";

let downloadedCache = null;
let downloadedLoadPromise = null;

function normalizeDownloaded(raw = {}) {
  const normalized = {};
  for (const [service, users] of Object.entries(raw || {})) {
    if (!users || typeof users !== "object") continue;
    normalized[service] = {};
    for (const [userId, posts] of Object.entries(users)) {
      normalized[service][userId] = new Set(Array.isArray(posts) ? posts.map(String) : []);
    }
  }
  return normalized;
}

function serializeDownloaded(data = {}) {
  const serial = {};
  for (const [service, users] of Object.entries(data)) {
    serial[service] = {};
    for (const [userId, posts] of Object.entries(users)) {
      serial[service][userId] = Array.from(posts);
    }
  }
  return serial;
}

function ensureBucket(db, service, userId) {
  const svc = String(service || "");
  const uid = String(userId || "");
  if (!db[svc]) db[svc] = {};
  if (!db[svc][uid]) db[svc][uid] = new Set();
  return db[svc][uid];
}

function cloneDB(data = {}) {
  const out = {};
  for (const [service, users] of Object.entries(data)) {
    out[service] = {};
    for (const [userId, posts] of Object.entries(users)) {
      out[service][userId] = new Set(posts);
    }
  }
  return out;
}

async function getDownloadedCache() {
  if (downloadedCache) return downloadedCache;
  if (!downloadedLoadPromise) {
    downloadedLoadPromise = chrome.storage.local
      .get(STORAGE_KEY)
      .then((r) => {
        downloadedCache = normalizeDownloaded(r[STORAGE_KEY] || {});
        return downloadedCache;
      })
      .finally(() => {
        downloadedLoadPromise = null;
      });
  }
  return downloadedLoadPromise;
}

export async function loadDB() {
  return cloneDB(await getDownloadedCache());
}

export async function saveDB(data) {
  downloadedCache = normalizeDownloaded(serializeDownloaded(data));
  const serial = serializeDownloaded(downloadedCache);
  await chrome.storage.local.set({ [STORAGE_KEY]: serial });
}

export async function checkDownloaded(service, userId, postId) {
  const db = await getDownloadedCache();
  const svc = String(service || "");
  const uid = String(userId || "");
  const pid = String(postId || "");
  return !!(
    db[svc] &&
    db[svc][uid] &&
    db[svc][uid].has(pid)
  );
}

export async function checkDownloadedMany(items = []) {
  const db = await getDownloadedCache();
  const downloaded = {};
  for (const item of Array.isArray(items) ? items : []) {
    const service = String(item && item.service ? item.service : "");
    const userId = String(item && item.userId ? item.userId : "");
    const postId = String(item && item.postId ? item.postId : "");
    if (!service || !userId || !postId) continue;
    const key = `${service}:${userId}:${postId}`;
    downloaded[key] = !!(db[service] && db[service][userId] && db[service][userId].has(postId));
  }
  return downloaded;
}

export async function safeIncrementStorageVersion() {
  try {
    const res = await chrome.storage.sync.get(STORAGE_VERSION_KEY);
    const v = (res[STORAGE_VERSION_KEY] || 0) + 1;
    await chrome.storage.sync.set({ [STORAGE_VERSION_KEY]: v });
  } catch (e) {
    console.warn(
      "[Background] safeIncrementStorageVersion failed",
      e && e.message ? e.message : e
    );
    try {
      if (
        e &&
        e.message &&
        e.message.includes("MAX_WRITE_OPERATIONS_PER_MINUTE")
      ) {
        try {
          chrome.alarms.create(SYNC_VERSION_ALARM, { delayInMinutes: 1 });
        } catch (alarmErr) {
          console.warn("[Background] create alarm failed", alarmErr);
        }
      }
    } catch (ee) {}
  }
}

export async function markDownloaded(service, userId, postId) {
  const pid = String(postId || "");
  if (!service || !userId || !pid) return;
  const db = await getDownloadedCache();
  const posts = ensureBucket(db, service, userId);
  if (posts.has(pid)) return;
  posts.add(pid);
  await saveDB(db);
  await safeIncrementStorageVersion();
}

export async function markMultipleDownloaded(items) {
  const db = await getDownloadedCache();
  let changed = false;
  for (const { service, userId, postId } of Array.isArray(items) ? items : []) {
    if (!service || !userId || !postId) continue;
    const posts = ensureBucket(db, service, userId);
    const pid = String(postId);
    if (!posts.has(pid)) {
      posts.add(pid);
      changed = true;
    }
  }
  if (!changed) return;
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
    if (!jsonString || typeof jsonString !== "string") {
      throw new Error("Invalid input: expected non-empty string");
    }
    const trimmed = jsonString.trim();
    if (!trimmed) {
      throw new Error("Invalid input: empty string after trim");
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (parseErr) {
      const msg = parseErr.message || String(parseErr);
      if (
        msg.includes("Unterminated string") ||
        msg.includes("Unexpected end")
      ) {
        throw new Error(
          `JSON数据不完整或被截断。请确保导入的文件完整且未损坏。原始错误: ${msg}`
        );
      }
      throw new Error(`JSON格式错误: ${msg}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid JSON: expected object at root");
    }
    const data = {};
    for (const [service, users] of Object.entries(parsed)) {
      data[service] = {};
      for (const [userId, posts] of Object.entries(users)) {
        data[service][userId] = Array.isArray(posts) ? posts : [];
      }
    }
    downloadedCache = normalizeDownloaded(data);
    await chrome.storage.local.set({ [STORAGE_KEY]: serializeDownloaded(downloadedCache) });
    const res = await chrome.storage.sync.get(STORAGE_VERSION_KEY);
    const v = (res[STORAGE_VERSION_KEY] || 0) + 1;
    await chrome.storage.sync.set({ [STORAGE_VERSION_KEY]: v });
    return true;
  } catch (e) {
    console.error("[Background] importDB failed", e);
    throw e;
  }
}

export async function clearDB() {
  downloadedCache = {};
  await chrome.storage.local.set({ [STORAGE_KEY]: {} });
  await chrome.storage.sync.set({ [STORAGE_VERSION_KEY]: 0 });
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
  map[service][userId] =
    when instanceof Date ? when.toISOString() : new Date(when).toISOString();
  await saveLastAccess(map);
}

// Creator flag helpers
export async function loadCreatorFlags() {
  const r = await chrome.storage.local.get(CREATOR_FLAG_KEY);
  return r[CREATOR_FLAG_KEY] || {};
}

export async function saveCreatorFlags(flags) {
  await chrome.storage.local.set({ [CREATOR_FLAG_KEY]: flags });
}

export async function getCreatorFlag(service, userId) {
  const flags = await loadCreatorFlags();
  const key = `${service}:${userId}`;
  return flags[key] !== undefined ? flags[key] : null;
}

export async function setCreatorFlag(service, userId, value) {
  const flags = await loadCreatorFlags();
  const key = `${service}:${userId}`;
  flags[key] = !!value;
  await saveCreatorFlags(flags);
  return flags[key];
}
