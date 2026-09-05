import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const asModuleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

globalThis.chrome = {
  runtime: {
    id: "test-extension",
    lastError: null,
    sendMessage(payload, callback) {
      globalThis.__acceptedTabMessages?.push(payload);
      callback?.();
    },
  },
  tabs: {
    sendMessage(_tabId, payload, callback) {
      globalThis.__acceptedTabMessages?.push(payload);
      callback?.();
    },
  },
};
globalThis.__acceptedStartCalls = 0;

const constantsUrl = asModuleUrl(`
  export const API = {
    HOSTS: ["coomer.st", "kemono.cr"],
    COOMERFANS_HOST: "coomerfans.com",
    COOMERFANS_ORIGIN: "https://coomerfans.com",
    DEFAULT_ORIGIN: "https://kemono.cr",
    API_PREFIX: "/api/v1",
  };
  export const PAW = { HOST: "pawchive.pw", HOSTS: ["pawchive.pw"], ORIGIN: "https://pawchive.pw" };
`);
const utilUrl = asModuleUrl(`
  const UTIL = {
    hasUnpairedSurrogate() { return false; },
    normalizeCreatorFetchMode() { return globalThis.__acceptedCreatorMode || "default"; },
    extractExternalLinks() { return []; },
    extractPostExternalLinks(post) { return post?.content ? [post.content] : []; },
    filterExternalLinks(links) { return links; },
  };
  export default UTIL;
`);
const networkUrl = asModuleUrl(`
  export async function handleAPIRequest(url) {
    if (typeof globalThis.__acceptedApiResponse === "function") return globalThis.__acceptedApiResponse(url);
    return [];
  }
  export async function readLimitedResponseText(response) { return response.text(); }
`);
const downloadUrl = asModuleUrl(`
  export async function startFullDownload(_service, _userId, postId, _path, senderUrl) {
    globalThis.__acceptedStartCalls++;
    globalThis.__acceptedDownloadOrigins?.push(senderUrl);
    await Promise.resolve();
    if (typeof globalThis.__acceptedFallbackFactory === "function") {
      return globalThis.__acceptedFallbackFactory(postId);
    }
    return { success: true, noFiles: true, results: [], externalLinks: globalThis.__acceptedExternalLinks || [] };
  }
  export async function startPawchiveDownload() { return startFullDownload(); }
  export async function startCoomerFansDownload() { return startFullDownload(); }
  export async function dispatchExternalLinksTextTask(entries) {
    globalThis.__acceptedDispatchedLinkCount = entries.length;
    if (globalThis.__acceptedLinkDispatch) return globalThis.__acceptedLinkDispatch(entries);
    return { success: true, skipped: true };
  }
  export async function dispatchTextDownloadTask() { return { success: true }; }
  export async function runSequentialDownloads() { return { successCount: 0, results: [] }; }
`);
const pawchiveUrl = asModuleUrl(`
  export async function fetchAllPawchiveCreatorPosts() { return globalThis.__acceptedPawPosts || []; }
  export async function fetchPawchiveDms() { return { url: "", messages: [] }; }
  export async function fetchPawchiveCreatorPage() { return globalThis.__acceptedPawPosts || []; }
  export function formatPawchiveDmsText() { return "empty"; }
  export function isCompletePawchivePost() { return true; }
`);
const dbUrl = asModuleUrl(`
  export function downloadedItemKey(...values) { return JSON.stringify(values); }
  export async function checkDownloadedMany(items) {
    globalThis.__acceptedCheckedBatchSizes = globalThis.__acceptedCheckedBatchSizes || [];
    globalThis.__acceptedCheckedBatchSizes.push(items.length);
    return Object.fromEntries(items.map((item) => [
      downloadedItemKey(item.service, item.userId, item.postId, item.source),
      !globalThis.__acceptedUnprocessed,
    ]));
  }
  export async function markDownloaded() {
    if (globalThis.__acceptedHistoryError) throw new Error(globalThis.__acceptedHistoryError);
  }
  export async function markMultipleDownloaded() {}
`);
const progressUrl = asModuleUrl(`
  export function registerBatch() {}
  export function updateProcessed() {}
  export function updateAcked() {}
  export function completeBatch() {}
`);
const helpersUrl = asModuleUrl(
  await readFile(path.join(root, "background", "messageHelpers.js"), "utf8")
);
const fallbackUrl = asModuleUrl(`
  export const NATIVE_FALLBACK_LIMITS = {
    maxRequests: 5000,
    maxTasksPerRequest: 1000,
    maxTasksTotal: 5000,
    maxExternalLinksTotal: 5000,
    maxStorageBytes: 8 * 1024 * 1024,
  };
  export function measureNativeFallbackRequest(request) {
    const taskCount = Array.isArray(request?.tasks) ? request.tasks.length : 0;
    if (taskCount > 1000) throw new Error("Native fallback request exceeds 1000 tasks");
    return {
      taskCount,
      externalLinkCount: Array.isArray(request?.externalLinks) ? request.externalLinks.length : 0,
      bytes: 256 + taskCount * 128,
    };
  }
  export async function clearNativeFallbackNotification() {}
  export async function enqueueNativeFallback(requests) {
    globalThis.__acceptedFallbackEnqueued = Array.isArray(requests) ? requests : [requests];
  }
  export async function takeNativeFallback() { return null; }
`);
const configUrl = asModuleUrl(`
  export async function loadExternalLinkFilterConfig() { return { mode: "disabled" }; }
`);

const handlerSource = (await readFile(
  path.join(root, "background", "handlers", "downloadHandlers.js"),
  "utf8"
))
  .replace(/from\s+["']\.\.\/constants\.js["']/, `from "${constantsUrl}"`)
  .replace(/from\s+["']\.\.\/util\.js["']/, `from "${utilUrl}"`)
  .replace(/from\s+["']\.\.\/network\.js["']/, `from "${networkUrl}"`)
  .replace(/from\s+["']\.\.\/download\.js["']/, `from "${downloadUrl}"`)
  .replace(/from\s+["']\.\.\/pawchive\.js["']/, `from "${pawchiveUrl}"`)
  .replace(/from\s+["']\.\.\/db\.js["']/, `from "${dbUrl}"`)
  .replace(/from\s+["']\.\.\/progress\.js["']/, `from "${progressUrl}"`)
  .replace(/from\s+["']\.\.\/messageHelpers\.js["']/, `from "${helpersUrl}"`)
  .replace(/from\s+["']\.\.\/nativeFallback\.js["']/, `from "${fallbackUrl}"`)
  .replace(/from\s+["']\.\.\/config\.js["']/, `from "${configUrl}"`);
const handlerInternals = await import(asModuleUrl(handlerSource
  .replace(
    "function forEachAnchorHref(input, visitor)",
    "export function forEachAnchorHref(input, visitor)"
  )
  .replace(
    "function createExternalLinkAccumulator()",
    "export function createExternalLinkAccumulator()"
  )
  .replace(
    "function collectExternalLinkEntries(accumulator, item, result, senderUrl)",
    "export function collectExternalLinkEntries(accumulator, item, result, senderUrl)"
  )
  .replace(
    "async function fetchCreatorPosts(origin, service, userId, options = {})",
    "export async function fetchCreatorPosts(origin, service, userId, options = {})"
  )));
const {
  collectExternalLinkEntries,
  createDownloadHandlers,
  createExternalLinkAccumulator,
  fetchCreatorPosts,
  forEachAnchorHref,
  projectCreatorPost,
  projectDownloadResultForBroadcast,
} = handlerInternals;

test("retrying an accepted startDownload request id starts only once", async () => {
  const handler = createDownloadHandlers().startDownload;
  const requestId = `content:${crypto.randomUUID()}`;
  const sender = {
    url: "https://kemono.cr/patreon/user/creator/post/post-1",
    tab: { id: 17, url: "https://kemono.cr/patreon/user/creator/post/post-1" },
  };
  const message = {
    service: "patreon",
    userId: "creator",
    postId: "post-1",
    path: "/patreon/user/creator/post/post-1",
    requestId,
  };
  const responses = [];

  assert.equal(handler({ message, sender, sendResponse: (value) => responses.push(value) }), false);
  assert.equal(handler({ message, sender, sendResponse: (value) => responses.push(value) }), false);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(globalThis.__acceptedStartCalls, 1);
  assert.deepEqual(responses, [
    { success: true, accepted: true },
    { success: true, accepted: true },
  ]);
});

test("download RPCs reject unsupported web senders before starting", () => {
  const handler = createDownloadHandlers().startDownload;
  let response;
  handler({
    message: { service: "patreon", userId: "creator", postId: "post-2" },
    sender: { url: "https://attacker.example/post", tab: { id: 19 } },
    sendResponse(value) { response = value; },
  });
  assert.equal(response.success, false);
  assert.match(response.error, /supported site pages/);
});

test("creator fetch and page RPCs hard-cap abnormal API arrays", async () => {
  globalThis.__acceptedCheckedBatchSizes = [];
  const posts = Array.from({ length: 10001 }, (_, index) => ({ id: `post-${index}` }));
  globalThis.__acceptedApiResponse = (url) => url.includes('/profile')
    ? { post_count: 10000 }
    : posts;
  const handlers = createDownloadHandlers();
  handlers['creator.fetch']({
    message: {
      service: 'patreon', userId: 'creator', origin: 'https://kemono.cr',
      requestId: `fetch:${crypto.randomUUID()}`,
    },
    sender: { url: 'chrome-extension://test-extension/popup/popup.html' },
    sendResponse() {},
  });
  handlers['creator.pageFetch']({
    message: { service: 'patreon', userId: 'creator', requestId: `page:${crypto.randomUUID()}` },
    sender: { url: 'https://kemono.cr/patreon/user/creator', tab: { id: 20 } },
    sendResponse() {},
  });
  for (let attempt = 0; attempt < 100 && globalThis.__acceptedCheckedBatchSizes.length < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(globalThis.__acceptedCheckedBatchSizes.sort((a, b) => a - b), [5000, 10000]);
});

test("creator pagination retains only its minimum projection and enforces one cross-page budget", async () => {
  const raw = {
    id: "post-1",
    file: { path: "/data/file.jpg", name: "unused.jpg", nested: { unused: true } },
    content: "https://example.invalid/file",
    embed: { url: "https://embed.invalid/item", title: "unused" },
    payload: "x".repeat(4096),
  };
  assert.deepEqual(projectCreatorPost(raw, false), {
    id: "post-1",
    file: { path: "/data/file.jpg" },
  });
  assert.deepEqual(projectCreatorPost(raw, true), {
    id: "post-1",
    file: { path: "/data/file.jpg" },
    content: "https://example.invalid/file",
    embed: { url: "https://embed.invalid/item" },
  });

  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    id: `first-${index}`,
    content: "a".repeat(100),
    ignored: "z".repeat(2048),
  }));
  const secondPage = Array.from({ length: 50 }, (_, index) => ({
    id: `second-${index}`,
    content: "b".repeat(100),
  }));
  globalThis.__acceptedApiResponse = (url) => {
    if (url.includes("/profile")) return { post_count: 100 };
    return url.endsWith("?o=0") ? firstPage : secondPage;
  };
  await assert.rejects(
    fetchCreatorPosts("https://kemono.cr", "patreon", "creator", {
      includePostData: true,
      maxRetainedBytes: 21_000,
    }),
    /retained-data safety limit/
  );
});

test("batch external-link aggregation is globally capped", async () => {
  globalThis.__acceptedExternalLinks = Array.from(
    { length: 5000 },
    (_, index) => `https://example.invalid/${index}`
  );
  globalThis.__acceptedDispatchedLinkCount = 0;
  createDownloadHandlers().startDownloadBatch({
    message: {
      items: [
        { service: 'patreon', userId: 'creator', postId: 'one' },
        { service: 'patreon', userId: 'creator', postId: 'two' },
      ],
      aggregateExternalLinks: true,
      requestId: `batch:${crypto.randomUUID()}`,
    },
    sender: { url: 'https://kemono.cr/patreon/user/creator', tab: { id: 21 } },
    sendResponse() {},
  });
  for (let attempt = 0; attempt < 150 && globalThis.__acceptedDispatchedLinkCount === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(globalThis.__acceptedDispatchedLinkCount, 5000);
});

test("external-link aggregation deduplicates early and never retains more than the TXT byte budget", () => {
  const first = `https://example.invalid/0/${"x".repeat(8100)}`;
  const links = [first, first];
  for (let index = 1; index < 1200; index++) {
    links.push(`https://example.invalid/${index}/${"x".repeat(8100)}`);
  }
  const accumulator = createExternalLinkAccumulator();
  collectExternalLinkEntries(
    accumulator,
    { service: "patreon", userId: "creator", postId: "post-1" },
    { externalLinks: links },
    "https://kemono.cr/patreon/user/creator/post/post-1"
  );

  assert.ok(accumulator.entries.length < links.length - 1);
  assert.equal(accumulator.entries.filter((entry) => entry.url === first).length, 1);
  assert.ok(accumulator.textBytes <= 8 * 1024 * 1024);
  assert.equal(accumulator.outputLinks.size, accumulator.entries.length);
});

test("terminal broadcasts project thousands of task results into a bounded UI DTO", () => {
  const task = {
    url: `https://file.pawchive.pw/data/${"x".repeat(8000)}`,
    fileName: `${"n".repeat(1000)}.jpg`,
  };
  const dto = projectDownloadResultForBroadcast({
    success: true,
    backend: true,
    results: Array.from({ length: 5000 }, (_, index) => ({ task, success: index % 2 === 0 })),
    externalLinks: Array.from(
      { length: 1000 },
      (_, index) => `https://example.invalid/${index}/${"l".repeat(600)}`
    ),
    error: "e".repeat(10_000),
  });

  assert.equal(dto.successCount, 2500);
  assert.equal(dto.totalCount, 5000);
  assert.equal(dto.failedCount, 2500);
  assert.equal(Object.hasOwn(dto, "results"), false);
  assert.equal(Object.hasOwn(dto, "fallbackTasks"), false);
  assert.equal(dto.externalLinksTruncated, true);
  assert.equal(dto.error.length, 2048);
  assert.ok(Buffer.byteLength(JSON.stringify(dto)) < 600 * 1024);
});

test("fallback batch overflow preserves the first 5,000 tasks instead of invalidating all prompts", async () => {
  globalThis.__acceptedFallbackEnqueued = null;
  globalThis.__acceptedTabMessages = [];
  globalThis.__acceptedFallbackFactory = (postId) => ({
    success: false,
    backendFailed: true,
    fallbackTasks: Array.from({ length: 1000 }, (_, index) => ({
      url: `https://file.pawchive.pw/data/${postId}/${index}`,
      fileName: `${postId}-${index}.jpg`,
      type: "attachment",
    })),
    externalLinks: [],
  });
  const requestId = `bounded-fallback:${crypto.randomUUID()}`;
  createDownloadHandlers().startDownloadBatch({
    message: {
      items: Array.from({ length: 6 }, (_, index) => ({
        service: "patreon",
        userId: "creator",
        postId: `post-${index}`,
      })),
      requestId,
    },
    sender: { url: "https://kemono.cr/patreon/user/creator", tab: { id: 23 } },
    sendResponse() {},
  });

  const deadline = Date.now() + 4000;
  while (!globalThis.__acceptedFallbackEnqueued && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    assert.equal(globalThis.__acceptedFallbackEnqueued.length, 5);
    assert.equal(
      globalThis.__acceptedFallbackEnqueued.reduce((sum, request) => sum + request.tasks.length, 0),
      5000
    );
    const failures = globalThis.__acceptedTabMessages.filter(
      (message) => message.action === "downloadComplete" && !message.batch && message.requestId === requestId
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0].result.error, /5,000 task or 8 MiB/);
  } finally {
    globalThis.__acceptedFallbackFactory = null;
    globalThis.__acceptedTabMessages = null;
  }
});

test("CoomerFans identities reject embedded URL credentials", () => {
  let response;
  createDownloadHandlers().startDownload({
    message: {
      source: 'coomerfans', service: 'fansly', userId: 'creator', postId: 'one',
      path: 'https://user:secret@coomerfans.com/p/one/creator/fansly',
    },
    sender: { url: 'https://coomerfans.com/p/one/creator/fansly', tab: { id: 22 } },
    sendResponse(value) { response = value; },
  });
  assert.equal(response.success, false);
  assert.match(response.error, /Invalid CoomerFans post URL/);
});

test("CoomerFans URLs cannot download one post while recording another identity", () => {
  let response;
  createDownloadHandlers().startDownload({
    message: {
      source: 'coomerfans', service: 'fansly', userId: 'creator', postId: 'claimed',
      path: 'https://coomerfans.com/p/actual/creator/fansly',
    },
    sender: { url: 'https://coomerfans.com/p/actual/creator/fansly', tab: { id: 24 } },
    sendResponse(value) { response = value; },
  });
  assert.equal(response.success, false);
  assert.match(response.error, /identity does not match/);
});

test("download sources must match the sending site family", () => {
  let coomerResponse;
  createDownloadHandlers().startDownload({
    message: {
      source: 'coomerfans', service: 'fansly', userId: 'creator', postId: 'one',
      path: 'https://coomerfans.com/p/one/creator/fansly',
    },
    sender: { url: 'https://kemono.cr/patreon/user/creator/post/one', tab: { id: 25 } },
    sendResponse(value) { coomerResponse = value; },
  });
  assert.equal(coomerResponse.success, false);
  assert.match(coomerResponse.error, /does not match the sending site/);

  let pawResponse;
  createDownloadHandlers().startDownload({
    message: { service: 'patreon', userId: 'creator', postId: 'one' },
    sender: { url: 'https://pawchive.pw/patreon/user/creator/post/one', tab: { id: 26 } },
    sendResponse(value) { pawResponse = value; },
  });
  assert.equal(pawResponse.success, true);
  assert.equal(pawResponse.accepted, true);

  let validPawResponse;
  createDownloadHandlers().startDownload({
    message: {
      source: 'default', service: 'patreon', userId: 'creator', postId: 'two',
    },
    sender: { url: 'https://pawchive.pw/patreon/user/creator/post/two', tab: { id: 27 } },
    sendResponse(value) { validPawResponse = value; },
  });
  assert.equal(validPawResponse.success, true);
  assert.equal(validPawResponse.accepted, true);
});

test("CoomerFans listing anchor parsing is linear, bounded, and attribute-aware", () => {
  const malformed = "<a data-no-close ".repeat(25000);
  const hrefs = [];
  forEachAnchorHref(
    `${malformed}<a data-href="https://attacker.invalid/p/fake" title=">" href="/p/one/creator/fansly">`,
    (href) => { hrefs.push(href); }
  );
  assert.deepEqual(hrefs, ["/p/one/creator/fansly"]);
  assert.doesNotMatch(handlerSource, /linkRe\s*=\s*\/<a\\b\[\^>\]\*/);
});

async function waitForBatchCompletion(requestId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const message = globalThis.__acceptedTabMessages?.find(
      (value) => value.action === "downloadComplete" && value.batch && value.requestId === requestId
    );
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Batch did not emit its terminal completion");
}

test("popup creator downloads preserve the validated Coomer origin for each post", async () => {
  globalThis.__acceptedTabMessages = [];
  globalThis.__acceptedDownloadOrigins = [];
  globalThis.__acceptedUnprocessed = true;
  globalThis.__acceptedApiResponse = (url) => url.endsWith('/profile')
    ? { post_count: 1 }
    : [{ id: 'post-1' }];
  const requestId = `coomer-origin:${crypto.randomUUID()}`;
  try {
    createDownloadHandlers()['creator.fetch']({
      message: { service: 'onlyfans', userId: 'creator', origin: 'https://coomer.st', requestId },
      sender: { url: 'chrome-extension://test-extension/popup/popup.html' },
      sendResponse() {},
    });
    assert.equal((await waitForBatchCompletion(requestId)).result.success, true);
    assert.deepEqual(globalThis.__acceptedDownloadOrigins, ['https://coomer.st']);
  } finally {
    globalThis.__acceptedApiResponse = null;
    globalThis.__acceptedUnprocessed = false;
    globalThis.__acceptedDownloadOrigins = null;
    globalThis.__acceptedTabMessages = null;
  }
});

test("empty creator batches emit a successful terminal response with their request id", async () => {
  globalThis.__acceptedTabMessages = [];
  globalThis.__acceptedApiResponse = () => [];
  const requestId = `empty-page:${crypto.randomUUID()}`;
  try {
    createDownloadHandlers()["creator.pageFetch"]({
      message: { service: "patreon", userId: "creator", requestId },
      sender: { url: "https://kemono.cr/patreon/user/creator", tab: { id: 30 } },
      sendResponse() {},
    });
    const terminal = await waitForBatchCompletion(requestId);
    assert.deepEqual(terminal.result, { success: true, totalCount: 0, successCount: 0, failedCount: 0 });
  } finally {
    globalThis.__acceptedApiResponse = null;
    globalThis.__acceptedTabMessages = null;
  }
});

test("creator page request failures cannot masquerade as successful empty downloads", async (t) => {
  t.mock.method(console, "error", () => {});
  globalThis.__acceptedTabMessages = [];
  globalThis.__acceptedApiResponse = () => { throw new Error("HTTP 503"); };
  const requestId = `failed-page:${crypto.randomUUID()}`;
  try {
    createDownloadHandlers()["creator.pageFetch"]({
      message: { service: "patreon", userId: "creator", requestId },
      sender: { url: "https://kemono.cr/patreon/user/creator", tab: { id: 31 } },
      sendResponse() {},
    });
    const terminal = await waitForBatchCompletion(requestId);
    assert.equal(terminal.result.success, false);
    assert.match(terminal.result.error, /HTTP 503/);
    globalThis.__acceptedApiResponse = () => ({ error: "invalid page" });
    const invalidId = `invalid-page:${crypto.randomUUID()}`;
    createDownloadHandlers()["creator.pageFetch"]({
      message: { service: "patreon", userId: "creator", requestId: invalidId },
      sender: { url: "https://kemono.cr/patreon/user/creator", tab: { id: 31 } },
      sendResponse() {},
    });
    assert.match((await waitForBatchCompletion(invalidId)).result.error, /Invalid creator posts response/);
  } finally {
    globalThis.__acceptedApiResponse = null;
    globalThis.__acceptedTabMessages = null;
  }
});

test("creator pagination rejects an interrupted result instead of silently omitting a page", async () => {
  globalThis.__acceptedApiResponse = (url) => {
    if (url.includes("/profile")) return { post_count: 100 };
    if (url.includes("o=50")) throw new Error("HTTP 503");
    return [{ id: "post-1" }];
  };
  try {
    await assert.rejects(fetchCreatorPosts("https://kemono.cr", "patreon", "creator"), /offset 50: HTTP 503/);
  } finally {
    globalThis.__acceptedApiResponse = null;
  }
});

test("creator fetch rejects a malformed profile instead of declaring zero posts", async () => {
  for (const postCount of [undefined, -1, 2.5, "100", Infinity]) {
    globalThis.__acceptedApiResponse = () => ({ post_count: postCount });
    try {
      await assert.rejects(fetchCreatorPosts("https://kemono.cr", "patreon", "creator"), /Invalid creator profile post count/);
    } finally {
      globalThis.__acceptedApiResponse = null;
    }
  }
});

test("CoomerFans creator fetch reports failure when every listing route is unavailable", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 503, statusText: "Unavailable" }));
  globalThis.__acceptedTabMessages = [];
  const requestId = `coomer-list-failure:${crypto.randomUUID()}`;
  try {
    createDownloadHandlers()["creator.fetch"]({
      message: { service: "fansly", userId: "creator", origin: "https://coomerfans.com", requestId },
      sender: { url: "chrome-extension://test-extension/popup/popup.html" },
      sendResponse() {},
    });
    // The supported listing alternatives each retain their bounded retry delay.
    await new Promise((resolve) => setTimeout(resolve, 1250));
    const terminal = await waitForBatchCompletion(requestId);
    assert.equal(terminal.result.success, false);
    assert.match(terminal.result.error, /Failed to fetch CoomerFans creator page 1:.*503/);
  } finally {
    globalThis.__acceptedTabMessages = null;
  }
});

test("batch completion waits for links TXT dispatch and reports its failure", async (t) => {
  t.mock.method(console, "error", () => {});
  globalThis.__acceptedTabMessages = [];
  globalThis.__acceptedExternalLinks = ["https://example.com/item"];
  let releaseDispatch;
  let dispatchStarted = false;
  const dispatch = new Promise((resolve) => { releaseDispatch = resolve; });
  globalThis.__acceptedLinkDispatch = () => { dispatchStarted = true; return dispatch; };
  const requestId = `txt-failure:${crypto.randomUUID()}`;
  try {
    createDownloadHandlers().startDownloadBatch({
      message: {
        items: [{ service: "patreon", userId: "creator", postId: "one" }],
        aggregateExternalLinks: true,
        requestId,
      },
      sender: { url: "https://kemono.cr/patreon/user/creator", tab: { id: 32 } },
      sendResponse() {},
    });
    for (let attempt = 0; attempt < 200 && !dispatchStarted; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(dispatchStarted, true);
    assert.equal(globalThis.__acceptedTabMessages.some((message) => message.batch && message.action === "downloadComplete"), false);
    releaseDispatch({ success: false, error: "Download blocked" });
    const terminal = await waitForBatchCompletion(requestId);
    assert.equal(terminal.result.success, false);
    assert.match(terminal.result.error, /Download blocked/);
  } finally {
    releaseDispatch({ success: true });
    globalThis.__acceptedLinkDispatch = null;
    globalThis.__acceptedExternalLinks = null;
    globalThis.__acceptedTabMessages = null;
  }
});

test("Pawchive Links only mode includes links from incomplete posts without media dispatch", async () => {
  globalThis.__acceptedTabMessages = [];
  globalThis.__acceptedCreatorMode = "links";
  globalThis.__acceptedPawPosts = [{ id: "partial", has_full: false, content: "https://example.com/project.zip" }];
  globalThis.__acceptedDispatchedLinkCount = 0;
  const starts = globalThis.__acceptedStartCalls;
  const requestId = `incomplete-links:${crypto.randomUUID()}`;
  try {
    createDownloadHandlers()["creator.fetch"]({
      message: { service: "patreon", userId: "creator", origin: "https://pawchive.pw", mode: "links", requestId },
      sender: { url: "chrome-extension://test-extension/popup/popup.html" },
      sendResponse() {},
    });
    const terminal = await waitForBatchCompletion(requestId);
    assert.equal(terminal.result.success, true);
    assert.equal(terminal.result.totalCount, 1);
    assert.equal(globalThis.__acceptedDispatchedLinkCount, 1);
    assert.equal(globalThis.__acceptedStartCalls, starts);
  } finally {
    globalThis.__acceptedCreatorMode = null;
    globalThis.__acceptedPawPosts = null;
    globalThis.__acceptedTabMessages = null;
  }
});

test("partially successful post batches expose post-level terminal failure counts", async () => {
  globalThis.__acceptedTabMessages = [];
  globalThis.__acceptedFallbackFactory = (postId) => postId === "complete"
    ? { success: true, noFiles: true, results: [] }
    : { success: true, results: [{ success: true }, { success: false }] };
  const requestId = `partial-batch:${crypto.randomUUID()}`;
  try {
    createDownloadHandlers().startDownloadBatch({
      message: {
        items: ["complete", "partial"].map((postId) => ({ service: "patreon", userId: "creator", postId })),
        requestId,
      },
      sender: { url: "https://kemono.cr/patreon/user/creator", tab: { id: 33 } },
      sendResponse() {},
    });
    assert.deepEqual((await waitForBatchCompletion(requestId)).result, {
      success: false, totalCount: 2, successCount: 1, failedCount: 1,
    });
  } finally {
    globalThis.__acceptedFallbackFactory = null;
    globalThis.__acceptedTabMessages = null;
  }
});

test("Pawchive DM exports emit a correlated terminal success", async () => {
  globalThis.__acceptedTabMessages = [];
  globalThis.__acceptedCreatorMode = "dms";
  const requestId = `dm-completion:${crypto.randomUUID()}`;
  try {
    createDownloadHandlers()["creator.fetch"]({
      message: { service: "patreon", userId: "creator", origin: "https://pawchive.pw", mode: "dms", requestId },
      sender: { url: "chrome-extension://test-extension/popup/popup.html" },
      sendResponse() {},
    });
    assert.deepEqual((await waitForBatchCompletion(requestId)).result, {
      success: true, totalCount: 1, successCount: 1, failedCount: 0,
    });
  } finally {
    globalThis.__acceptedCreatorMode = null;
    globalThis.__acceptedTabMessages = null;
  }
});

test("single-post completion reports history persistence failures and preserves links", async (t) => {
  t.mock.method(console, "warn", () => {});
  globalThis.__acceptedTabMessages = [];
  globalThis.__acceptedHistoryError = "IndexedDB unavailable";
  globalThis.__acceptedExternalLinks = ["https://example.com/project.zip"];
  const requestId = `history-failure:${crypto.randomUUID()}`;
  try {
    createDownloadHandlers().startDownload({
      message: { service: "patreon", userId: "creator", postId: "one", requestId },
      sender: { url: "https://kemono.cr/patreon/user/creator/post/one", tab: { id: 34 } },
      sendResponse() {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const terminal = globalThis.__acceptedTabMessages.find(
      (message) => message.action === "downloadComplete" && message.requestId === requestId
    );
    assert.equal(terminal.result.success, false);
    assert.match(terminal.result.error, /saving download history failed/);
    assert.deepEqual(terminal.result.externalLinks, ["https://example.com/project.zip"]);
  } finally {
    globalThis.__acceptedHistoryError = null;
    globalThis.__acceptedExternalLinks = null;
    globalThis.__acceptedTabMessages = null;
  }
});
