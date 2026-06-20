// background/db.js - database helpers for download history & access
import {
  STORAGE_KEY,
  STORAGE_VERSION_KEY,
  LAST_ACCESS_KEY,
  SYNC_VERSION_ALARM,
  CREATOR_FLAG_KEY,
} from "./constants.js";

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
  return !!(
    db[service] &&
    db[service][userId] &&
    db[service][userId].has(postId)
  );
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
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
    const res = await chrome.storage.sync.get(STORAGE_VERSION_KEY);
    const v = (res[STORAGE_VERSION_KEY] || 0) + 1;
    await chrome.storage.sync.set({ [STORAGE_VERSION_KEY]: v });
    return true;
  } catch (e) {
    console.error("[Background] importDB failed", e);
    throw e;
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
  console.log(`[DB] 📖 Getting creator flag for ${service}:${userId}`);
  const flags = await loadCreatorFlags();
  const key = `${service}:${userId}`;
  const result = flags[key] !== undefined ? flags[key] : null;
  console.log(
    `[DB] 📬 Creator flag for ${service}:${userId} = ${result} (from storage: ${flags[key]})`
  );
  return result;
}

export async function setCreatorFlag(service, userId, value) {
  console.log(
    `[DB] 💾 Setting creator flag for ${service}:${userId} to ${value}`
  );
  const flags = await loadCreatorFlags();
  const key = `${service}:${userId}`;
  flags[key] = !!value;
  console.log(`[DB] 💾 Normalized value: ${flags[key]}, saving to storage...`);
  await saveCreatorFlags(flags);
  console.log(
    `[DB] ✅ Creator flag saved for ${service}:${userId}, result: ${flags[key]}`
  );
  return flags[key];
}
