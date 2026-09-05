// background/db.js - IndexedDB-backed download history and small storage helpers
import {
  STORAGE_VERSION_KEY,
  LEGACY_LAST_ACCESS_KEY,
  CREATOR_FLAG_KEY,
} from "./constants.js";

const HISTORY_DB_NAME = "kdownloaderHistory";
const HISTORY_DB_VERSION = 3;
const HISTORY_STORE = "records";
const IMPORT_STORE = "importRecords";
const IMPORT_META_STORE = "importSessions";
const ACTIVE_GENERATION_ID = "__active_generation__";
const HISTORY_SCHEMA_VERSION = 2;
const HISTORY_STATUSES = new Set(["complete", "partial", "empty"]);
const HANDLED_STATUSES = new Set(["complete", "empty"]);
const RETIRED_GENERATION_TTL_MS = 60 * 60 * 1000;
const ABANDONED_IMPORT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IMPORT_RECORDS = 1_000_000;
const MAX_IMPORT_CHUNKS = 4096;
const MAX_IMPORT_SESSIONS = 8;
const MAX_IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const MAX_IMPORT_JSON_CODE_UNITS = 64 * 1024 * 1024;
const MAX_HISTORY_BATCH_ITEMS = 10_000;
const MAX_HISTORY_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_IDENTITY_LENGTH = 4096;
const MAX_CREATOR_FLAGS = 10_000;
const MAX_FLAG_IDENTITY_LENGTH = 512;
const MAX_CREATOR_FLAGS_BYTES = 2 * 1024 * 1024;
const HISTORY_SOURCES = new Set(["default", "coomerfans"]);
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/i;

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
      let historyStore;
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        historyStore = db.createObjectStore(HISTORY_STORE, {
          keyPath: ["source", "service", "userId", "postId"],
        });
      } else {
        historyStore = request.transaction.objectStore(HISTORY_STORE);
      }
      for (const indexName of ["creator", "status"]) {
        if (historyStore.indexNames.contains(indexName)) historyStore.deleteIndex(indexName);
      }

      let importStore;
      if (!db.objectStoreNames.contains(IMPORT_STORE)) {
        importStore = db.createObjectStore(IMPORT_STORE, {
          keyPath: ["sessionId", "source", "service", "userId", "postId"],
        });
      } else {
        importStore = request.transaction.objectStore(IMPORT_STORE);
      }
      if (importStore.indexNames.contains("sessionId")) importStore.deleteIndex("sessionId");
      if (!db.objectStoreNames.contains(IMPORT_META_STORE)) {
        db.createObjectStore(IMPORT_META_STORE, { keyPath: "sessionId" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        historyDbPromise = null;
        activeGenerationCache = undefined;
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

function hasUnpairedUtf16Surrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizedIdentity(value, field, strict) {
  if (strict && (typeof value !== "string" || !value.trim())) {
    throw new Error(`Invalid history record: ${field} must be a non-empty string`);
  }
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Invalid history record: missing ${field}`);
  if (normalized.length > MAX_IDENTITY_LENGTH
      || /[\x00-\x1f\x7f]/.test(normalized)
      || hasUnpairedUtf16Surrogate(normalized)) {
    throw new Error(
      `Invalid history record: ${field} is too long or contains control characters or an unpaired UTF-16 surrogate`
    );
  }
  return normalized;
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function normalizedIsoTimestamp(value, label) {
  if (typeof value !== "string" || value.length > 64) {
    throw new Error(`${label} must be a timezone-qualified ISO 8601 timestamp`);
  }
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) {
    throw new Error(`${label} must be a timezone-qualified ISO 8601 timestamp`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    fraction, zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)
    || (fraction !== undefined && fraction.length > 9)
    || (!/^z$/i.test(zone) && offsetHourText === undefined)
  ) {
    throw new Error(`${label} must be a valid timezone-qualified ISO 8601 timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid timezone-qualified ISO 8601 timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizedImportSessionId(value) {
  if (typeof value !== "string" || !value || value === ACTIVE_GENERATION_ID
      || value.length > 128 || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error("Invalid import session id");
  }
  return value;
}

function normalizeSource(value, strict) {
  if (strict && (typeof value !== "string" || !value.trim())) {
    throw new Error("Invalid history record: source must be a non-empty string");
  }
  const normalized = String(value || "default").trim().toLowerCase() || "default";
  // Older Pawchive callers briefly emitted a site name as the source. Pawchive
  // shares the default history namespace; preserve those records on import.
  const source = normalized === "pawchive" ? "default" : normalized;
  if (!HISTORY_SOURCES.has(source)) {
    if (strict) throw new Error(`Invalid history record source: ${source}`);
    return "default";
  }
  return source;
}

function usesSharedHistorySource(value) {
  return normalizeSource(value, false) === "default";
}

function normalizeCount(value, field, strict, fallback = 0) {
  if (strict && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Invalid history record: ${field} must be a non-negative safe integer`);
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
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

  const status = input.status === undefined ? "complete" : input.status;
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
  const updatedAt = input.updatedAt === undefined
    ? new Date().toISOString()
    : normalizedIsoTimestamp(input.updatedAt, "Invalid history record: updatedAt");

  if (status === "empty" && (totalCount !== 0 || successCount !== 0 || failedCount !== 0)) {
    throw new Error("Invalid empty history record counts");
  }
  if (successCount + failedCount > totalCount) {
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
    updatedAt,
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

function legacySharedHistoryKey(service, userId, postId) {
  return [
    "pawchive",
    normalizedIdentity(service, "service", false),
    normalizedIdentity(userId, "userId", false),
    normalizedIdentity(postId, "postId", false),
  ];
}

function generationKey(generation, service, userId, postId, source) {
  return [generation, ...historyKey(service, userId, postId, source)];
}

function legacySharedGenerationKey(generation, service, userId, postId) {
  return [generation, ...legacySharedHistoryKey(service, userId, postId)];
}

function preferredHistoryStatus(records) {
  let partial = null;
  for (const record of records) {
    if (!record || !HISTORY_STATUSES.has(record.status)) continue;
    if (HANDLED_STATUSES.has(record.status)) return record.status;
    if (record.status === "partial") partial = "partial";
  }
  return partial;
}

function generationRange(generation) {
  return IDBKeyRange.bound(
    [generation, ""],
    [generation, []]
  );
}

function historyIdentityToken(record) {
  return JSON.stringify([record.source, record.service, record.userId, record.postId]);
}

function duplicateHistoryIdentityError(record) {
  return new Error(
    `Duplicate history identity: ${record.source}/${record.service}/${record.userId}/${record.postId}`
  );
}

export function downloadedItemKey(service, userId, postId, source) {
  return JSON.stringify([
    normalizeSource(source, false),
    String(service || ""),
    String(userId || ""),
    String(postId || ""),
  ]);
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
    transaction.objectStore(IMPORT_STORE).getAll(generationRange(generation))
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
  normalizedIsoTimestamp(envelope.exportedAt, "Invalid history JSON: exportedAt");
  if (requireRecordCount && (!Number.isInteger(envelope.expectedRecords) || envelope.expectedRecords < 0)) {
    throw new Error("Invalid history import: expectedRecords must be a non-negative integer");
  }
  if (Number.isInteger(envelope.expectedRecords) && envelope.expectedRecords > MAX_IMPORT_RECORDS) {
    throw new Error(`History import exceeds ${MAX_IMPORT_RECORDS} records`);
  }
}

function createSessionId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `import:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function createHistoryRevision() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return `history:${globalThis.crypto.randomUUID()}`;
  }
  revisionCounter++;
  return `history:${Date.now()}:${revisionCounter}:${Math.random().toString(36).slice(2)}`;
}

function revisedActivePointer(current, generation = current?.generation || null, now = Date.now()) {
  return {
    ...(current && typeof current === "object" ? current : {}),
    sessionId: ACTIVE_GENERATION_ID,
    generation,
    revision: createHistoryRevision(),
    updatedAtMs: now,
  };
}

export async function beginImportSession(envelope) {
  validateImportEnvelope(envelope, false);
  if (envelope.expectedRecords !== undefined &&
      (!Number.isInteger(envelope.expectedRecords) || envelope.expectedRecords < 0)) {
    throw new Error("Invalid history import: expectedRecords must be a non-negative integer");
  }
  if (Number.isInteger(envelope.expectedRecords) && envelope.expectedRecords > MAX_IMPORT_RECORDS) {
    throw new Error(`History import exceeds ${MAX_IMPORT_RECORDS} records`);
  }

  // Reclaim earlier abandoned staging data opportunistically even when the
  // browser itself has not restarted since an interrupted import.
  await cleanupHistoryStorage().catch((error) => {
    console.warn("[Background] pre-import history cleanup failed", error);
  });

  const sessionId = createSessionId();
  const db = await openHistoryDB();
  const transaction = db.transaction(IMPORT_META_STORE, "readwrite");
  const done = transactionToPromise(transaction);
  const metaStore = transaction.objectStore(IMPORT_META_STORE);
  let operationError = null;
  const sessionsRequest = metaStore.getAll();
  sessionsRequest.onsuccess = () => {
    try {
      const sessionCount = (Array.isArray(sessionsRequest.result) ? sessionsRequest.result : [])
        .filter((entry) => entry?.sessionId !== ACTIVE_GENERATION_ID)
        .length;
      if (sessionCount >= MAX_IMPORT_SESSIONS) {
        throw new Error(`History import session limit (${MAX_IMPORT_SESSIONS}) reached`);
      }
      metaStore.put({
        sessionId,
        schemaVersion: HISTORY_SCHEMA_VERSION,
        exportedAt: normalizedIsoTimestamp(envelope.exportedAt, "Invalid history JSON: exportedAt"),
        expectedRecords: envelope.expectedRecords ?? null,
        receivedRecords: 0,
        receivedBytes: 2,
        nextSequence: 0,
        chunks: {},
        state: "active",
        updatedAtMs: Date.now(),
      });
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
  return sessionId;
}

async function calculateImportChunkDigest(records) {
  const bytes = new TextEncoder().encode(JSON.stringify(records));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function appendImportChunk(sessionId, records, options = {}) {
  sessionId = normalizedImportSessionId(sessionId);
  if (!Array.isArray(records)) throw new Error("Import chunk records must be an array");
  if (records.length === 0) throw new Error("Import chunk records must not be empty");
  if (records.length > 5000) throw new Error("Import chunk exceeds 5000 records");
  const normalized = [];
  let normalizedBytes = 0;
  for (const input of records) {
    const record = normalizeHistoryRecord(input, { strict: true });
    normalizedBytes += estimateRecordBytes(record);
    if (normalizedBytes > MAX_IMPORT_CHUNK_BYTES) {
      throw new Error("Import chunk exceeds the 8 MiB safety limit");
    }
    normalized.push(record);
  }
  const identities = new Set();
  for (const record of normalized) {
    const identity = historyIdentityToken(record);
    if (identities.has(identity)) throw duplicateHistoryIdentityError(record);
    identities.add(identity);
  }
  const digest = await calculateImportChunkDigest(normalized);
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
      if (!Number.isInteger(sequence) || sequence < 0) throw new Error("Invalid import chunk sequence");
      if (sequence >= MAX_IMPORT_CHUNKS) throw new Error(`Import exceeds ${MAX_IMPORT_CHUNKS} chunks`);
      if (sequence < meta.nextSequence) {
        if (meta.chunks[String(sequence)] === digest) {
          meta.updatedAtMs = Date.now();
          metaStore.put(meta);
          return;
        }
        throw new Error("Import chunk retry digest does not match");
      }
      if (sequence !== meta.nextSequence) throw new Error("Import chunks must be appended in order");
      if (meta.receivedRecords + normalized.length > MAX_IMPORT_RECORDS) {
        throw new Error(`History import exceeds ${MAX_IMPORT_RECORDS} records`);
      }
      if (meta.expectedRecords !== null && meta.receivedRecords + normalized.length > meta.expectedRecords) {
        throw new Error("Import chunk exceeds the declared record count");
      }
      if (Number(meta.receivedBytes || 2) + normalizedBytes > MAX_IMPORT_BYTES) {
        throw new Error("History import exceeds the 256 MiB safety limit");
      }

      for (const record of normalized) {
        const addRequest = importStore.add({ sessionId, ...record });
        addRequest.onerror = (event) => {
          if (event && typeof event.preventDefault === "function") event.preventDefault();
          if (operationError) return;
          operationError = duplicateHistoryIdentityError(record);
          try {
            transaction.abort();
          } catch (_) {
            /* transaction may already be aborting */
          }
        };
      }
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
  sessionId = normalizedImportSessionId(sessionId);
  const db = await openHistoryDB();
  const transaction = db.transaction(IMPORT_META_STORE, "readwrite");
  const done = transactionToPromise(transaction);
  const metaStore = transaction.objectStore(IMPORT_META_STORE);
  let operationError = null;
  let previousGeneration = null;
  let activeGenerationAfterCommit = null;
  let committedNow = false;

  const fail = (error) => {
    operationError = error;
    transaction.abort();
  };
  const metaRequest = metaStore.get(sessionId);
  metaRequest.onsuccess = () => {
    try {
      const meta = metaRequest.result;
      if (!meta) throw new Error("Import session not found");
      if (meta.state === "committed") {
        const activeRequest = metaStore.get(ACTIVE_GENERATION_ID);
        activeRequest.onsuccess = () => {
          activeGenerationAfterCommit = activeRequest.result?.generation || null;
        };
        return;
      }
      if (meta.state !== "active") throw new Error("Import session is not active");
      if (meta.expectedRecords !== null && meta.receivedRecords !== meta.expectedRecords) {
        throw new Error(`Import record count mismatch: expected ${meta.expectedRecords}, received ${meta.receivedRecords}`);
      }
      const activeRequest = metaStore.get(ACTIVE_GENERATION_ID);
      activeRequest.onsuccess = () => {
        previousGeneration = activeRequest.result?.generation || null;
        activeGenerationAfterCommit = sessionId;
        committedNow = true;
        const now = Date.now();
        meta.state = "committed";
        meta.updatedAtMs = now;
        metaStore.put(meta);
        if (previousGeneration && previousGeneration !== sessionId) {
          const previousRequest = metaStore.get(previousGeneration);
          previousRequest.onsuccess = () => {
            const previous = previousRequest.result;
            if (!previous || previous.sessionId === sessionId) return;
            previous.retiredAtMs = now;
            metaStore.put(previous);
          };
        }
        const legacyRetiredAtMs = activeRequest.result?.legacyRetiredAtMs
          || (!previousGeneration ? now : null);
        metaStore.put(revisedActivePointer({
          ...(activeRequest.result || {}),
          ...(legacyRetiredAtMs ? { legacyRetiredAtMs } : {}),
        }, sessionId, now));
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
  activeGenerationCache = activeGenerationAfterCommit;
  if (!committedNow) return true;
  await safeIncrementStorageVersion();
  if (previousGeneration !== sessionId) {
    const cleanupTimer = setTimeout(() => {
      cleanupHistoryStorage().catch((error) =>
        console.warn("[Background] history generation cleanup failed", error)
      );
    }, RETIRED_GENERATION_TTL_MS);
    if (cleanupTimer && typeof cleanupTimer.unref === "function") cleanupTimer.unref();
  }
  return true;
}

export async function cleanupHistoryStorage(now = Date.now()) {
  const db = await openHistoryDB();
  const transaction = db.transaction(
    [HISTORY_STORE, IMPORT_STORE, IMPORT_META_STORE],
    "readwrite"
  );
  const done = transactionToPromise(transaction);
  const historyStore = transaction.objectStore(HISTORY_STORE);
  const importStore = transaction.objectStore(IMPORT_STORE);
  const metaStore = transaction.objectStore(IMPORT_META_STORE);
  const metaRequest = metaStore.getAll();
  let removedSessions = 0;

  metaRequest.onsuccess = () => {
    const allMeta = Array.isArray(metaRequest.result) ? metaRequest.result : [];
    const activePointer = allMeta.find(
      (entry) => entry?.sessionId === ACTIVE_GENERATION_ID
    ) || null;
    const activeGeneration = activePointer?.generation || null;
    for (const entry of allMeta) {
      if (!entry || entry.sessionId === ACTIVE_GENERATION_ID || entry.sessionId === activeGeneration) continue;
      const updatedAt = Number(entry.updatedAtMs || 0);
      const retiredAt = Number(entry.retiredAtMs || 0);
      const stale = entry.state === "committed" && retiredAt > 0
        ? now - retiredAt >= RETIRED_GENERATION_TTL_MS
        : updatedAt > 0 && now - updatedAt >= ABANDONED_IMPORT_TTL_MS;
      if (!stale) continue;
      importStore.delete(generationRange(entry.sessionId));
      metaStore.delete(entry.sessionId);
      removedSessions++;
    }

    const legacyRetiredAt = Number(activePointer?.legacyRetiredAtMs || 0);
    if (legacyRetiredAt > 0 && now - legacyRetiredAt >= RETIRED_GENERATION_TTL_MS) {
      historyStore.clear();
      const { legacyRetiredAtMs: ignored, ...nextPointer } = activePointer;
      metaStore.put(nextPointer);
    }
  };

  await done;
  return { removedSessions };
}

export async function abortImportSession(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return false;
  sessionId = normalizedImportSessionId(sessionId);
  const db = await openHistoryDB();
  const transaction = db.transaction([IMPORT_STORE, IMPORT_META_STORE], "readwrite");
  const done = transactionToPromise(transaction);
  const metaStore = transaction.objectStore(IMPORT_META_STORE);
  const request = metaStore.get(sessionId);
  request.onsuccess = () => {
    const meta = request.result;
    if (meta && meta.state === "committed") return;
    transaction.objectStore(IMPORT_STORE).delete(generationRange(sessionId));
    metaStore.delete(sessionId);
  };
  await done;
  return true;
}

export async function getImportSessionStatus(sessionId) {
  sessionId = normalizedImportSessionId(sessionId);
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

export async function getDownloadedStatus(service, userId, postId, source) {
  const db = await openHistoryDB();
  const generation = await getActiveGeneration();
  const storeName = generation ? IMPORT_STORE : HISTORY_STORE;
  const transaction = db.transaction(storeName, "readonly");
  const store = transaction.objectStore(storeName);
  const primary = requestToPromise(store.get(
    generation
      ? generationKey(generation, service, userId, postId, source)
      : historyKey(service, userId, postId, source)
  ));
  const legacyShared = usesSharedHistorySource(source)
    ? requestToPromise(store.get(
        generation
          ? legacySharedGenerationKey(generation, service, userId, postId)
          : legacySharedHistoryKey(service, userId, postId)
      ))
    : Promise.resolve(undefined);
  return preferredHistoryStatus(await Promise.all([primary, legacyShared]));
}

export async function checkDownloaded(service, userId, postId, source) {
  return HANDLED_STATUSES.has(await getDownloadedStatus(service, userId, postId, source));
}

export async function getDownloadedStatusesMany(items = []) {
  const input = Array.isArray(items) ? items : [];
  if (input.length > MAX_HISTORY_BATCH_ITEMS) {
    throw new Error(`History status batch exceeds ${MAX_HISTORY_BATCH_ITEMS} items`);
  }
  const uniqueItems = new Map();
  const encoder = new TextEncoder();
  let identityBytes = 2;
  for (const item of input) {
    if (!item || !item.service || !item.userId || !item.postId) continue;
    const key = historyKey(item.service, item.userId, item.postId, item.source);
    const serializedKey = JSON.stringify(key);
    identityBytes += encoder.encode(serializedKey).byteLength + 1;
    if (identityBytes > MAX_HISTORY_BATCH_BYTES) {
      throw new Error("History status batch exceeds the 16 MiB safety limit");
    }
    const existing = uniqueItems.get(serializedKey);
    uniqueItems.set(serializedKey, {
      source: key[0],
      service: key[1],
      userId: key[2],
      postId: key[3],
      readLegacyShared: !!existing?.readLegacyShared || usesSharedHistorySource(item.source),
    });
  }
  const validItems = Array.from(uniqueItems.values());
  if (validItems.length === 0) return {};

  const db = await openHistoryDB();
  const generation = await getActiveGeneration();
  const storeName = generation ? IMPORT_STORE : HISTORY_STORE;
  const transaction = db.transaction(storeName, "readonly");
  const done = transactionToPromise(transaction);
  const primaryResults = new Array(validItems.length);
  const legacySharedResults = new Array(validItems.length);
  const store = transaction.objectStore(storeName);
  validItems.forEach((item, index) => {
    const request = store.get(
      generation
        ? generationKey(generation, item.service, item.userId, item.postId, item.source)
        : historyKey(item.service, item.userId, item.postId, item.source)
    );
    request.onsuccess = () => { primaryResults[index] = request.result; };
    if (item.readLegacyShared) {
      const legacyRequest = store.get(
        generation
          ? legacySharedGenerationKey(generation, item.service, item.userId, item.postId)
          : legacySharedHistoryKey(item.service, item.userId, item.postId)
      );
      legacyRequest.onsuccess = () => { legacySharedResults[index] = legacyRequest.result; };
    }
  });
  await done;
  const statuses = {};
  validItems.forEach((item, index) => {
    statuses[downloadedItemKey(item.service, item.userId, item.postId, item.source)] =
      preferredHistoryStatus([primaryResults[index], legacySharedResults[index]]);
  });
  return statuses;
}

export async function checkDownloadedMany(items = []) {
  const statuses = await getDownloadedStatusesMany(items);
  const downloaded = {};
  for (const [key, status] of Object.entries(statuses)) {
    downloaded[key] = HANDLED_STATUSES.has(status);
  }
  return downloaded;
}

async function safeIncrementStorageVersion() {
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
  const metaStore = transaction.objectStore(IMPORT_META_STORE);
  const metaRequest = metaStore.get(ACTIVE_GENERATION_ID);
  metaRequest.onsuccess = () => {
    const activePointer = metaRequest.result || null;
    const generation = activePointer?.generation || null;
    metaStore.put(revisedActivePointer(activePointer, generation));
    if (!generation) {
      transaction.objectStore(HISTORY_STORE).put(record);
      return;
    }
    const store = transaction.objectStore(IMPORT_STORE);
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
  if (Array.isArray(items) && items.length > MAX_HISTORY_BATCH_ITEMS) {
    throw new Error(`History write batch exceeds ${MAX_HISTORY_BATCH_ITEMS} items`);
  }
  const deduplicated = new Map();
  let batchBytes = 2;
  for (const item of Array.isArray(items) ? items : []) {
    const record = normalizeHistoryRecord(item);
    batchBytes += estimateRecordBytes(record);
    if (batchBytes > MAX_HISTORY_BATCH_BYTES) {
      throw new Error("History write batch exceeds the 16 MiB safety limit");
    }
    deduplicated.set(JSON.stringify([record.source, record.service, record.userId, record.postId]), record);
  }
  if (deduplicated.size === 0) return [];

  const records = Array.from(deduplicated.values());
  const db = await openHistoryDB();
  const transaction = db.transaction(
    [IMPORT_META_STORE, IMPORT_STORE, HISTORY_STORE],
    "readwrite"
  );
  const metaStore = transaction.objectStore(IMPORT_META_STORE);
  const metaRequest = metaStore.get(ACTIVE_GENERATION_ID);
  metaRequest.onsuccess = () => {
    const activePointer = metaRequest.result || null;
    const generation = activePointer?.generation || null;
    metaStore.put(revisedActivePointer(activePointer, generation));
    if (!generation) {
      const store = transaction.objectStore(HISTORY_STORE);
      for (const record of records) store.put(record);
      return;
    }
    const store = transaction.objectStore(IMPORT_STORE);
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

export async function exportDB(maxBytes = Infinity) {
  if (Number.isFinite(maxBytes)) {
    const byteLimit = Math.max(64 * 1024, Math.floor(maxBytes));
    const exportSession = await beginHistoryExport();
    const prefix = `{"schemaVersion":${HISTORY_SCHEMA_VERSION},"exportedAt":${JSON.stringify(exportSession.exportedAt)},"records":[`;
    const suffix = ']}';
    const encoder = new TextEncoder();
    let bytes = encoder.encode(prefix).byteLength + encoder.encode(suffix).byteLength;
    const chunks = [prefix];
    let afterKey = null;
    let hasRecords = false;
    while (true) {
      const page = await getHistoryExportPage(
        afterKey,
        Math.min(4 * 1024 * 1024, byteLimit),
        exportSession.generation,
        exportSession.revision
      );
      const pageParts = [];
      for (const record of page.records) {
        const serialized = JSON.stringify(record);
        const fragment = `${hasRecords || pageParts.length > 0 ? ',' : ''}${serialized}`;
        pageParts.push(fragment);
      }
      if (pageParts.length > 0) {
        const pageText = pageParts.join('');
        const pageBytes = encoder.encode(pageText).byteLength;
        if (bytes + pageBytes > byteLimit) {
          throw new Error(`History export exceeds the ${byteLimit} byte safety limit`);
        }
        chunks.push(pageText);
        bytes += pageBytes;
      }
      hasRecords = hasRecords || pageParts.length > 0;
      if (page.done) break;
      if (!page.nextKey || JSON.stringify(page.nextKey) === JSON.stringify(afterKey)) {
        throw new Error("History export pagination did not advance");
      }
      afterKey = page.nextKey;
    }
    chunks.push(suffix);
    return chunks.join('');
  }

  const out = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    records: await readAllHistoryRecords(),
  };
  return JSON.stringify(out, null, 2);
}

export async function beginHistoryExport() {
  const db = await openHistoryDB();
  const transaction = db.transaction(IMPORT_META_STORE, "readonly");
  const done = transactionToPromise(transaction);
  const active = await requestToPromise(
    transaction.objectStore(IMPORT_META_STORE).get(ACTIVE_GENERATION_ID)
  );
  await done;
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    generation: active?.generation || null,
    revision: active?.revision || null,
  };
}

function compareCompoundKeys(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === right[index]) continue;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function normalizeExportKey(afterKey) {
  if (afterKey === null || afterKey === undefined) return null;
  if (!Array.isArray(afterKey) || afterKey.length !== 4) {
    throw new Error("Invalid history export cursor");
  }
  return [
    normalizeSource(afterKey[0], true),
    normalizedIdentity(afterKey[1], "service", true),
    normalizedIdentity(afterKey[2], "userId", true),
    normalizedIdentity(afterKey[3], "postId", true),
  ];
}

export async function getHistoryExportPage(
  afterKey = null,
  maxBytes = 4 * 1024 * 1024,
  generationToken = undefined,
  revisionToken = undefined
) {
  const byteLimit = Math.min(8 * 1024 * 1024, Math.max(64 * 1024, Number(maxBytes) || 4 * 1024 * 1024));
  const normalizedAfterKey = normalizeExportKey(afterKey);
  if (
    generationToken !== undefined
    && generationToken !== null
    && (typeof generationToken !== "string" || !generationToken || generationToken.length > 128
      || /[\0-\x1f\x7f]/.test(generationToken))
  ) {
    throw new Error("Invalid history export generation");
  }
  if (
    revisionToken !== undefined
    &&
    revisionToken !== null
    && (typeof revisionToken !== "string" || !revisionToken || revisionToken.length > 128
      || /[\0-\x1f\x7f]/.test(revisionToken))
  ) {
    throw new Error("Invalid history export revision");
  }
  if (generationToken === undefined || revisionToken === undefined) {
    if (normalizedAfterKey !== null) {
      throw new Error("History export session is required for continuation pages");
    }
    const exportSession = await beginHistoryExport();
    return getHistoryExportPage(
      null,
      byteLimit,
      exportSession.generation,
      exportSession.revision
    );
  }
  const db = await openHistoryDB();
  const generation = generationToken || null;
  const storeName = generation ? IMPORT_STORE : HISTORY_STORE;
  const transaction = db.transaction([IMPORT_META_STORE, storeName], "readonly");
  const metaStore = transaction.objectStore(IMPORT_META_STORE);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    transaction.onerror = () => {
      fail(transaction.error || new Error("History export transaction failed"));
    };
    transaction.onabort = () => {
      fail(transaction.error || new Error("History export transaction aborted"));
    };

    const activeRequest = metaStore.get(ACTIVE_GENERATION_ID);
    activeRequest.onerror = () => {
      fail(activeRequest.error || new Error("Failed to read history export revision"));
    };
    activeRequest.onsuccess = () => {
      try {
        const active = activeRequest.result;
        const activeGeneration = active?.generation || null;
        const activeRevision = active?.revision || null;
        if (activeGeneration !== generation || activeRevision !== revisionToken) {
          const error = new Error("History changed during export; retry the export");
          fail(error);
          try {
            transaction.abort();
          } catch (_) {
            /* The readonly transaction may already be aborting. */
          }
          return;
        }

        const store = transaction.objectStore(storeName);
        if (typeof store.openCursor !== "function") {
          const request = generation
            ? store.getAll(generationRange(generation))
            : store.getAll();
          request.onerror = () => {
            fail(request.error || new Error("Failed to page history export"));
          };
          request.onsuccess = () => {
            try {
              const raw = Array.isArray(request.result) ? request.result : [];
              const all = generation ? raw.map(stripGeneration) : raw;
              const sorted = all.sort((a, b) => compareCompoundKeys(
                [a.source, a.service, a.userId, a.postId],
                [b.source, b.service, b.userId, b.postId]
              ));
              const candidates = normalizedAfterKey
                ? sorted.filter((record) => compareCompoundKeys(
                    [record.source, record.service, record.userId, record.postId],
                    normalizedAfterKey
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
                ? [records.at(-1).source, records.at(-1).service,
                    records.at(-1).userId, records.at(-1).postId]
                : normalizedAfterKey;
              if (settled) return;
              settled = true;
              resolve({
                records,
                nextKey,
                done: records.length >= candidates.length,
                generation,
                revision: revisionToken,
              });
            } catch (error) {
              fail(error);
            }
          };
          return;
        }

        const range = generation
          ? IDBKeyRange.bound(
              normalizedAfterKey ? [generation, ...normalizedAfterKey] : [generation],
              [generation, []],
              !!normalizedAfterKey,
              false
            )
          : (normalizedAfterKey
              ? IDBKeyRange.lowerBound(normalizedAfterKey, true)
              : undefined);
        const request = store.openCursor(range);
        const records = [];
        let bytes = 2;
        let nextKey = normalizedAfterKey;
        const finish = (done) => {
          if (settled) return;
          settled = true;
          resolve({ records, nextKey, done, generation, revision: revisionToken });
        };
        request.onerror = () => {
          fail(request.error || new Error("Failed to page history export"));
        };
        request.onsuccess = () => {
          try {
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
          } catch (error) {
            fail(error);
          }
        };
      } catch (error) {
        fail(error);
      }
    };
  });
}

export async function importDB(jsonString) {
  if (!jsonString || typeof jsonString !== "string") {
    throw new Error("Invalid input: expected non-empty JSON string");
  }
  if (jsonString.length > MAX_IMPORT_JSON_CODE_UNITS) {
    throw new Error("History JSON exceeds the 64 MiB safety limit");
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
  validateImportEnvelope(parsed, false);

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

export async function cleanupLegacyHistoryMetadata() {
  await chrome.storage.sync.remove(LEGACY_LAST_ACCESS_KEY);
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

async function loadCreatorFlags() {
  const r = await chrome.storage.local.get(CREATOR_FLAG_KEY);
  const raw = r[CREATOR_FLAG_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { flags: {}, raw: {}, overflow: false };
  }
  const flags = {};
  let count = 0;
  let bytes = 2;
  let overflow = false;
  for (const key in raw) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (key.length > 2048 || value !== true) continue;
    const entryBytes = new TextEncoder().encode(JSON.stringify(key)).byteLength + 6;
    if (count >= MAX_CREATOR_FLAGS || bytes + entryBytes > MAX_CREATOR_FLAGS_BYTES) {
      overflow = true;
      continue;
    }
    Object.defineProperty(flags, key, {
      value: true,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    count++;
    bytes += entryBytes;
  }
  return { flags, raw, overflow };
}

async function saveCreatorFlags(flags) {
  if (new TextEncoder().encode(JSON.stringify(flags)).byteLength > MAX_CREATOR_FLAGS_BYTES) {
    throw new Error("Creator flags exceed the 2 MiB storage safety limit");
  }
  await chrome.storage.local.set({ [CREATOR_FLAG_KEY]: flags });
}

function normalizeFlagIdentity(value, field) {
  const normalized = normalizedIdentity(value, field, false);
  if (normalized.length > MAX_FLAG_IDENTITY_LENGTH) {
    throw new Error(`Invalid creator flag ${field}`);
  }
  return normalized;
}

export async function getCreatorFlagsMany(items = []) {
  if (Array.isArray(items) && items.length > MAX_HISTORY_BATCH_ITEMS) {
    throw new Error(`Creator flag batch exceeds ${MAX_HISTORY_BATCH_ITEMS} items`);
  }
  const { raw: flags } = await loadCreatorFlags();
  const result = {};
  const encoder = new TextEncoder();
  let identityBytes = 2;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.service || !item.userId) continue;
    const service = normalizeFlagIdentity(item.service, "service");
    const userId = normalizeFlagIdentity(item.userId, "userId");
    const key = JSON.stringify([service, userId]);
    identityBytes += encoder.encode(key).byteLength + 6;
    if (identityBytes > MAX_CREATOR_FLAGS_BYTES) {
      throw new Error("Creator flag request exceeds the 2 MiB safety limit");
    }
    const legacyKey = service.includes(":") || userId.includes(":")
      ? null
      : `${service}:${userId}`;
    result[key] = (Object.hasOwn(flags, key) && flags[key] === true)
      || (legacyKey !== null && Object.hasOwn(flags, legacyKey) && flags[legacyKey] === true)
      ? true
      : null;
  }
  return result;
}

let creatorFlagMutationQueue = Promise.resolve();

export async function setCreatorFlag(service, userId, value) {
  const normalizedService = normalizeFlagIdentity(service, "service");
  const normalizedUserId = normalizeFlagIdentity(userId, "userId");
  const key = JSON.stringify([normalizedService, normalizedUserId]);
  const legacyKey = normalizedService.includes(":") || normalizedUserId.includes(":")
    ? null
    : `${normalizedService}:${normalizedUserId}`;
  const nextValue = value === true;
  const run = creatorFlagMutationQueue.then(async () => {
    const { flags, overflow } = await loadCreatorFlags();
    if (overflow) {
      throw new Error("Stored creator flags exceed safety limits; refusing a lossy update");
    }
    if (legacyKey !== null) delete flags[legacyKey];
    if (nextValue) {
      if (!Object.hasOwn(flags, key) && Object.keys(flags).length >= MAX_CREATOR_FLAGS) {
        throw new Error(`Creator flags exceed ${MAX_CREATOR_FLAGS} records`);
      }
      flags[key] = true;
    } else {
      delete flags[key];
    }
    await saveCreatorFlags(flags);
    return nextValue;
  });
  creatorFlagMutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

export const HISTORY_DB_INFO = Object.freeze({
  name: HISTORY_DB_NAME,
  version: HISTORY_DB_VERSION,
  store: HISTORY_STORE,
  schemaVersion: HISTORY_SCHEMA_VERSION,
});
