// background/db.js - IndexedDB-backed download history and small storage helpers
import {
  STORAGE_VERSION_KEY,
  LAST_ACCESS_KEY,
  CREATOR_FLAG_KEY,
} from "./constants.js";

const HISTORY_DB_NAME = "kdownloaderHistory";
const HISTORY_DB_VERSION = 2;
const HISTORY_STORE = "records";
const IMPORT_STORE = "importRecords";
const IMPORT_META_STORE = "importSessions";
const ACTIVE_GENERATION_ID = "__active_generation__";
const HISTORY_SCHEMA_VERSION = 2;
const HISTORY_STATUSES = new Set(["complete", "partial", "empty"]);
const HANDLED_STATUSES = new Set(["complete", "empty"]);

let historyDbPromise = null;
let revisionCounter = 0;
let activeGenerationCache;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function openHistoryDB() {
  if (historyDbPromise) return historyDbPromise;
  historyDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const store = db.createObjectStore(HISTORY_STORE, {
          keyPath: ["source", "service", "userId", "postId"],
        });
        store.createIndex("creator", ["source", "service", "userId"], { unique: false });
        store.createIndex("status", "status", { unique: false });
      }
      if (!db.objectStoreNames.contains(IMPORT_STORE)) {
        const importStore = db.createObjectStore(IMPORT_STORE, {
          keyPath: ["sessionId", "source", "service", "userId", "postId"],
        });
        importStore.createIndex("sessionId", "sessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains(IMPORT_META_STORE)) {
        db.createObjectStore(IMPORT_META_STORE, { keyPath: "sessionId" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        historyDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      historyDbPromise = null;
      reject(request.error || new Error("Failed to open history database"));
    };
    request.onblocked = () => {
      console.warn("[Background] history database upgrade is blocked");
    };
  });
  return historyDbPromise;
}

function normalizedIdentity(value, field, strict) {
  if (strict && (typeof value !== "string" || !value.trim())) {
    throw new Error(`Invalid history record: ${field} must be a non-empty string`);
  }
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Invalid history record: missing ${field}`);
  return normalized;
}

function normalizeSource(value, strict) {
  if (strict && (typeof value !== "string" || !value.trim())) {
    throw new Error("Invalid history record: source must be a non-empty string");
  }
  return String(value || "default").trim().toLowerCase() || "default";
}

function normalizeCount(value, field, strict, fallback = 0) {
  if (strict && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`Invalid history record: ${field} must be a non-negative integer`);
  }
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function estimateRecordBytes(record) {
  return 256 + (
    record.source.length +
    record.service.length +
    record.userId.length +
    record.postId.length +
    record.status.length +
    record.updatedAt.length
  ) * 2;
}

function normalizeHistoryRecord(input, { strict = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid history record: expected object");
  }

  const status = input.status || "complete";
  if (!HISTORY_STATUSES.has(status)) {
    throw new Error(`Invalid history record status: ${String(status)}`);
  }

  if (strict) {
    for (const field of ["source", "service", "userId", "postId", "status", "totalCount", "successCount", "failedCount", "updatedAt"]) {
      if (!Object.prototype.hasOwnProperty.call(input, field)) {
        throw new Error(`Invalid history record: missing ${field}`);
      }
    }
  }

  const totalCount = normalizeCount(input.totalCount, "totalCount", strict, status === "empty" ? 0 : 1);
  const successCount = normalizeCount(input.successCount, "successCount", strict, status === "empty" ? 0 : totalCount);
  const failedCount = normalizeCount(input.failedCount, "failedCount", strict, Math.max(0, totalCount - successCount));
  const updatedAt = input.updatedAt || new Date().toISOString();
  if (strict && (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt)))) {
    throw new Error("Invalid history record: updatedAt must be an ISO date string");
  }

  if (status === "empty" && (totalCount !== 0 || successCount !== 0 || failedCount !== 0)) {
    throw new Error("Invalid empty history record counts");
  }
  if (successCount + failedCount > totalCount && totalCount > 0) {
    throw new Error("Invalid history record counts");
  }

  const record = {
    source: normalizeSource(input.source, strict),
    service: normalizedIdentity(input.service, "service", strict),
    userId: normalizedIdentity(input.userId, "userId", strict),
    postId: normalizedIdentity(input.postId, "postId", strict),
    status,
    totalCount,
    successCount,
    failedCount,
    updatedAt: new Date(updatedAt).toISOString(),
  };
  const approximateBytes = estimateRecordBytes(record);
  if (approximateBytes > 256 * 1024) {
    throw new Error("History record exceeds the 256 KiB safety limit");
  }
  return record;
}

function historyKey(service, userId, postId, source) {
  return [
    normalizeSource(source, false),
    normalizedIdentity(service, "service", false),
    normalizedIdentity(userId, "userId", false),
    normalizedIdentity(postId, "postId", false),
  ];
}

function generationKey(generation, service, userId, postId, source) {
  return [generation, ...historyKey(service, userId, postId, source)];
}

export function downloadedItemKey(service, userId, postId, source) {
  const prefix = normalizeSource(source, false) === "coomerfans" ? "coomerfans:" : "";
  return `${prefix}${String(service || "")}:${String(userId || "")}:${String(postId || "")}`;
}

async function getActiveGeneration() {
  if (activeGenerationCache !== undefined) return activeGenerationCache;
  const db = await openHistoryDB();
  const transaction = db.transaction(IMPORT_META_STORE, "readonly");
  const active = await requestToPromise(
    transaction.objectStore(IMPORT_META_STORE).get(ACTIVE_GENERATION_ID)
  );
  activeGenerationCache = active && active.generation ? active.generation : null;
  return activeGenerationCache;
}

function stripGeneration(staged) {
  const { sessionId: ignored, ...record } = staged;
  return record;
}

async function readAllHistoryRecords() {
  const db = await openHistoryDB();
  const generation = await getActiveGeneration();
  if (!generation) {
    const transaction = db.transaction(HISTORY_STORE, "readonly");
    return requestToPromise(transaction.objectStore(HISTORY_STORE).getAll());
  }
  const transaction = db.transaction(IMPORT_STORE, "readonly");
  const staged = await requestToPromise(
    transaction.objectStore(IMPORT_STORE).index("sessionId").getAll(generation)
  );
  return staged.map(stripGeneration);
}

async function replaceAllHistoryRecords(records) {
  const sessionId = await beginImportSession({
    schemaVersion: HISTORY_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    expectedRecords: records.length,
  });
  try {
    for (let offset = 0, sequence = 0; offset < records.length; offset += 5000, sequence++) {
      await appendImportChunk(sessionId, records.slice(offset, offset + 5000), { sequence });
    }
    await commitImportSession(sessionId);
  } catch (error) {
    await abortImportSession(sessionId).catch(() => {});
    throw error;
  }
}

function validateImportEnvelope(envelope, requireRecordCount = false) {
  if (!envelope || envelope.schemaVersion !== HISTORY_SCHEMA_VERSION) {
    throw new Error(`Invalid history JSON: expected schemaVersion ${HISTORY_SCHEMA_VERSION}`);
  }
  if (typeof envelope.exportedAt !== "string" || Number.isNaN(Date.parse(envelope.exportedAt))) {
    throw new Error("Invalid history JSON: exportedAt must be an ISO date string");
  }
  if (requireRecordCount && (!Number.isInteger(envelope.expectedRecords) || envelope.expectedRecords < 0)) {
    throw new Error("Invalid history import: expectedRecords must be a non-negative integer");
  }
}

function createSessionId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `import:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export async function beginImportSession(envelope) {
  validateImportEnvelope(envelope, false);
  if (envelope.expectedRecords !== undefined &&
      (!Number.isInteger(envelope.expectedRecords) || envelope.expectedRecords < 0)) {
    throw new Error("Invalid history import: expectedRecords must be a non-negative integer");
  }

  const sessionId = createSessionId();
  const db = await openHistoryDB();
  const transaction = db.transaction(IMPORT_META_STORE, "readwrite");
  transaction.objectStore(IMPORT_META_STORE).put({
    sessionId,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    exportedAt: new Date(envelope.exportedAt).toISOString(),
    expectedRecords: envelope.expectedRecords ?? null,
    receivedRecords: 0,
    receivedBytes: 2,
    nextSequence: 0,
    chunks: {},
    state: "active",
    updatedAtMs: Date.now(),
  });
  await transactionToPromise(transaction);
  return sessionId;
}

export async function appendImportChunk(sessionId, records, options = {}) {
  if (!sessionId || typeof sessionId !== "string") throw new Error("Invalid import session id");
  if (!Array.isArray(records)) throw new Error("Import chunk records must be an array");
  const normalized = records.map((record) => normalizeHistoryRecord(record, { strict: true }));
  const normalizedBytes = normalized.reduce(
    (sum, record) => sum + estimateRecordBytes(record),
    0
  );
  const db = await openHistoryDB();
  const transaction = db.transaction([IMPORT_STORE, IMPORT_META_STORE], "readwrite");
  const done = transactionToPromise(transaction);
  const importStore = transaction.objectStore(IMPORT_STORE);
  const metaStore = transaction.objectStore(IMPORT_META_STORE);
  let operationError = null;

  const metaRequest = metaStore.get(sessionId);
  metaRequest.onsuccess = () => {
    try {
      const meta = metaRequest.result;
      if (!meta || meta.state !== "active") throw new Error("Import session is not active");
      const sequence = options.sequence ?? meta.nextSequence;
      const digest = String(options.digest || `records:${normalized.length}:${sequence}`);
      if (!Number.isInteger(sequence) || sequence < 0) throw new Error("Invalid import chunk sequence");
      if (sequence < meta.nextSequence) {
        if (meta.chunks[String(sequence)] === digest) return;
        throw new Error("Import chunk retry digest does not match");
      }
      if (sequence !== meta.nextSequence) throw new Error("Import chunks must be appended in order");

      for (const record of normalized) importStore.add({ sessionId, ...record });
      meta.chunks[String(sequence)] = digest;
      meta.nextSequence++;
      meta.receivedRecords += normalized.length;
      meta.receivedBytes = (meta.receivedBytes || 2) + normalizedBytes;
      meta.updatedAtMs = Date.now();
      metaStore.put(meta);
    } catch (error) {
      operationError = error;
      transaction.abort();
    }
  };

  try {
    await done;
  } catch (error) {
    throw operationError || error;
  }
  return { accepted: normalized.length };
}

export async function commitImportSession(sessionId) {
  if (!sessionId || typeof sessionId !== "string") throw new Error("Invalid import session id");
  const db = await openHistoryDB();
  const transaction = db.transaction(IMPORT_META_STORE, "readwrite");
  const done = transactionToPromise(transaction);
  const metaStore = transaction.objectStore(IMPORT_META_STORE);
  let operationError = null;
  let previousGeneration = null;

  const fail = (error) => {
    operationError = error;
    transaction.abort();
  };
  const metaRequest = metaStore.get(sessionId);
  metaRequest.onsuccess = () => {
    try {
      const meta = metaRequest.result;
      if (!meta) throw new Error("Import session not found");
      if (meta.state === "committed") return;
      if (meta.state !== "active") throw new Error("Import session is not active");
      if (meta.expectedRecords !== null && meta.receivedRecords !== meta.expectedRecords) {
        throw new Error(`Import record count mismatch: expected ${meta.expectedRecords}, received ${meta.receivedRecords}`);
      }
      const activeRequest = metaStore.get(ACTIVE_GENERATION_ID);
      activeRequest.onsuccess = () => {
        previousGeneration = activeRequest.result?.generation || null;
        meta.state = "committed";
        meta.updatedAtMs = Date.now();
        metaStore.put(meta);
        metaStore.put({
          sessionId: ACTIVE_GENERATION_ID,
          generation: sessionId,
          updatedAtMs: Date.now(),
        });
      };
    } catch (error) {
      fail(error);
    }
  };

  try {
    await done;
  } catch (error) {
    throw operationError || error;
  }
  activeGenerationCache = sessionId;
  await safeIncrementStorageVersion();
  if (previousGeneration !== sessionId) {
    const cleanupTimer = setTimeout(() => {
      deleteGenerationRecords(previousGeneration).catch((error) =>
        console.warn("[Background] old history generation cleanup failed", error)
      );
    }, 60000);
    if (cleanupTimer && typeof cleanupTimer.unref === "function") cleanupTimer.unref();
  }
  return true;
}

async function deleteGenerationRecords(generation) {
  const db = await openHistoryDB();
  if (!generation) {
    const transaction = db.transaction(HISTORY_STORE, "readwrite");
    transaction.objectStore(HISTORY_STORE).clear();
    await transactionToPromise(transaction);
    return;
  }
  const transaction = db.transaction([IMPORT_STORE, IMPORT_META_STORE], "readwrite");
  const lower = [generation];
  const upper = [generation, "\uffff", "\uffff", "\uffff", "\uffff"];
  transaction.objectStore(IMPORT_STORE).delete(IDBKeyRange.bound(lower, upper));
  transaction.objectStore(IMPORT_META_STORE).delete(generation);
  await transactionToPromise(transaction);
}

export async function abortImportSession(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return false;
  const db = await openHistoryDB();
  const transaction = db.transaction([IMPORT_STORE, IMPORT_META_STORE], "readwrite");
  const done = transactionToPromise(transaction);
  const metaStore = transaction.objectStore(IMPORT_META_STORE);
  const request = metaStore.get(sessionId);
  request.onsuccess = () => {
    const meta = request.result;
    if (meta && meta.state === "committed") return;
    const lower = [sessionId];
    const upper = [sessionId, "\uffff", "\uffff", "\uffff", "\uffff"];
    transaction.objectStore(IMPORT_STORE).delete(IDBKeyRange.bound(lower, upper));
    metaStore.delete(sessionId);
  };
  await done;
  return true;
}

export async function getImportSessionStatus(sessionId) {
  if (!sessionId || typeof sessionId !== "string") throw new Error("Invalid import session id");
  const db = await openHistoryDB();
  const transaction = db.transaction(IMPORT_META_STORE, "readonly");
  const meta = await requestToPromise(
    transaction.objectStore(IMPORT_META_STORE).get(sessionId)
  );
  if (!meta) return { state: "missing", receivedRecords: 0, expectedRecords: null };
  return {
    state: meta.state,
    receivedRecords: meta.receivedRecords,
    expectedRecords: meta.expectedRecords,
  };
}

export async function loadDB() {
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    records: await readAllHistoryRecords(),
  };
}

export async function saveDB(data) {
  if (!data || data.schemaVersion !== HISTORY_SCHEMA_VERSION || !Array.isArray(data.records)) {
    throw new Error(`Invalid history database payload: expected schemaVersion ${HISTORY_SCHEMA_VERSION}`);
  }
  const records = data.records.map((record) => normalizeHistoryRecord(record, { strict: true }));
  await replaceAllHistoryRecords(records);
}

export async function checkDownloaded(service, userId, postId, source) {
  const db = await openHistoryDB();
  const transaction = db.transaction(
    [IMPORT_META_STORE, IMPORT_STORE, HISTORY_STORE],
    "readonly"
  );
  const done = transactionToPromise(transaction);
  let downloaded = false;
  const metaRequest = transaction.objectStore(IMPORT_META_STORE).get(ACTIVE_GENERATION_ID);
  metaRequest.onsuccess = () => {
    const generation = metaRequest.result?.generation || null;
    const storeName = generation ? IMPORT_STORE : HISTORY_STORE;
    const recordRequest = transaction.objectStore(storeName).get(
      generation
        ? generationKey(generation, service, userId, postId, source)
        : historyKey(service, userId, postId, source)
    );
    recordRequest.onsuccess = () => {
      downloaded = !!recordRequest.result && HANDLED_STATUSES.has(recordRequest.result.status);
    };
  };
  await done;
  return downloaded;
}

export async function checkDownloadedMany(items = []) {
  const validItems = (Array.isArray(items) ? items : []).filter(
    (item) => item && item.service && item.userId && item.postId
  );
  if (validItems.length === 0) return {};

  const db = await openHistoryDB();
  const transaction = db.transaction(
    [IMPORT_META_STORE, IMPORT_STORE, HISTORY_STORE],
    "readonly"
  );
  const done = transactionToPromise(transaction);
  const results = new Array(validItems.length);
  const metaRequest = transaction.objectStore(IMPORT_META_STORE).get(ACTIVE_GENERATION_ID);
  metaRequest.onsuccess = () => {
    const generation = metaRequest.result?.generation || null;
    const storeName = generation ? IMPORT_STORE : HISTORY_STORE;
    const store = transaction.objectStore(storeName);
    validItems.forEach((item, index) => {
      const request = store.get(
        generation
          ? generationKey(generation, item.service, item.userId, item.postId, item.source)
          : historyKey(item.service, item.userId, item.postId, item.source)
      );
      request.onsuccess = () => { results[index] = request.result; };
    });
  };
  await done;
  const downloaded = {};
  validItems.forEach((item, index) => {
    const record = results[index];
    downloaded[downloadedItemKey(item.service, item.userId, item.postId, item.source)] =
      !!record && HANDLED_STATUSES.has(record.status);
  });
  return downloaded;
}

export async function safeIncrementStorageVersion() {
  revisionCounter++;
  const revision = `${Date.now()}:${revisionCounter}`;
  try {
    await chrome.storage.local.set({ [STORAGE_VERSION_KEY]: revision });
  } catch (error) {
    console.warn("[Background] history revision update failed", error);
  }
  return revision;
}

export async function markDownloaded(recordOrService, userId, postId, source) {
  const record = normalizeHistoryRecord(
    recordOrService && typeof recordOrService === "object"
      ? recordOrService
      : { service: recordOrService, userId, postId, source, status: "complete" }
  );
  const db = await openHistoryDB();
  const transaction = db.transaction(
    [IMPORT_META_STORE, IMPORT_STORE, HISTORY_STORE],
    "readwrite"
  );
  const metaRequest = transaction.objectStore(IMPORT_META_STORE).get(ACTIVE_GENERATION_ID);
  metaRequest.onsuccess = () => {
    const generation = metaRequest.result?.generation || null;
    if (!generation) {
      transaction.objectStore(HISTORY_STORE).put(record);
      return;
    }
    const store = transaction.objectStore(IMPORT_STORE);
    const metaStore = transaction.objectStore(IMPORT_META_STORE);
    const existingRequest = store.get(generationKey(
      generation,
      record.service,
      record.userId,
      record.postId,
      record.source
    ));
    const generationMetaRequest = metaStore.get(generation);
    let existing;
    let generationMeta;
    let pending = 2;
    const finalize = () => {
      pending--;
      if (pending > 0) return;
      store.put({ sessionId: generation, ...record });
      if (!generationMeta) return;
      generationMeta.receivedRecords = Math.max(
        0,
        Number(generationMeta.receivedRecords || 0) + (existing ? 0 : 1)
      );
      generationMeta.receivedBytes = Math.max(
        2,
        Number(generationMeta.receivedBytes || 2) +
          estimateRecordBytes(record) -
          (existing ? estimateRecordBytes(existing) : 0)
      );
      generationMeta.updatedAtMs = Date.now();
      metaStore.put(generationMeta);
    };
    existingRequest.onsuccess = () => { existing = existingRequest.result; finalize(); };
    generationMetaRequest.onsuccess = () => { generationMeta = generationMetaRequest.result; finalize(); };
  };
  await transactionToPromise(transaction);
  await safeIncrementStorageVersion();
  return record;
}

export async function markMultipleDownloaded(items = []) {
  const deduplicated = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const record = normalizeHistoryRecord(item);
    deduplicated.set(JSON.stringify([record.source, record.service, record.userId, record.postId]), record);
  }
  if (deduplicated.size === 0) return [];

  const records = Array.from(deduplicated.values());
  const db = await openHistoryDB();
  const transaction = db.transaction(
    [IMPORT_META_STORE, IMPORT_STORE, HISTORY_STORE],
    "readwrite"
  );
  const metaRequest = transaction.objectStore(IMPORT_META_STORE).get(ACTIVE_GENERATION_ID);
  metaRequest.onsuccess = () => {
    const generation = metaRequest.result?.generation || null;
    if (!generation) {
      const store = transaction.objectStore(HISTORY_STORE);
      for (const record of records) store.put(record);
      return;
    }
    const store = transaction.objectStore(IMPORT_STORE);
    const metaStore = transaction.objectStore(IMPORT_META_STORE);
    const existingRecords = new Array(records.length);
    const generationMetaRequest = metaStore.get(generation);
    let generationMeta;
    let pending = records.length + 1;
    const finalize = () => {
      pending--;
      if (pending > 0) return;
      let addedRecords = 0;
      let byteDelta = 0;
      records.forEach((record, index) => {
        const existing = existingRecords[index];
        if (!existing) addedRecords++;
        byteDelta += estimateRecordBytes(record) - (existing ? estimateRecordBytes(existing) : 0);
        store.put({ sessionId: generation, ...record });
      });
      if (!generationMeta) return;
      generationMeta.receivedRecords = Math.max(
        0,
        Number(generationMeta.receivedRecords || 0) + addedRecords
      );
      generationMeta.receivedBytes = Math.max(
        2,
        Number(generationMeta.receivedBytes || 2) + byteDelta
      );
      generationMeta.updatedAtMs = Date.now();
      metaStore.put(generationMeta);
    };
    generationMetaRequest.onsuccess = () => {
      generationMeta = generationMetaRequest.result;
      finalize();
    };
    records.forEach((record, index) => {
      const request = store.get(generationKey(
        generation,
        record.service,
        record.userId,
        record.postId,
        record.source
      ));
      request.onsuccess = () => {
        existingRecords[index] = request.result;
        finalize();
      };
    });
  };
  await transactionToPromise(transaction);
  await safeIncrementStorageVersion();
  return records;
}

export async function exportDB() {
  const out = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    records: await readAllHistoryRecords(),
  };
  return JSON.stringify(out, null, 2);
}

export async function beginHistoryExport() {
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    generation: await getActiveGeneration(),
  };
}

function compareCompoundKeys(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === right[index]) continue;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export async function getHistoryExportPage(
  afterKey = null,
  maxBytes = 4 * 1024 * 1024,
  generationToken = undefined
) {
  const byteLimit = Math.min(8 * 1024 * 1024, Math.max(64 * 1024, Number(maxBytes) || 4 * 1024 * 1024));
  const db = await openHistoryDB();
  const generation = generationToken === undefined
    ? await getActiveGeneration()
    : (generationToken || null);
  const storeName = generation ? IMPORT_STORE : HISTORY_STORE;
  const transaction = db.transaction(storeName, "readonly");
  const store = transaction.objectStore(storeName);

  if (typeof store.openCursor !== "function") {
    const raw = generation
      ? await requestToPromise(store.index("sessionId").getAll(generation))
      : await requestToPromise(store.getAll());
    const all = generation ? raw.map(stripGeneration) : raw;
    const sorted = all.sort((a, b) => compareCompoundKeys(
      [a.source, a.service, a.userId, a.postId],
      [b.source, b.service, b.userId, b.postId]
    ));
    const candidates = afterKey
      ? sorted.filter((record) => compareCompoundKeys(
          [record.source, record.service, record.userId, record.postId],
          afterKey
        ) > 0)
      : sorted;
    const records = [];
    let bytes = 2;
    for (const record of candidates) {
      const recordBytes = JSON.stringify(record).length * 2 + 1;
      if (records.length > 0 && bytes + recordBytes > byteLimit) break;
      records.push(record);
      bytes += recordBytes;
    }
    const nextKey = records.length
      ? [records.at(-1).source, records.at(-1).service, records.at(-1).userId, records.at(-1).postId]
      : afterKey;
    return { records, nextKey, done: records.length >= candidates.length };
  }

  return new Promise((resolve, reject) => {
    const range = generation
      ? IDBKeyRange.bound(
          afterKey ? [generation, ...afterKey] : [generation],
          [generation, "\uffff", "\uffff", "\uffff", "\uffff"],
          !!afterKey,
          false
        )
      : (afterKey ? IDBKeyRange.lowerBound(afterKey, true) : undefined);
    const request = store.openCursor(range);
    const records = [];
    let bytes = 2;
    let nextKey = afterKey;
    let settled = false;
    const finish = (done) => {
      if (settled) return;
      settled = true;
      resolve({ records, nextKey, done });
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error || new Error("Failed to page history export"));
    };
    transaction.onerror = () => {
      if (settled) return;
      settled = true;
      reject(transaction.error || new Error("History export transaction failed"));
    };
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        finish(true);
        return;
      }
      const record = generation ? stripGeneration(cursor.value) : cursor.value;
      const recordBytes = JSON.stringify(record).length * 2 + 1;
      if (records.length > 0 && bytes + recordBytes > byteLimit) {
        finish(false);
        return;
      }
      records.push(record);
      nextKey = generation ? cursor.primaryKey.slice(1) : cursor.primaryKey;
      bytes += recordBytes;
      cursor.continue();
    };
  });
}

export async function importDB(jsonString) {
  if (!jsonString || typeof jsonString !== "string") {
    throw new Error("Invalid input: expected non-empty JSON string");
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message || String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid history JSON: expected object at root");
  }
  if (parsed.schemaVersion !== HISTORY_SCHEMA_VERSION || !Array.isArray(parsed.records)) {
    throw new Error(`Invalid history JSON: expected schemaVersion ${HISTORY_SCHEMA_VERSION} and records array`);
  }
  if (typeof parsed.exportedAt !== "string" || Number.isNaN(Date.parse(parsed.exportedAt))) {
    throw new Error("Invalid history JSON: exportedAt must be an ISO date string");
  }

  const sessionId = await beginImportSession({
    schemaVersion: parsed.schemaVersion,
    exportedAt: parsed.exportedAt,
    expectedRecords: parsed.records.length,
  });
  try {
    for (let offset = 0, sequence = 0; offset < parsed.records.length; offset += 5000, sequence++) {
      await appendImportChunk(sessionId, parsed.records.slice(offset, offset + 5000), { sequence });
    }
    await commitImportSession(sessionId);
    return true;
  } catch (error) {
    await abortImportSession(sessionId).catch(() => {});
    throw error;
  }
}

export async function clearDB() {
  await replaceAllHistoryRecords([]);
}

export async function getHistoryStats() {
  const db = await openHistoryDB();
  const generation = await getActiveGeneration();
  if (generation) {
    const transaction = db.transaction(IMPORT_META_STORE, "readonly");
    const meta = await requestToPromise(
      transaction.objectStore(IMPORT_META_STORE).get(generation)
    );
    return {
      bytes: Math.max(2, Number(meta?.receivedBytes || 2)),
      records: Math.max(0, Number(meta?.receivedRecords || 0)),
    };
  }
  const transaction = db.transaction(HISTORY_STORE, "readonly");
  const store = transaction.objectStore(HISTORY_STORE);
  const records = await requestToPromise(store.count());
  return { bytes: 0, records };
}

export async function loadLastAccess() {
  const r = await chrome.storage.sync.get(LAST_ACCESS_KEY);
  const raw = r[LAST_ACCESS_KEY] || {};
  const out = {};
  for (const [svc, users] of Object.entries(raw)) out[svc] = { ...users };
  return out;
}

export async function saveLastAccess(map) {
  await chrome.storage.sync.set({ [LAST_ACCESS_KEY]: map });
}

export async function setLastAccess(service, userId, when = new Date()) {
  const map = await loadLastAccess();
  if (!map[service]) map[service] = {};
  map[service][userId] = when instanceof Date ? when.toISOString() : new Date(when).toISOString();
  await saveLastAccess(map);
}

export async function loadCreatorFlags() {
  const r = await chrome.storage.local.get(CREATOR_FLAG_KEY);
  return r[CREATOR_FLAG_KEY] || {};
}

export async function saveCreatorFlags(flags) {
  await chrome.storage.local.set({ [CREATOR_FLAG_KEY]: flags });
}

export async function getCreatorFlagsMany(items = []) {
  const flags = await loadCreatorFlags();
  const result = {};
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.service || !item.userId) continue;
    const key = `${item.service}:${item.userId}`;
    result[key] = flags[key] !== undefined ? flags[key] : null;
  }
  return result;
}

export async function setCreatorFlag(service, userId, value) {
  const flags = await loadCreatorFlags();
  const key = `${service}:${userId}`;
  flags[key] = !!value;
  await saveCreatorFlags(flags);
  return flags[key];
}

export const HISTORY_DB_INFO = Object.freeze({
  name: HISTORY_DB_NAME,
  version: HISTORY_DB_VERSION,
  store: HISTORY_STORE,
  schemaVersion: HISTORY_SCHEMA_VERSION,
});
