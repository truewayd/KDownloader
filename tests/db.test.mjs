import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function keyToken(key) {
  return JSON.stringify(key);
}

function keyFromPath(value, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map((part) => value[part]);
  return keyPath ? value[keyPath] : undefined;
}

class FakeDOMStringList {
  constructor(values) {
    this.values = values;
  }

  contains(value) {
    return this.values.has(value);
  }

  [Symbol.iterator]() {
    return this.values[Symbol.iterator]();
  }
}

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  dispatch(type, extra = {}) {
    const event = { target: this, ...extra };
    this[`on${type}`]?.(event);
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

class FakeKeyRange {
  static only(value) {
    return new FakeKeyRange(value, value, false, false);
  }

  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }

  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  includes(value) {
    const serialized = keyToken(value);
    const lower = keyToken(this.lower);
    const upper = keyToken(this.upper);
    return (this.lowerOpen ? serialized > lower : serialized >= lower)
      && (this.upperOpen ? serialized < upper : serialized <= upper);
  }
}

function matchesQuery(value, query) {
  if (query === undefined || query === null) return true;
  if (query instanceof FakeKeyRange) return query.includes(value);
  return keyToken(value) === keyToken(query);
}

class FakeTransaction {
  constructor(database, storeNames, mode = "readonly") {
    this.database = database;
    this.storeNames = new Set(Array.isArray(storeNames) ? storeNames : [storeNames]);
    this.mode = mode;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.error = null;
    this.pending = 0;
    this.completionTimer = null;
    this.aborted = false;
  }

  objectStore(name) {
    if (!this.storeNames.has(name) || !this.database.stores.has(name)) {
      throw new Error(`Object store not found: ${name}`);
    }
    return new FakeObjectStore(this.database.stores.get(name), this);
  }

  request(operation) {
    const request = new FakeRequest();
    this.pending += 1;
    clearTimeout(this.completionTimer);
    queueMicrotask(() => {
      if (this.aborted) return;
      try {
        request.result = operation();
        request.dispatch("success");
      } catch (error) {
        request.error = error;
        this.error = error;
        request.dispatch("error");
        this.onerror?.({ target: this });
      } finally {
        this.pending -= 1;
        this.scheduleCompletion();
      }
    });
    return request;
  }

  scheduleCompletion() {
    if (this.pending !== 0 || this.aborted) return;
    clearTimeout(this.completionTimer);
    this.completionTimer = setTimeout(() => this.oncomplete?.({ target: this }), 0);
  }

  abort() {
    this.aborted = true;
    this.onabort?.({ target: this });
  }
}

class FakeIndex {
  constructor(store, definition, transaction) {
    this.store = store;
    this.definition = definition;
    this.transaction = transaction;
  }

  getAll(query) {
    return this.transaction.request(() => Array.from(this.store.records.values())
      .filter((record) => matchesQuery(keyFromPath(record, this.definition.keyPath), query))
      .map(clone));
  }

  count(query) {
    return this.transaction.request(() => Array.from(this.store.records.values())
      .filter((record) => matchesQuery(keyFromPath(record, this.definition.keyPath), query)).length);
  }
}

class FakeObjectStore {
  constructor(store, transaction) {
    this.store = store;
    this.transaction = transaction;
    this.keyPath = store.keyPath;
    this.indexNames = new FakeDOMStringList(store.indexes);
  }

  createIndex(name, keyPath, options = {}) {
    this.store.indexes.add(name);
    this.store.indexDefinitions.set(name, { keyPath, ...options });
    return new FakeIndex(this.store, this.store.indexDefinitions.get(name), this.transaction);
  }

  deleteIndex(name) {
    if (!this.store.indexes.has(name)) throw new Error(`Index not found: ${name}`);
    this.store.indexes.delete(name);
    this.store.indexDefinitions.delete(name);
  }

  index(name) {
    const definition = this.store.indexDefinitions.get(name);
    if (!definition) throw new Error(`Index not found: ${name}`);
    return new FakeIndex(this.store, definition, this.transaction);
  }

  put(value, explicitKey) {
    return this.transaction.request(() => {
      const key = explicitKey ?? keyFromPath(value, this.store.keyPath);
      this.store.records.set(keyToken(key), clone(value));
      return clone(key);
    });
  }

  add(value, explicitKey) {
    return this.transaction.request(() => {
      const key = explicitKey ?? keyFromPath(value, this.store.keyPath);
      const token = keyToken(key);
      if (this.store.records.has(token)) throw new Error("ConstraintError");
      this.store.records.set(token, clone(value));
      return clone(key);
    });
  }

  get(key) {
    return this.transaction.request(() => clone(this.store.records.get(keyToken(key))));
  }

  getAll(query) {
    return this.transaction.request(() => Array.from(this.store.records.entries())
      .filter(([token]) => matchesQuery(JSON.parse(token), query))
      .map(([, value]) => clone(value)));
  }

  count(query) {
    return this.transaction.request(() => Array.from(this.store.records.keys())
      .filter((token) => matchesQuery(JSON.parse(token), query)).length);
  }

  delete(key) {
    return this.transaction.request(() => this.store.records.delete(keyToken(key)));
  }

  clear() {
    return this.transaction.request(() => this.store.records.clear());
  }
}

class FakeDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.stores = new Map();
    this.objectStoreNames = new FakeDOMStringList(new Set());
  }

  createObjectStore(name, { keyPath } = {}) {
    const store = {
      keyPath,
      records: new Map(),
      indexes: new Set(),
      indexDefinitions: new Map(),
    };
    this.stores.set(name, store);
    this.objectStoreNames.values.add(name);
    return new FakeObjectStore(store, new FakeTransaction(this, name, "versionchange"));
  }

  transaction(storeNames, mode) {
    return new FakeTransaction(this, storeNames, mode);
  }

  close() {}
}

class FakeIndexedDB {
  constructor() {
    this.databases = new Map();
  }

  open(name, requestedVersion) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      const existing = this.databases.get(name);
      const oldVersion = existing?.version || 0;
      const version = requestedVersion || existing?.version || 1;
      const database = existing || new FakeDatabase(name, version);
      if (version < oldVersion) {
        request.error = new Error("VersionError");
        request.dispatch("error");
        return;
      }
      database.version = version;
      this.databases.set(name, database);
      request.result = database;
      if (!existing || version > oldVersion) {
        request.transaction = new FakeTransaction(database, [], "versionchange");
        request.dispatch("upgradeneeded", { oldVersion, newVersion: version });
      }
      request.dispatch("success");
    });
    return request;
  }

  deleteDatabase(name) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.databases.delete(name);
      request.dispatch("success");
    });
    return request;
  }
}

function createChromeMock() {
  const areas = { local: {}, sync: {} };
  const area = (name) => ({
    async get(keys) {
      if (keys === null || keys === undefined) return clone(areas[name]);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested
        .filter((key) => Object.hasOwn(areas[name], key))
        .map((key) => [key, clone(areas[name][key])]));
    },
    async set(values) {
      Object.assign(areas[name], clone(values));
    },
  });
  return {
    alarms: { create() {} },
    storage: { local: area("local"), sync: area("sync") },
  };
}

async function loadDBModule() {
  globalThis.indexedDB = new FakeIndexedDB();
  globalThis.IDBKeyRange = FakeKeyRange;
  globalThis.chrome = createChromeMock();

  const constantsSource = await readFile(path.join(root, "background", "constants.js"), "utf8");
  const constantsUrl = `data:text/javascript;base64,${Buffer.from(constantsSource).toString("base64")}`;
  const dbSource = (await readFile(path.join(root, "background", "db.js"), "utf8"))
    .replace(/from\s+["']\.\/constants\.js["']/, `from "${constantsUrl}"`);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(`${dbSource}\n// ${crypto.randomUUID()}`).toString("base64")}`;
  return import(moduleUrl);
}

function record(overrides = {}) {
  return {
    source: "default",
    service: "patreon",
    userId: "creator-1",
    postId: "post-1",
    status: "complete",
    totalCount: 3,
    successCount: 3,
    failedCount: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function importPayload(records) {
  return JSON.stringify({
    schemaVersion: 2,
    exportedAt: "2026-07-11T00:00:01.000Z",
    records,
  });
}

function importEnvelope(overrides = {}) {
  return {
    schemaVersion: 2,
    exportedAt: "2026-07-11T00:00:01.000Z",
    ...overrides,
  };
}

function sortedRecords(records) {
  return [...records].sort((left, right) =>
    [left.source, left.service, left.userId, left.postId].join("\0")
      .localeCompare([right.source, right.service, right.userId, right.postId].join("\0")));
}

test("history database version 3 has no unused secondary indexes", async () => {
  const db = await loadDBModule();
  await db.getHistoryStats();

  assert.equal(db.HISTORY_DB_INFO.version, 3);
  const database = globalThis.indexedDB.databases.get(db.HISTORY_DB_INFO.name);
  assert.ok(database);
  assert.deepEqual([...database.stores.get("records").indexes], []);
  assert.deepEqual([...database.stores.get("importRecords").indexes], []);
});

test("downloaded status distinguishes partial from terminal records", async () => {
  const db = await loadDBModule();
  await db.importDB(importPayload([
    record({ postId: "partial", status: "partial", successCount: 1, failedCount: 2 }),
    record({ postId: "complete" }),
    record({ postId: "empty", status: "empty", totalCount: 0, successCount: 0 }),
  ]));

  assert.equal(await db.checkDownloaded("patreon", "creator-1", "partial", "default"), false);
  assert.equal(await db.checkDownloaded("patreon", "creator-1", "complete", "default"), true);
  assert.equal(await db.checkDownloaded("patreon", "creator-1", "empty", "default"), true);

  const many = await db.checkDownloadedMany([
    { source: "default", service: "patreon", userId: "creator-1", postId: "partial" },
    { source: "default", service: "patreon", userId: "creator-1", postId: "complete" },
    { source: "default", service: "patreon", userId: "creator-1", postId: "missing" },
  ]);
  assert.deepEqual(many, {
    "patreon:creator-1:partial": false,
    "patreon:creator-1:complete": true,
    "patreon:creator-1:missing": false,
  });
});

test("markDownloaded upserts one compound key and preserves record fields", async () => {
  const db = await loadDBModule();
  await db.markDownloaded(record({ status: "partial", successCount: 1, failedCount: 2 }));
  await db.markDownloaded(record({ status: "complete", successCount: 3, failedCount: 0 }));

  const exported = JSON.parse(await db.exportDB());
  assert.equal(exported.schemaVersion, 2);
  assert.equal(exported.records.length, 1);
  assert.deepEqual(exported.records[0], record());
  assert.equal(await db.checkDownloaded("patreon", "creator-1", "post-1", "default"), true);
});

test("legacy markDownloaded arguments remain a complete terminal record", async () => {
  const db = await loadDBModule();
  await db.markDownloaded("fanbox", "creator-legacy", "post-legacy", "default");

  assert.equal(await db.checkDownloaded("fanbox", "creator-legacy", "post-legacy", "default"), true);
  const exported = JSON.parse(await db.exportDB());
  assert.equal(exported.records.length, 1);
  assert.equal(exported.records[0].status, "complete");
});

test("concurrent batch writes do not lose records", async () => {
  const db = await loadDBModule();
  const batches = Array.from({ length: 8 }, (_, batch) => Array.from({ length: 20 }, (_, index) =>
    record({ postId: `post-${batch}-${index}` })));

  await Promise.all(batches.map((items) => db.markMultipleDownloaded(items)));

  const exported = JSON.parse(await db.exportDB());
  assert.equal(exported.records.length, 160);
  assert.equal(new Set(exported.records.map((item) => item.postId)).size, 160);
});

test("export and import round-trip every JSON record field", async () => {
  const db = await loadDBModule();
  const records = [
    record(),
    record({
      source: "coomerfans",
      service: "onlyfans",
      userId: "creator-2",
      postId: "post-2",
      status: "partial",
      totalCount: 5,
      successCount: 4,
      failedCount: 1,
      updatedAt: "2026-07-11T01:02:03.000Z",
    }),
  ];
  await db.importDB(importPayload(records));
  const firstExport = JSON.parse(await db.exportDB());

  assert.equal(firstExport.schemaVersion, 2);
  assert.equal(typeof firstExport.exportedAt, "string");
  assert.deepEqual(sortedRecords(firstExport.records), sortedRecords(records));

  const freshDb = await loadDBModule();
  await freshDb.importDB(JSON.stringify(firstExport));
  const secondExport = JSON.parse(await freshDb.exportDB());
  assert.deepEqual(sortedRecords(secondExport.records), sortedRecords(records));
});

test("chunked import keeps current history visible until commit replaces it", async () => {
  const db = await loadDBModule();
  const existing = record({ postId: "existing" });
  const incoming = [
    record({ postId: "incoming-1" }),
    record({
      source: "coomerfans",
      service: "onlyfans",
      userId: "creator-2",
      postId: "incoming-2",
      status: "partial",
      totalCount: 4,
      successCount: 3,
      failedCount: 1,
    }),
  ];
  await db.markDownloaded(existing);

  const sessionId = await db.beginImportSession(importEnvelope());
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId.length > 0);
  await db.appendImportChunk(sessionId, incoming.slice(0, 1));

  let exported = JSON.parse(await db.exportDB());
  assert.deepEqual(exported.records, [existing]);

  await db.appendImportChunk(sessionId, incoming.slice(1));
  await db.commitImportSession(sessionId);
  assert.equal((await db.getImportSessionStatus(sessionId)).state, "committed");

  exported = JSON.parse(await db.exportDB());
  assert.deepEqual(sortedRecords(exported.records), sortedRecords(incoming));
  assert.equal(await db.checkDownloaded("patreon", "creator-1", "existing", "default"), false);
  assert.equal(await db.checkDownloaded("onlyfans", "creator-2", "incoming-2", "coomerfans"), false);
  assert.equal(await db.checkDownloaded("patreon", "creator-1", "incoming-1", "default"), true);
});

test("aborting a chunked import discards staging records without changing history", async () => {
  const db = await loadDBModule();
  const existing = record({ postId: "existing" });
  await db.markDownloaded(existing);

  const sessionId = await db.beginImportSession(importEnvelope());
  await db.appendImportChunk(sessionId, [record({ postId: "staged" })]);
  await db.abortImportSession(sessionId);
  assert.equal((await db.getImportSessionStatus(sessionId)).state, "missing");

  const exported = JSON.parse(await db.exportDB());
  assert.deepEqual(exported.records, [existing]);
  assert.equal(await db.checkDownloaded("patreon", "creator-1", "existing", "default"), true);
  assert.equal(await db.checkDownloaded("patreon", "creator-1", "staged", "default"), false);
  await assert.rejects(db.appendImportChunk(sessionId, [record({ postId: "late" })]));
  await assert.rejects(db.commitImportSession(sessionId));
});

test("chunk validation errors leave current history intact and can be aborted", async () => {
  const db = await loadDBModule();
  const existing = record({ postId: "existing" });
  await db.markDownloaded(existing);

  const sessionId = await db.beginImportSession(importEnvelope());
  await db.appendImportChunk(sessionId, [record({ postId: "valid-staged" })]);
  await assert.rejects(
    db.appendImportChunk(sessionId, [record({ postId: "invalid-staged", status: "unknown" })])
  );

  let exported = JSON.parse(await db.exportDB());
  assert.deepEqual(exported.records, [existing]);

  await db.abortImportSession(sessionId);
  exported = JSON.parse(await db.exportDB());
  assert.deepEqual(exported.records, [existing]);
});

test("chunked import rejects duplicate identities within one chunk and preserves live history", async () => {
  const db = await loadDBModule();
  const existing = record({ postId: "existing" });
  const duplicate = record({ postId: "duplicate" });
  await db.markDownloaded(existing);

  const sessionId = await db.beginImportSession(importEnvelope({ expectedRecords: 2 }));
  await assert.rejects(
    db.appendImportChunk(sessionId, [duplicate, { ...duplicate, updatedAt: "2026-07-11T02:00:00.000Z" }]),
    /Duplicate history identity/
  );

  assert.deepEqual(JSON.parse(await db.exportDB()).records, [existing]);
  await db.abortImportSession(sessionId);
  assert.deepEqual(JSON.parse(await db.exportDB()).records, [existing]);
});

test("chunked import rejects duplicate identities across chunks and preserves live history", async () => {
  const db = await loadDBModule();
  const existing = record({ postId: "existing" });
  const duplicate = record({ postId: "duplicate" });
  await db.markDownloaded(existing);

  const sessionId = await db.beginImportSession(importEnvelope({ expectedRecords: 2 }));
  await db.appendImportChunk(sessionId, [duplicate], { sequence: 0, digest: "first" });
  await assert.rejects(
    db.appendImportChunk(
      sessionId,
      [{ ...duplicate, status: "empty", totalCount: 0, successCount: 0, failedCount: 0 }],
      { sequence: 1, digest: "second" }
    ),
    /Duplicate history identity/
  );

  assert.deepEqual(JSON.parse(await db.exportDB()).records, [existing]);
  await db.abortImportSession(sessionId);
  assert.deepEqual(JSON.parse(await db.exportDB()).records, [existing]);
});

test("the same post id remains valid under a different creator identity", async () => {
  const db = await loadDBModule();
  const records = [
    record({ userId: "creator-a", postId: "shared-post-id" }),
    record({ userId: "creator-b", postId: "shared-post-id" }),
  ];
  await db.importDB(importPayload(records));
  assert.deepEqual(sortedRecords(JSON.parse(await db.exportDB()).records), sortedRecords(records));
});

test("chunk retries with the same sequence and digest are idempotent", async () => {
  const db = await loadDBModule();
  const sessionId = await db.beginImportSession(importEnvelope({ expectedRecords: 1 }));
  const incoming = record({ postId: "retried" });
  await db.appendImportChunk(sessionId, [incoming], { sequence: 0, digest: "same" });
  await db.appendImportChunk(sessionId, [incoming], { sequence: 0, digest: "same" });
  await assert.rejects(
    db.appendImportChunk(sessionId, [incoming], { sequence: 0, digest: "different" })
  );
  await db.commitImportSession(sessionId);
  const exported = JSON.parse(await db.exportDB());
  assert.deepEqual(exported.records, [incoming]);
});

test("import rejects malformed or incompatible payloads", async () => {
  const db = await loadDBModule();
  await assert.rejects(db.importDB("{"));
  await assert.rejects(db.importDB(JSON.stringify({ schemaVersion: 1, records: [] })));
  await assert.rejects(
    db.importDB(JSON.stringify({ schemaVersion: 2, exportedAt: "not-a-date", records: [] }))
  );
  await assert.rejects(db.importDB(JSON.stringify({ schemaVersion: 2, records: [{}] })));
  await assert.rejects(db.importDB(importPayload([record({ status: "unknown" })])));
});

test("clearDB removes regular and CoomerFans records", async () => {
  const db = await loadDBModule();
  await db.markMultipleDownloaded([
    record(),
    record({ source: "coomerfans", service: "onlyfans", userId: "creator-2", postId: "post-2" }),
  ]);
  await db.clearDB();

  const exported = JSON.parse(await db.exportDB());
  assert.deepEqual(exported.records, []);
  assert.equal(await db.checkDownloaded("patreon", "creator-1", "post-1", "default"), false);
  assert.equal(await db.checkDownloaded("onlyfans", "creator-2", "post-2", "coomerfans"), false);
});

test("history stats report record count and serialized bytes", async () => {
  const db = await loadDBModule();
  const initialRecords = [record(), record({ postId: "post-2" })];
  await db.importDB(importPayload(initialRecords));

  const initialStats = await db.getHistoryStats();
  assert.equal(initialStats.records, 2);
  assert.ok(Number.isInteger(initialStats.bytes) && initialStats.bytes > 0);

  await db.markDownloaded(initialRecords[0]);
  const overwriteStats = await db.getHistoryStats();
  assert.deepEqual(overwriteStats, initialStats);

  await db.markDownloaded(record({ postId: "post-3" }));
  const addedStats = await db.getHistoryStats();
  assert.equal(addedStats.records, 3);
  assert.ok(addedStats.bytes > initialStats.bytes);

  await db.markMultipleDownloaded([
    record({ postId: "post-2", status: "empty", totalCount: 0, successCount: 0, failedCount: 0 }),
    record({ postId: "post-4" }),
  ]);
  const mixedStats = await db.getHistoryStats();
  assert.equal(mixedStats.records, 4);
});

test("paginated export returns every record without one oversized response", async () => {
  const db = await loadDBModule();
  const records = Array.from({ length: 600 }, (_, index) => record({
    postId: `post-${String(index).padStart(4, "0")}-${"x".repeat(120)}`,
  }));
  await db.markMultipleDownloaded(records);

  const exported = [];
  let afterKey = null;
  let pages = 0;
  while (true) {
    const page = await db.getHistoryExportPage(afterKey, 64 * 1024);
    exported.push(...page.records);
    pages++;
    if (page.done) break;
    assert.ok(page.nextKey);
    afterKey = page.nextKey;
  }

  assert.ok(pages > 1);
  assert.equal(exported.length, records.length);
  assert.deepEqual(sortedRecords(exported), sortedRecords(records));
});

test("export pages stay pinned to one generation across a later import commit", async () => {
  const db = await loadDBModule();
  const firstGeneration = Array.from({ length: 500 }, (_, index) => record({
    postId: `first-${String(index).padStart(4, "0")}-${"x".repeat(120)}`,
  }));
  await db.importDB(importPayload(firstGeneration));
  const exportSession = await db.beginHistoryExport();
  const firstPage = await db.getHistoryExportPage(null, 64 * 1024, exportSession.generation);
  assert.equal(firstPage.done, false);

  const replacement = [record({ postId: "replacement" })];
  await db.importDB(importPayload(replacement));

  const exported = [...firstPage.records];
  let afterKey = firstPage.nextKey;
  while (true) {
    const page = await db.getHistoryExportPage(afterKey, 64 * 1024, exportSession.generation);
    exported.push(...page.records);
    if (page.done) break;
    afterKey = page.nextKey;
  }
  assert.deepEqual(sortedRecords(exported), sortedRecords(firstGeneration));
  assert.deepEqual(JSON.parse(await db.exportDB()).records, replacement);
});

test("marks after generation commit remain visible in the active generation", async () => {
  const db = await loadDBModule();
  await db.importDB(importPayload([record({ postId: "imported" })]));
  await db.markDownloaded(record({ postId: "after-import" }));
  assert.equal(await db.checkDownloaded("patreon", "creator-1", "after-import", "default"), true);
  const exported = JSON.parse(await db.exportDB());
  assert.equal(exported.records.some((item) => item.postId === "after-import"), true);
});
