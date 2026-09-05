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
  trueDownSource,
  settingsSource,
] = await Promise.all([
  read("content/helpers.js"),
  read("content/download.js"),
  read("content/ui.js"),
  read("content/paw_actions.js"),
  read("injected/creators_page.js"),
  read("content/flag/index.js"),
  read("popup/popup.js"),
  read("background/handlers/dbHandlers.js"),
  read("truedown/web/app.js"),
  read("settings.js"),
]);

function declaration(source, name) {
  const found = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(found, `${name} is available for behavior tests`);
  return found[0];
}

function testButton() {
  return {
    dataset: {},
    disabled: false,
    isConnected: true,
    setAttribute(name, value) { this[name] = String(value); },
    getAttribute(name) { return this[name] ?? null; },
    removeAttribute(name) { delete this[name]; },
  };
}

function createDownloadHarness() {
  let listener;
  let request;
  const button = testButton();
  const context = vm.createContext({
    button,
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } },
    console: { error() {}, warn() {} },
    EXTENSION_CONTEXT_INVALIDATED_EVENT: "kd:extensioncontextinvalidated",
    getErrorMessage: (error) => error?.message || String(error),
    KDI18n: { get: (key) => key },
    Map,
    safeSendMessage: async (message) => { request = message; return { accepted: true }; },
    setTimeout,
    clearTimeout,
    showExternalLinksModal() {},
    showTransientButtonStatus(target, status, label) {
      target.dataset.status = status;
      target.textContent = label;
      target.disabled = false;
    },
    updateButtonStatus(target, status, label) {
      target.dataset.status = status;
      target.textContent = label;
      target.disabled = status === "SENDING" || status === "SCANNING";
    },
    window: new EventTarget(),
  });
  vm.runInContext(downloadSource, context);
  return {
    context,
    button,
    emit(message) { listener({ requestId: request.requestId, service: "patreon", userId: "42", ...message }); },
    close() { vm.runInContext("clearActiveDownloadRequests()", context); },
  };
}

test("page fetch ignores per-post progress and waits for the final batch result", async () => {
  const harness = createDownloadHarness();
  try {
    await vm.runInContext(`runPageFetchWithProgress({
      btn: button, service: 'patreon', userId: '42', total: 1,
      requestMessage: { action: 'creator.pageFetch' },
    })`, harness.context);
    harness.emit({ action: "downloadProgress", postId: "p1", progress: 50 });
    assert.equal(harness.button.dataset.status, "SENDING");
    harness.emit({ action: "downloadComplete", postId: "p1", result: { success: true } });
    assert.equal(harness.button.dataset.status, "SENDING", "TXT export and history writes may still fail");
    harness.emit({ action: "downloadComplete", batch: true, result: {
      success: false, error: "TXT export failed", totalCount: 1, successCount: 1,
    } });
    assert.equal(harness.button.dataset.status, "ERROR");
    assert.equal(harness.button.disabled, false);
    assert.equal(vm.runInContext("activeDownloadRequests.size", harness.context), 0);
  } finally { harness.close(); }
});

test("page fetch keeps partially successful batches retryable", async () => {
  const harness = createDownloadHarness();
  try {
    await vm.runInContext(`runPageFetchWithProgress({
      btn: button, service: 'patreon', userId: '42', total: 2,
      requestMessage: { action: 'creator.pageFetch' },
    })`, harness.context);
    harness.emit({ action: "downloadComplete", batch: true, result: {
      success: false, totalCount: 2, successCount: 1, failedCount: 1,
    } });
    assert.equal(harness.button.dataset.status, "PARTIAL");
    assert.equal(harness.button.disabled, false);
  } finally { harness.close(); }
});

test("creator cards remain retryable after a no-files response", () => {
  const harness = createDownloadHarness();
  vm.runInContext("renderDownloadResult(button, { success: true, noFiles: true }, true)", harness.context);
  assert.equal(harness.button.dataset.status, "SUCCESS");
  assert.equal(harness.button.disabled, false);
});

test("pagehide releases download controls and a late acknowledgement cannot lock a restored page", async () => {
  for (const batch of [false, true]) {
    const harness = createDownloadHarness();
    let acknowledge;
    harness.context.safeSendMessage = () => new Promise((resolve) => { acknowledge = resolve; });
    try {
      const pending = vm.runInContext(batch
        ? `runPageFetchWithProgress({ btn: button, service: 'patreon', userId: '42', requestMessage: { action: 'creator.pageFetch' } })`
        : `handleDownload(button, 'patreon', '42', '99', '/patreon/user/42/post/99')`, harness.context);
      harness.context.window.dispatchEvent(new Event("pagehide"));
      assert.equal(harness.button.disabled, false);
      assert.equal(harness.button.dataset.status, "IDLE");
      assert.equal(vm.runInContext("activeDownloadRequests.size", harness.context), 0);
      acknowledge({ accepted: true });
      await pending;
      assert.equal(harness.button.dataset.status, "IDLE");
    } finally { harness.close(); }
  }
});

test("pending post history reads cannot replace a newer download state", async () => {
  for (const status of ["SENDING", "PARTIAL", "SUCCESS"]) {
    let resolveHistory;
    const button = testButton();
    button.dataset.path = "/patreon/user/42/post/99";
    const context = vm.createContext({
      button,
      container: { querySelector: () => button },
      getPostDownloadedStatus: () => new Promise((resolve) => { resolveHistory = resolve; }),
      isActiveDownloadButton: (target) => target.dataset.status === "SENDING",
      isRenderCurrent: () => true,
      KDI18n: { get: (key) => key },
      KDComponents: { ACTION_TAG: "kd-ui-action", setBusyState() {} },
      location: { pathname: button.dataset.path },
    });
    vm.runInContext(uiSource, context);
    vm.runInContext("ensureKdButton = () => ({ button, isNew: false })", context);
    const pending = vm.runInContext(`renderPostDownloadButton(null, {
      container, parsed: { service: 'patreon', userId: '42', postId: '99' },
    })`, context);
    vm.runInContext(`updateButtonStatus(button, '${status}')`, context);
    resolveHistory("complete");
    await pending;
    assert.equal(button.dataset.status, status);
    assert.equal(button.disabled, status === "SENDING");
  }
});

test("pending creator history reads preserve a download completed during the lookup", async () => {
  let resolveHistory;
  const button = testButton();
  const context = vm.createContext({
    button,
    entries: [{ article: {}, path: '/patreon/user/42/post/99', service: 'patreon', userId: '42', postId: '99' }],
    findDownloadButtonByPath: () => button,
    getDownloadedStatusMap: () => new Promise((resolve) => { resolveHistory = resolve; }),
    downloadedKey: () => 'key',
    isActiveDownloadButton: () => false,
    isRenderCurrent: () => true,
    KDI18n: { get: (key) => key },
    KDComponents: { ACTION_TAG: 'kd-ui-action', setBusyState() {} },
  });
  vm.runInContext(uiSource, context);
  vm.runInContext("ensureCreatorDownloadButton = () => button; updateButtonStatus(button, 'IDLE')", context);
  const pending = vm.runInContext("renderCreatorDownloadButtons(entries)", context);
  vm.runInContext("updateButtonStatus(button, 'PARTIAL')", context);
  resolveHistory(new Map());
  await pending;
  assert.equal(button.dataset.status, 'PARTIAL');
});

test("pending favorites reads cannot revert a completed flag toggle", async () => {
  let resolveFlags;
  const button = testButton();
  button.dataset.kdFlagVersion = 'initial';
  button.dataset.flag = 'false';
  const card = {
    isConnected: true,
    querySelector: () => button,
    getAttribute: (name) => name === 'data-service' ? 'patreon' : '42',
  };
  const context = vm.createContext({
    button,
    console,
    document: { querySelectorAll: () => [card] },
    isRenderCurrent: () => true,
    KDI18n: { get: (key) => key },
    KDComponents: { ACTION_TAG: 'kd-ui-action', setBusyState: (target, busy) => { target.disabled = busy; } },
    safeSendMessage: (message) => message.action === 'flag.getMany'
      ? new Promise((resolve) => { resolveFlags = resolve; })
      : Promise.resolve({ flag: message.value }),
    window: { location: { pathname: '/patreon/account/favorites/artists' }, KDRouteWatcher: { register() {} } },
  });
  vm.runInContext(flagSource.replace('  function isFavoritesArtistsPage()', `
    globalThis.testFlags = { processCreatorCards, handleFlagClick };
    function isFavoritesArtistsPage()`), context);
  const pending = context.testFlags.processCreatorCards();
  await context.testFlags.handleFlagClick({ preventDefault() {}, stopPropagation() {} }, 'patreon', '42', button);
  resolveFlags({ flags: { '["patreon","42"]': false } });
  await pending;
  assert.equal(button.dataset.flag, 'true');
  assert.equal(button.disabled, false);
});

test("large creator and post lists keep history RPCs bounded while merging every returned identity", async () => {
  const batches = [];
  const context = vm.createContext({
    console,
    window: { KDRouteWatcher: { register() {} } },
    KDComponents: { ACTION_TAG: "kd-ui-action" },
    safeSendMessage: async (message) => {
      batches.push(message.items.length);
      const pairs = message.items.map((item) => [message.action === "flag.getMany"
        ? JSON.stringify([item.service, item.userId])
        : JSON.stringify(["default", item.service, item.userId, item.postId]), true]);
      return message.action === "flag.getMany" ? { flags: Object.fromEntries(pairs) } : { downloaded: Object.fromEntries(pairs) };
    },
  });
  vm.runInContext(flagSource.replace("  function isFavoritesArtistsPage()", `
    globalThis.getFlagFixture = getCreatorFlagsMany;
    function isFavoritesArtistsPage()`), context);
  vm.runInContext(["getDownloadedStatusMap", "downloadedKey"].map((name) => declaration(helpersSource, name)).join("\n"), context);
  const items = Array.from({ length: 1001 }, (_, index) => ({ service: "patreon", userId: String(index), postId: "post" }));
  const flags = await context.getFlagFixture(items);
  const statuses = await context.getDownloadedStatusMap(items);
  assert.deepEqual(batches, [500, 500, 1, 500, 500, 1]);
  assert.equal(Object.keys(flags).length, 1001);
  assert.equal(statuses.size, 1001);
  assert.equal(statuses.get('["default","patreon","1000","post"]'), "complete");
});

test("history-change notifications include Pawchive and consume absent content receiver errors", () => {
  let patterns;
  let notifications = 0;
  let consumedErrors = 0;
  const context = vm.createContext({
    chrome: {
      runtime: { get lastError() { consumedErrors++; return null; } },
      tabs: {
        query(options, callback) { patterns = options.url; callback([{ id: 1 }]); },
        sendMessage(id, message, callback) { assert.equal(id, 1); assert.equal(message.action, "updateUI"); notifications++; callback(); },
      },
    },
  });
  vm.runInContext(declaration(popupSource, "notifyContentUpdate"), context);
  context.notifyContentUpdate();
  assert.ok(patterns.includes("https://pawchive.pw/*"));
  assert.equal(notifications, 1);
  assert.equal(consumedErrors, 2);
});

function createTaskPageHarness(fetchPage) {
  const rendered = [];
  const context = vm.createContext({
    apiFetch: fetchPage,
    console: { error() {} },
    URLSearchParams,
    renderTasks: (tasks) => rendered.push(tasks),
    updateMetrics() {},
    updatePagination() {},
    showToast() {},
  });
  vm.runInContext(`
    const PAGE_SIZE = 100;
    const MAX_PAGE_ETAGS = 128;
    const pageETags = new Map();
    let currentOffset = 0, currentTotal = 0;
    let currentFilter = 'all', currentSearch = '', currentSort = 'status', currentSortOrder = 'asc';
    let currentSummary = {}, loadTasksPromise = null, taskRefreshRequested = false, renderedTaskPageURL = '';
    ${["loadTasks", "taskPageURL", "rememberPageETag", "normalizeSummary", "emptySummary", "safeCount"].map((name) => declaration(trueDownSource, name)).join("\n")}
  `, context);
  return { context, rendered };
}

function taskPage(id, total = 300) {
  return {
    status: 200,
    ok: true,
    headers: new Headers({ ETag: `"page-${id}"` }),
    json: async () => ({ tasks: [{ id }], total, summary: { total } }),
  };
}

test("TrueDown fetches a body when navigating back to a page whose validator was cached", async () => {
  const calls = [];
  const harness = createTaskPageHarness(async (url, options) => {
    calls.push({ url, headers: options.headers });
    if (options.headers["If-None-Match"]) return { status: 304 };
    return taskPage(Number(new URLSearchParams(url.split("?")[1]).get("offset")) + 1);
  });
  await vm.runInContext("loadTasks()", harness.context);
  await vm.runInContext("currentOffset = 100; loadTasks()", harness.context);
  await vm.runInContext("currentOffset = 0; loadTasks()", harness.context);
  assert.deepEqual(harness.rendered.map((tasks) => tasks[0].id), [1, 101, 1]);
  assert.equal(calls[2].headers["If-None-Match"], undefined);
  await vm.runInContext("loadTasks()", harness.context);
  assert.equal(calls[3].headers["If-None-Match"], '"page-1"', "unchanged visible pages retain conditional polling");
});

test("TrueDown discards in-flight pages after search changes and coalesces refreshes", async () => {
  let resolveFirst;
  const calls = [];
  const harness = createTaskPageHarness(async (url) => {
    calls.push(url);
    if (calls.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return taskPage(99);
  });
  const first = vm.runInContext("loadTasks()", harness.context);
  const subsequent = vm.runInContext(`currentSearch = 'new'; Promise.all([
    loadTasks({ force: true }), loadTasks({ force: true }), loadTasks(),
  ])`, harness.context);
  resolveFirst(taskPage(1));
  await Promise.all([first, subsequent]);
  assert.deepEqual(harness.rendered.map((tasks) => tasks[0].id), [99]);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /search=new/);
});

test("TrueDown polling preserves pending queue and retry controls", () => {
  const els = Object.fromEntries([
    "taskCount", "activeCount", "errorCount", "retryAllBtn", "clearDoneBtn", "pauseQueueBtn", "resumeQueueBtn",
  ].map((name) => [name, testButton()]));
  for (const name of ["retryAllBtn", "pauseQueueBtn", "resumeQueueBtn"]) els[name].setAttribute("aria-busy", "true");
  const context = vm.createContext({ els });
  vm.runInContext(declaration(trueDownSource, "updateMetrics"), context);
  vm.runInContext("updateMetrics({ total: 4, queued: 1, downloading: 1, paused: 1, error: 1, done: 1 })", context);
  for (const name of ["retryAllBtn", "pauseQueueBtn", "resumeQueueBtn"]) assert.equal(els[name].disabled, true);
});

test("settings operations freeze edits and exclude overlapping save or restore calls", async () => {
  let release;
  let writes = 0;
  let focused = 0;
  const sections = [{ inert: false }, { inert: false }];
  const context = vm.createContext({
    document: {
      activeElement: { isConnected: true, focus() { focused += 1; } },
      querySelectorAll: () => sections,
    },
    KDUI: { withBusyButton: async (_button, task) => task() },
  });
  vm.runInContext(`let settingsOperationPending = false; ${declaration(settingsSource, 'withSettingsOperation')}`, context);
  const pending = context.withSettingsOperation(null, () => new Promise((resolve) => { release = resolve; }));
  assert.ok(sections.every((element) => element.inert));
  await context.withSettingsOperation(null, () => { writes += 1; });
  assert.equal(writes, 0);
  release();
  await pending;
  assert.ok(sections.every((element) => !element.inert));
  assert.equal(focused, 1);
  await context.withSettingsOperation(null, () => { writes += 1; });
  assert.equal(writes, 1);
});

test("settings display normalized values only after persistence succeeds", async () => {
  let finish;
  const controls = {
    'external-link-filter-mode': { value: 'blacklist' },
    'external-link-filter-blacklist': { value: 'EXAMPLE.com, example.com' },
  };
  const context = vm.createContext({
    $: (id) => controls[id],
    setValue: (id, value) => { controls[id].value = value; },
    updateExternalLinkFilterVisibility() {},
    sendMessage: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }),
  });
  vm.runInContext([
    declaration(settingsSource, 'saveExternalLinkFilter'),
    declaration(settingsSource, 'renderExternalLinkFilterConfig'),
  ].join('\n'), context);
  const pending = context.saveExternalLinkFilter();
  assert.equal(controls['external-link-filter-blacklist'].value, 'EXAMPLE.com, example.com');
  finish.resolve({ config: { mode: 'blacklist', blacklist: ['example.com'] } });
  await pending;
  assert.equal(controls['external-link-filter-blacklist'].value, 'example.com');

  controls['external-link-filter-blacklist'].value = 'unsaved.example';
  const rejected = context.saveExternalLinkFilter();
  finish.reject(new Error('storage write failed'));
  await assert.rejects(rejected, /storage write failed/);
  assert.equal(controls['external-link-filter-blacklist'].value, 'unsaved.example');
});

test("settings blank numeric controls use their defaults and preserve explicit zero", () => {
  const control = { value: '' };
  const context = vm.createContext({ $: () => control });
  vm.runInContext(declaration(settingsSource, 'numberValue'), context);
  assert.equal(context.numberValue('port', 15151, 1, 65535), 15151);
  control.value = '0';
  assert.equal(context.numberValue('retries', 3, 0, 10), 0);
  control.value = '12';
  assert.equal(context.numberValue('retries', 3, 0, 10), 10);
});

test("settings keep save success and failure visible after the busy state ends", async () => {
  let failure = null;
  const status = { textContent: '' };
  const context = vm.createContext({
    $: () => status,
    settingsLoaded: true,
    t: (key) => key,
    withBusyButton: (_button, task) => task(),
    saveBackend: async () => { if (failure) throw failure; },
    saveDownloadRules: async () => ({ sync: { state: 'success' } }),
    saveExternalLinkFilter: async () => {},
    saveWatch: async () => {},
    saveGist: async () => {},
    saveCreators: async () => {},
    showToast: (message) => { status.textContent = message; },
    console: { error() {} },
  });
  vm.runInContext(declaration(settingsSource, 'saveAll'), context);
  await context.saveAll();
  assert.equal(status.textContent, 'settingsSaved');
  failure = new Error('Storage unavailable');
  await context.saveAll();
  assert.equal(status.textContent, 'Storage unavailable');
});

test("Watch import waits for the shared confirmation and cancel preserves the current list", async () => {
  let answer;
  let reads = 0;
  let writes = 0;
  let reloaded = 0;
  const file = { size: 2, text: async () => { reads += 1; return '{}'; } };
  const context = vm.createContext({
    MAX_WATCH_IMPORT_FILE_BYTES: 1024,
    t: (key) => key,
    KDUI: { confirmAction: () => new Promise((resolve) => { answer = resolve; }) },
    sendMessage: async () => { writes += 1; },
    loadWatch: async () => { reloaded += 1; },
  });
  vm.runInContext(declaration(settingsSource, 'importWatchList'), context);
  const canceled = context.importWatchList(file);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  answer(false);
  assert.equal(await canceled, false);
  assert.equal(writes, 0);
  const confirmed = context.importWatchList(file);
  answer(true);
  assert.equal(await confirmed, true);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal(reloaded, 1);
});

test("TrueDown settings exclude duplicate submissions and wait for every write after failure", async () => {
  const controls = new Map();
  const saveButton = testButton();
  const els = new Proxy({}, { get(_target, key) {
    if (!controls.has(key)) controls.set(key, { value: '', checked: false, inert: false, querySelector: () => saveButton });
    return controls.get(key);
  } });
  const pendingWrites = [];
  const messages = [];
  const context = vm.createContext({
    els,
    document: { querySelectorAll: () => [] },
    MAX_SPEED_BPS: 2 ** 50,
    DEFAULT_DOWNLOAD_SETTINGS: { connections: 16, maxTries: 5, retryWait: 3 },
    DEFAULT_RUNTIME_SETTINGS: { concurrentDownloads: 3 },
    parseHeaders() {},
    optionalInt: () => 0,
    optionalIntAllowZero: (_name, fallback) => fallback,
    readTrackerResearchForm: () => ({ enabled: false }),
    downloadRules: { enabled: false },
    runtimeSettings: { concurrentDownloads: 3 },
    trackerResearchSettings: { enabled: false },
    normalizeServerDownloadRules: (value) => value,
    normalizeServerRuntimeSettings: (value) => value,
    normalizeTrackerResearchSettings: (value) => value,
    requestJSON: () => new Promise((resolve, reject) => pendingWrites.push({ resolve, reject })),
    showToast(message) { messages.push(message); },
    KDComponents: { setBusyState: (button, busy) => { button.disabled = busy; } },
  });
  vm.runInContext(declaration(trueDownSource, 'saveDownloadSettings'), context);
  const first = context.saveDownloadSettings({ preventDefault() {} });
  await context.saveDownloadSettings({ preventDefault() {} });
  assert.equal(pendingWrites.length, 3);
  assert.equal(els.settingsForm.inert, true);
  pendingWrites[0].reject(new Error('backend rejected setting'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(els.settingsForm.inert, true, 'another submission must not race remaining writes');
  pendingWrites[1].resolve({ concurrentDownloads: 8 });
  pendingWrites[2].resolve({ enabled: false, minimumLeechers: 7 });
  await first;
  assert.equal(els.settingsForm.inert, false);
  assert.equal(saveButton.disabled, false);
  assert.equal(context.runtimeSettings.concurrentDownloads, 8);
  assert.equal(context.trackerResearchSettings.minimumLeechers, 7);
  assert.equal(context.downloadRules.enabled, false);
  assert.match(messages.at(-1), /部分服务端设置已保存/);
});

test("Pawchive UI shares the default history source while preserving history-state rendering", () => {
  assert.match(pawActionsSource, /renderPostDownloadButton\(context, \{ container, parsed \}\)/);
  assert.match(pawActionsSource, /entries\.push\(\{ article, anchor, path, \.\.\.parsed \}\)/);
  assert.doesNotMatch(pawActionsSource, /source:\s*["']pawchive["']/);
  assert.match(uiSource, /PARTIAL:[^\n]+icon: '!'/);
  assert.match(uiSource, /const downloaded = historyStatus === 'complete'/);
  assert.match(downloadSource, /function isPartialDownloadResult\(result\)/);
  assert.match(dbHandlersSource, /statuses,/);
});

test("creator history buttons keep empty and partial posts manually retryable", () => {
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
  assert.equal(context.button.dataset.status, "IDLE");
  assert.equal(context.button.disabled, false);
  assert.equal(typeof context.button.onclick, "function");

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
  let shownLinks = [];
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
    showExternalLinksModal(links) { shownLinks = links; },
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

  vm.runInContext(`renderDownloadResult(button, {
    success: false,
    incomplete: true,
    externalLinks: ['https://mega.nz/folder/id#key']
  }, true)`, context);
  assert.deepEqual(Array.from(shownLinks), ['https://mega.nz/folder/id#key']);
  assert.equal(button.dataset.status, "SUCCESS");
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
