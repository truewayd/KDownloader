import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n?/g, "\n");

const [
  helpersSource,
  downloadSource,
  uiSource,
  pawActionsSource,
  injectedSource,
  flagSource,
  popupSource,
  dbHandlersSource,
] = await Promise.all([
  read("content/helpers.js"),
  read("content/download.js"),
  read("content/ui.js"),
  read("content/paw_actions.js"),
  read("injected/creators_page.js"),
  read("content/flag/index.js"),
  read("popup/popup.js"),
  read("background/handlers/dbHandlers.js"),
]);

test("Pawchive UI shares the default history source while preserving history-state rendering", () => {
  assert.match(pawActionsSource, /renderPostDownloadButton\(context, \{ container, parsed \}\)/);
  assert.match(pawActionsSource, /entries\.push\(\{ article, anchor, path, \.\.\.parsed \}\)/);
  assert.doesNotMatch(pawActionsSource, /source:\s*["']pawchive["']/);
  assert.match(uiSource, /PARTIAL:[^\n]+icon: '!'/);
  assert.match(uiSource, /isHandledDownloadedStatus\(historyStatus\)/);
  assert.match(downloadSource, /function isPartialDownloadResult\(result\)/);
  assert.match(dbHandlersSource, /statuses,/);
});

test("creator history buttons distinguish complete, empty, and partial records", () => {
  const context = vm.createContext({
    document: {},
    findDownloadButtonByPath() {},
    handleDownload() {},
    isActiveDownloadButton() { return false; },
    isHandledDownloadedStatus: (status) => status === "complete" || status === "empty",
    isRenderCurrent() { return true; },
    KDComponents: {
      ACTION_TAG: "kd-ui-action",
      setBusyState(target, busy, { manageDisabled = true } = {}) {
        if (busy) target.setAttribute("aria-busy", "true");
        else target.removeAttribute?.("aria-busy");
        if (manageDisabled) target.disabled = busy;
      },
    },
    KDI18n: { get: (key) => key },
  });
  vm.runInContext(uiSource, context);
  context.button = {
    dataset: {},
    disabled: false,
    setAttribute(name, value) { this[name] = value; },
  };

  vm.runInContext("configureCreatorDownloadButton(button, 'complete', () => {})", context);
  assert.equal(context.button.dataset.status, "SUCCESS");
  assert.equal(context.button.textContent, "✓");
  assert.equal(context.button.disabled, true);

  vm.runInContext("configureCreatorDownloadButton(button, 'empty', () => {})", context);
  assert.equal(context.button.dataset.status, "SUCCESS");
  assert.equal(context.button.disabled, true);

  vm.runInContext("configureCreatorDownloadButton(button, 'partial', () => {})", context);
  assert.equal(context.button.dataset.status, "PARTIAL");
  assert.equal(context.button.textContent, "!");
  assert.equal(context.button.disabled, false);
  assert.equal(typeof context.button.onclick, "function");
});

test("frontend and background use collision-free downloaded identity keys", async () => {
  const context = vm.createContext({
    chrome: { runtime: { id: "test-extension" } },
    clearTimeout,
    Event,
    location: {
      href: "https://kemono.cr/patreon/user/42",
      origin: "https://kemono.cr",
      pathname: "/patreon/user/42",
    },
    Map,
    setTimeout,
    URL,
    window: new EventTarget(),
  });
  vm.runInContext(helpersSource, context);
  const db = await import("../background/db.js");

  const frontendKey = vm.runInContext(
    "downloadedKey('service:part', 'user', 'post', 'coomerfans')",
    context
  );
  assert.equal(frontendKey, db.downloadedItemKey("service:part", "user", "post", "coomerfans"));
  assert.notEqual(
    vm.runInContext("downloadedKey('a:b', 'c', 'd')", context),
    vm.runInContext("downloadedKey('a', 'b:c', 'd')", context)
  );
  assert.match(flagSource, /key:\s*JSON\.stringify\(\[String\(service\), String\(userId\)\]\)/);
});

test("download completion dispatched before the ack is not lost", async () => {
  let runtimeListener = null;
  const window = new EventTarget();
  const button = {
    dataset: {},
    disabled: false,
    isConnected: true,
    setAttribute(name, value) { this[name] = value; },
  };
  const context = vm.createContext({
    button,
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) { runtimeListener = listener; },
        },
      },
    },
    clearTimeout,
    console,
    crypto: { randomUUID: () => "race-test" },
    EXTENSION_CONTEXT_INVALIDATED_EVENT: "kd:extensioncontextinvalidated",
    getErrorMessage: (error) => error?.message || String(error || ""),
    KDI18n: { get: (key) => key },
    Map,
    safeSendMessage: async (message) => {
      runtimeListener({
        action: "downloadComplete",
        requestId: message.requestId,
        service: message.service,
        userId: message.userId,
        postId: message.postId,
        result: { success: true, backend: true },
      });
      return { accepted: true };
    },
    setTimeout,
    showExternalLinksModal() {},
    showTransientButtonStatus(target, status) {
      target.dataset.status = status;
      target.disabled = false;
    },
    updateButtonStatus(target, status) {
      target.dataset.status = status;
      target.disabled = status === "SCANNING" || status === "SENDING";
    },
    window,
  });
  vm.runInContext(downloadSource, context);

  await vm.runInContext(
    "handleDownload(button, 'patreon', '42', '99', '/patreon/user/42/post/99')",
    context
  );

  assert.equal(button.dataset.status, "SUCCESS");
  assert.equal(vm.runInContext("activeDownloadRequests.size", context), 0);

  vm.runInContext(`renderDownloadResult(button, {
    success: true,
    backend: true,
    successCount: 1,
    results: [{ success: true }, { success: false }]
  }, true)`, context);
  assert.equal(button.dataset.status, "PARTIAL");
  assert.equal(button.disabled, false);
});

function createInjectedHarness(options = {}) {
  let networkCalls = 0;
  class TestProgressEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.loaded = Number(init.loaded) || 0;
      this.total = Number(init.total) || 0;
    }
  }
  const window = new EventTarget();
  window.postMessage = () => {};
  window.fetch = async (input, init) => {
    networkCalls += 1;
    return { input, init, network: true };
  };
  window.XMLHttpRequest = options.XMLHttpRequest;
  const context = vm.createContext({
    clearInterval() {},
    console,
    Event,
    indexedDB: { open() { throw new Error("unexpected IndexedDB open"); } },
    location: {
      href: "https://kemono.cr/artists",
      hostname: "kemono.cr",
      origin: "https://kemono.cr",
    },
    Map,
    Object,
    Promise,
    ProgressEvent: TestProgressEvent,
    Request,
    Response,
    setInterval: () => 0,
    URL,
    window,
  });
  const testableSource = injectedSource.replace(
    "  const XHR = window.XMLHttpRequest;",
    `
    globalThis.__injectedTest = {
      setOverride(value) { overrideEnabled = value; },
      setReadCache(value) { readCache = value; },
      setOpenDB(value) { openDB = value; },
      getOverride() { return overrideEnabled; },
      creatorRequestUrl,
      transactionRequest,
    };
    const XHR = window.XMLHttpRequest;`
  );
  vm.runInContext(testableSource, context);
  return { context, get networkCalls() { return networkCalls; }, window };
}

test("creator cache interception applies only to GET fetches", async () => {
  const harness = createInjectedHarness();
  harness.context.__injectedTest.setOverride(true);
  harness.context.__injectedTest.setReadCache(() => Promise.resolve({ data: { cached: true } }));
  assert.equal(harness.context.__injectedTest.getOverride(), true);
  assert.ok(harness.context.__injectedTest.creatorRequestUrl("https://kemono.cr/api/v1/creators"));

  const post = await harness.window.fetch("https://kemono.cr/api/v1/creators", { method: "POST" });
  assert.equal(post.network, true);
  assert.equal(harness.networkCalls, 1);

  const getWithBody = await harness.window.fetch("https://kemono.cr/api/v1/creators", {
    method: "GET",
    body: "must remain native",
  });
  assert.equal(getWithBody.network, true);
  assert.equal(harness.networkCalls, 2);

  const get = await harness.window.fetch("https://kemono.cr/api/v1/creators", { method: "GET" });
  assert.deepEqual(await get.json(), { cached: true });
  assert.equal(harness.networkCalls, 2);
});

test("creator cache XHR interception preserves sync and GET-body native semantics", async () => {
  let nativeSends = 0;
  let cacheReads = 0;
  class FakeXHR extends EventTarget {
    responseType = "";
    open() {}
    send(body) {
      nativeSends++;
      this.nativeBody = body;
      return "native-result";
    }
    abort() {}
  }
  const harness = createInjectedHarness({ XMLHttpRequest: FakeXHR });
  harness.context.__injectedTest.setOverride(true);
  harness.context.__injectedTest.setReadCache(() => {
    cacheReads++;
    return Promise.resolve({ data: { cached: true } });
  });

  const sync = new harness.window.XMLHttpRequest();
  sync.open("GET", "https://kemono.cr/api/v1/creators", false);
  assert.equal(sync.send(), "native-result");
  assert.equal(nativeSends, 1);
  assert.equal(cacheReads, 0);

  const withBody = new harness.window.XMLHttpRequest();
  withBody.open("GET", "https://kemono.cr/api/v1/creators");
  assert.equal(withBody.send("must remain native"), "native-result");
  assert.equal(nativeSends, 2);
  assert.equal(cacheReads, 0);

  const async = new harness.window.XMLHttpRequest();
  async.open("GET", "https://kemono.cr/api/v1/creators");
  async.send();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(async.status, 200);
  assert.deepEqual(JSON.parse(async.responseText), { cached: true });
  assert.equal(nativeSends, 2);
  assert.equal(cacheReads, 1);
});

test("creator cache fetch preserves cancellation while awaiting IndexedDB", async () => {
  const harness = createInjectedHarness();
  let resolveCache;
  harness.context.__injectedTest.setOverride(true);
  harness.context.__injectedTest.setReadCache(() => new Promise((resolve) => {
    resolveCache = resolve;
  }));
  const controller = new AbortController();

  const pending = harness.window.fetch("https://kemono.cr/api/v1/creators", {
    method: "GET",
    signal: controller.signal,
  });
  controller.abort();
  resolveCache({ data: { cached: true } });

  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(harness.networkCalls, 0);
});

test("disabling the creator override while a cache read is pending restores native requests", async () => {
  let resolveFetchCache;
  const fetchHarness = createInjectedHarness();
  fetchHarness.context.__injectedTest.setOverride(true);
  fetchHarness.context.__injectedTest.setReadCache(() => new Promise((resolve) => {
    resolveFetchCache = resolve;
  }));
  const pendingFetch = fetchHarness.window.fetch("https://kemono.cr/api/v1/creators");
  fetchHarness.context.__injectedTest.setOverride(false);
  resolveFetchCache({ data: { stale: true } });
  assert.equal((await pendingFetch).network, true);
  assert.equal(fetchHarness.networkCalls, 1);

  let nativeSends = 0;
  let resolveXHRCache;
  class FakeXHR extends EventTarget {
    responseType = "";
    open() {}
    send() { nativeSends += 1; }
    abort() {}
  }
  const xhrHarness = createInjectedHarness({ XMLHttpRequest: FakeXHR });
  xhrHarness.context.__injectedTest.setOverride(true);
  xhrHarness.context.__injectedTest.setReadCache(() => new Promise((resolve) => {
    resolveXHRCache = resolve;
  }));
  const pendingXHR = new xhrHarness.window.XMLHttpRequest();
  pendingXHR.open("GET", "https://kemono.cr/api/v1/creators");
  pendingXHR.send();
  xhrHarness.context.__injectedTest.setOverride(false);
  resolveXHRCache({ data: { stale: true } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nativeSends, 1);
});

test("pagehide invalidates queued creator-cache writes before they can reopen IndexedDB", async () => {
  const harness = createInjectedHarness();
  let opens = 0;
  harness.context.__injectedTest.setOpenDB(() => {
    opens += 1;
    return Promise.reject(new Error("unexpected reopen"));
  });
  const messageEvent = new Event("message");
  Object.defineProperties(messageEvent, {
    source: { value: harness.window },
    origin: { value: "https://kemono.cr" },
    data: {
      value: {
        direction: "EXT_TO_PAGE",
        message: {
          action: "creators.state",
          host: "kemono.cr",
          enabled: true,
          payload: { data: { cached: true } },
        },
      },
    },
  });
  harness.window.dispatchEvent(messageEvent);
  harness.window.dispatchEvent(new Event("pagehide"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(opens, 0);
});

test("creator cache writes resolve only after their IndexedDB transaction commits", async () => {
  const harness = createInjectedHarness();
  const request = {};
  const transaction = {
    error: null,
    objectStore() {
      return { put() { return request; } };
    },
  };
  harness.context.fakeDB = {
    transaction() { return transaction; },
  };
  harness.context.__injectedTest.setOpenDB(() => Promise.resolve(harness.context.fakeDB));

  const pending = harness.context.__injectedTest.transactionRequest(
    "readwrite",
    (store) => store.put({ host: "kemono.cr" })
  );
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  request.result = "stored";
  request.onsuccess();
  await Promise.resolve();
  assert.equal(settled, false);

  transaction.oncomplete();
  assert.equal(await pending, "stored");
});

test("popup history export enforces the final UTF-8 file limit before Blob creation", () => {
  const helper = popupSource.match(/function appendHistoryExportPart\(parts, state, text[^)]*\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "appendHistoryExportPart should remain independently testable");
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(`
    const MAX_HISTORY_FILE_BYTES = 64;
    const exportTextEncoder = new TextEncoder();
    ${helper}
    globalThis.appendHistoryExportPart = appendHistoryExportPart;
  `, context);

  const parts = [];
  const state = { bytes: 0 };
  context.appendHistoryExportPart(parts, state, "p".repeat(30));
  context.appendHistoryExportPart(parts, state, "界".repeat(10));
  context.appendHistoryExportPart(parts, state, "]}");
  context.appendHistoryExportPart(parts, state, "ok");
  assert.equal(state.bytes, 64);
  assert.throws(
    () => context.appendHistoryExportPart(parts, state, "x"),
    /64 MiB file safety limit/
  );
  assert.equal(parts.length, 4, "the rejected part must not be retained");
  assert.throws(
    () => context.appendHistoryExportPart([], { bytes: 62 }, "x", 2),
    /64 MiB file safety limit/,
    "the closing suffix must be reserved before retaining a page"
  );

  const exportFunction = popupSource.match(/async function exportData\(\) \{[\s\S]*?\n\}\n\nasync function importData/)?.[0];
  assert.ok(exportFunction);
  assert.match(popupSource, /const MAX_HISTORY_FILE_BYTES = 64 \* 1024 \* 1024/);
  assert.equal((exportFunction.match(/appendHistoryExportPart\(/g) || []).length, 3);
  assert.match(exportFunction, /pageParts\.join\(","\)/);
  assert.match(exportFunction, /revision:\s*envelope\.revision/);
  assert.match(dbHandlersSource, /message\.generation,[\s\S]*message\.revision/);
  assert.ok(
    exportFunction.indexOf("appendHistoryExportPart(parts, exportSize, suffix")
      < exportFunction.indexOf("new Blob(parts"),
    "the suffix must be counted before Blob construction"
  );
});
