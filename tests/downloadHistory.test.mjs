import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../background/messageHelpers.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { buildDownloadHistoryRecord } = await import(moduleUrl);

const item = {
  source: "default",
  service: "patreon",
  userId: "creator-1",
  postId: "post-1",
};

test("backend hand-off is recorded complete even without final disk confirmation", () => {
  const record = buildDownloadHistoryRecord(item, {
    success: true,
    backend: true,
    successCount: 1,
    results: [{ success: true }, { success: false }],
  });
  assert.equal(record.status, "complete");
  assert.equal(record.totalCount, 2);
  assert.equal(record.successCount, 1);
  assert.equal(record.failedCount, 1);
});

test("local partial result remains retryable", () => {
  const record = buildDownloadHistoryRecord(item, {
    success: true,
    successCount: 1,
    results: [{ success: true }, { success: false }],
  });
  assert.equal(record.status, "partial");
});

test("local complete and empty results use terminal statuses", () => {
  assert.equal(buildDownloadHistoryRecord(item, {
    success: true,
    successCount: 2,
    results: [{ success: true }, { success: true }],
  }).status, "complete");

  assert.equal(buildDownloadHistoryRecord(item, {
    success: true,
    noFiles: true,
    results: [],
  }).status, "empty");
});

test("all-failed and already-downloaded results do not create new history", () => {
  assert.equal(buildDownloadHistoryRecord(item, {
    success: true,
    successCount: 0,
    results: [{ success: false }],
  }), null);
  assert.equal(buildDownloadHistoryRecord(item, {
    success: true,
    alreadyDownloaded: true,
  }), null);
  assert.equal(buildDownloadHistoryRecord(item, {
    success: false,
    backend: true,
    incomplete: true,
    results: [{ success: true }],
  }), null);
  assert.equal(buildDownloadHistoryRecord(item, {
    success: false,
    cancelled: true,
    results: [],
  }), null);
  assert.equal(buildDownloadHistoryRecord(item, {
    success: true,
    skippedByFilter: true,
    filteredCount: 2,
    results: [],
  }), null);
});
