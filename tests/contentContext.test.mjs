import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const helpersSource = await readFile(new URL("../content/helpers.js", import.meta.url), "utf8");
const routerSource = await readFile(new URL("../content/router.js", import.meta.url), "utf8");

function createContext({ invalidationMode = "throw" } = {}) {
  const warnings = [];
  let sendCount = 0;
  let observerDisconnected = false;
  let observerCallback = null;
  const window = new EventTarget();
  const document = new EventTarget();
  document.readyState = "complete";
  document.hidden = false;
  document.documentElement = {};
  document.body = {};

  class TestMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }
    observe() { }
    disconnect() {
      observerDisconnected = true;
    }
  }

  const runtime = {
    id: "test-extension",
    lastError: null,
    sendMessage(message, callback) {
      sendCount += 1;
      if (invalidationMode === "silent") return;
      if (invalidationMode === "errorResponse") {
        callback({ success: false, error: "denied by background" });
        return;
      }
      if (invalidationMode === "emptyResponse") {
        callback();
        return;
      }
      if (invalidationMode === "callback") {
        runtime.lastError = { message: "Extension context invalidated." };
        callback();
        runtime.lastError = null;
        return;
      }
      throw new Error("Extension context invalidated.");
    },
  };

  const context = vm.createContext({
    chrome: {
      runtime,
    },
    console: {
      warn(...args) {
        warnings.push(args);
      },
    },
    document,
    Event,
    history: {
      pushState() { },
      replaceState() { },
    },
    location: {
      href: "https://pawchive.pw/patreon/user/2301678",
      pathname: "/patreon/user/2301678",
    },
    Map,
    MutationObserver: TestMutationObserver,
    Node: { ELEMENT_NODE: 1 },
    setTimeout,
    clearTimeout,
    URL,
    window,
  });

  return {
    context,
    get observerDisconnected() { return observerDisconnected; },
    get sendCount() { return sendCount; },
    emitMutations(mutations) { observerCallback?.(mutations); },
    warnings,
  };
}

test("invalidated extension context is terminal and emits one stop signal", async () => {
  const harness = createContext();
  let invalidatedEvents = 0;
  harness.context.window.addEventListener("kd:extensioncontextinvalidated", () => {
    invalidatedEvents += 1;
  });
  vm.runInContext(helpersSource, harness.context);

  await assert.rejects(
    vm.runInContext("safeSendMessage({ action: 'first' }, 10, { retries: 2, retryDelay: 0 })", harness.context),
    (error) => error.code === "EXTENSION_CONTEXT_INVALIDATED"
  );
  await assert.rejects(
    vm.runInContext("safeSendMessage({ action: 'second' }, 10, { retries: 2, retryDelay: 0 })", harness.context),
    (error) => error.code === "EXTENSION_CONTEXT_INVALIDATED"
  );

  assert.equal(harness.sendCount, 1);
  assert.equal(invalidatedEvents, 1);
});

test("runtime.lastError invalidation also bypasses retries", async () => {
  const harness = createContext({ invalidationMode: "callback" });
  vm.runInContext(helpersSource, harness.context);

  await assert.rejects(
    vm.runInContext("safeSendMessage({ action: 'callback' }, 10, { retries: 2, retryDelay: 0 })", harness.context),
    (error) => error.code === "EXTENSION_CONTEXT_INVALIDATED"
  );

  assert.equal(harness.sendCount, 1);
});

test("content messaging never retries an ambiguous timeout", async () => {
  const harness = createContext({ invalidationMode: "silent" });
  vm.runInContext(helpersSource, harness.context);

  await assert.rejects(
    vm.runInContext("safeSendMessage({ action: 'mutating' }, 5, { retries: 3, retryDelay: 0 })", harness.context),
    /timeout/i
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(harness.sendCount, 1);
});

test("content messaging rejects explicit and empty background responses", async () => {
  for (const [mode, expected] of [
    ["errorResponse", /denied by background/],
    ["emptyResponse", /No response from extension/],
  ]) {
    const harness = createContext({ invalidationMode: mode });
    vm.runInContext(helpersSource, harness.context);
    await assert.rejects(
      vm.runInContext("safeSendMessage({ action: 'read' }, 10)", harness.context),
      expected
    );
    assert.equal(harness.sendCount, 1);
  }
});

test("route watcher stops without repeated render warnings after invalidation", async () => {
  const harness = createContext();
  vm.runInContext(helpersSource, harness.context);
  vm.runInContext("CONFIG.INIT_DELAY = 0", harness.context);
  vm.runInContext(routerSource, harness.context);
  vm.runInContext(`
    window.KDRouteWatcher.register({
      name: "invalidated-test",
      targetSelector: ".post-card",
      hasTargets: () => true,
      render: () => getDownloadedStatusMap([{
        service: "patreon",
        userId: "2301678",
        postId: "post-1",
      }]),
    });
  `, harness.context);

  await new Promise((resolve) => setTimeout(resolve, 20));
  harness.context.window.KDRouteWatcher.schedule("after-stop", 0);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.sendCount, 1);
  assert.equal(harness.observerDisconnected, true);
  assert.deepEqual(harness.warnings, []);
});

test("route watcher does not ignore a host subtree merely because it contains injected UI", async () => {
  const harness = createContext({ invalidationMode: "silent" });
  vm.runInContext(helpersSource, harness.context);
  vm.runInContext("CONFIG.INIT_DELAY = 0", harness.context);
  vm.runInContext(routerSource, harness.context);
  vm.runInContext(`
    globalThis.renderCount = 0;
    window.KDRouteWatcher.register({
      name: "mutation-test",
      targetSelector: ".post-card",
      hasTargets: () => true,
      render: () => { globalThis.renderCount += 1; },
    });
  `, harness.context);
  await new Promise((resolve) => setTimeout(resolve, 20));

  harness.emitMutations([{ addedNodes: [{
    nodeType: 1,
    matches() { return false; },
    querySelector(selector) {
      return selector.includes(".post-card") || selector.includes("data-batch-download") ? {} : null;
    },
  }], removedNodes: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 220));

  assert.equal(harness.context.renderCount, 2);
});

test("one route renderer failure does not starve later handlers", async () => {
  const harness = createContext({ invalidationMode: "silent" });
  vm.runInContext(helpersSource, harness.context);
  vm.runInContext("CONFIG.INIT_DELAY = 0", harness.context);
  vm.runInContext(routerSource, harness.context);
  vm.runInContext(`
    globalThis.laterRenderCount = 0;
    window.KDRouteWatcher.register({ name: "broken", render: () => { throw new Error("broken renderer"); } });
    window.KDRouteWatcher.register({ name: "later", render: () => { globalThis.laterRenderCount += 1; } });
  `, harness.context);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.context.laterRenderCount, 1);
  assert.equal(harness.warnings.length, 1);
});
