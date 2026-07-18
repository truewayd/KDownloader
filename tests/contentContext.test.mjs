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
  const window = new EventTarget();
  const document = new EventTarget();
  document.readyState = "complete";
  document.hidden = false;
  document.documentElement = {};
  document.body = {};

  class TestMutationObserver {
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
