// content/router.js - shared DOM/SPA/HTMX injection scheduler
(function () {
  if (window.KDRouteWatcher) return;

  const handlers = [];
  const state = {
    started: false,
    scheduled: false,
    timer: null,
    running: false,
    pendingReason: null,
    lastHref: location.href,
    generation: 0,
    stopped: false,
    listenerController: null,
    targetSelector: "",
    historyPatch: null,
  };

  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    state.scheduled = false;
    state.pendingReason = null;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.listenerController?.abort();
    state.listenerController = null;
    try {
      chrome.runtime.onMessage?.removeListener(onRuntimeMessage);
    } catch { }
    const patch = state.historyPatch;
    if (patch) {
      if (history.pushState === patch.pushState) history.pushState = patch.originalPushState;
      if (history.replaceState === patch.replaceState) history.replaceState = patch.originalReplaceState;
      try {
        delete history.__kdRouteWatcherPatched;
      } catch (e) {
        /* A host page may have made the marker non-configurable. */
      }
      state.historyPatch = null;
    }
    handlers.length = 0;
    state.targetSelector = "";
  }

  function isElement(node) {
    return node && node.nodeType === Node.ELEMENT_NODE;
  }

  function nodeHasSelector(node, selector) {
    if (!isElement(node) || !selector) return false;
    try {
      return node.matches(selector) || !!node.querySelector(selector);
    } catch (e) {
      return false;
    }
  }

  function isOwnInjectedNode(node) {
    if (!isElement(node)) return false;
    try {
      return node.matches(
        '[data-batch-download="true"], [data-kd-watch="true"], [data-kd-flag="true"]'
      );
    } catch (e) {
      return false;
    }
  }

  function mutationLooksRelevant(mutations) {
    const selector = state.targetSelector;
    if (!selector) return false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (isOwnInjectedNode(node)) continue;
        if (nodeHasSelector(node, selector)) return true;
      }
      for (const node of mutation.removedNodes) {
        if (isOwnInjectedNode(node)) continue;
        if (nodeHasSelector(node, selector)) return true;
      }
    }
    return false;
  }

  function patchHistory() {
    if (history.__kdRouteWatcherPatched) return;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      window.dispatchEvent(new Event("kd:locationchange"));
      return result;
    };
    const replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      window.dispatchEvent(new Event("kd:locationchange"));
      return result;
    };

    history.pushState = pushState;
    history.replaceState = replaceState;

    Object.defineProperty(history, "__kdRouteWatcherPatched", {
      value: true,
      configurable: true,
    });
    state.historyPatch = { originalPushState, originalReplaceState, pushState, replaceState };
  }

  function getInitDelay() {
    try {
      const delay = typeof CONFIG !== "undefined" && CONFIG
        ? Number(CONFIG.INIT_DELAY)
        : NaN;
      return Number.isFinite(delay) && delay >= 0 ? delay : 300;
    } catch (e) {
      return 300;
    }
  }

  function ensureObserver() {
    const target = document.documentElement || document.body;
    if (state.stopped || !target || state.observer) return;
    state.observer = new MutationObserver((mutations) => {
      if (mutationLooksRelevant(mutations)) schedule("mutation", 180);
    });
    state.observer.observe(target, { childList: true, subtree: true });
  }

  function schedule(reason = "manual", delayMs = 250) {
    if (state.stopped) return;
    state.pendingReason = reason;
    if (state.timer) clearTimeout(state.timer);
    state.scheduled = true;
    state.timer = setTimeout(run, delayMs);
  }

  async function run() {
    if (state.stopped) return;
    state.timer = null;
    if (state.running) {
      schedule("rerun", 250);
      return;
    }

    state.running = true;
    state.scheduled = false;
    const reason = state.pendingReason || "scheduled";
    state.pendingReason = null;
    const href = location.href;
    const urlChanged = href !== state.lastHref;
    if (urlChanged) state.generation += 1;
    const generation = state.generation;
    const context = {
      reason,
      href,
      urlChanged,
      generation,
      isCurrent: () => !state.stopped && generation === state.generation && href === location.href,
    };
    let needsRetry = false;

    try {
      for (const handler of handlers) {
        try {
          const matches = typeof handler.match === "function" ? handler.match() : true;
          if (!matches) {
            handler.attempts = 0;
            if (urlChanged && typeof handler.cleanup === "function") {
              await handler.cleanup(context);
            }
            continue;
          }

          const ready = typeof handler.hasTargets === "function" ? handler.hasTargets() : true;
          const maxAttempts = Number.isFinite(handler.maxAttempts) ? handler.maxAttempts : 20;
          if (!ready && handler.attempts < maxAttempts) {
            handler.attempts += 1;
            needsRetry = true;
            continue;
          }

          handler.attempts = 0;
          await handler.render(context);
        } catch (err) {
          if (typeof isExtensionContextInvalidatedError === "function"
            && isExtensionContextInvalidatedError(err)) {
            throw err;
          }
          console.warn(`[KD Router] ${handler.name || "handler"} render failed`, err);
        }
      }
    } catch (err) {
      if (typeof isExtensionContextInvalidatedError === "function"
        && isExtensionContextInvalidatedError(err)) {
        stop();
      } else {
        console.warn("[KD Router] render failed", err);
      }
    } finally {
      state.lastHref = href;
      state.running = false;
      if (typeof pruneActiveDownloadRequests === "function") {
        pruneActiveDownloadRequests();
      }
      if (needsRetry && !state.stopped) schedule("wait-targets", 300);
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    state.listenerController = typeof AbortController === "function" ? new AbortController() : null;
    const signal = state.listenerController?.signal;
    patchHistory();
    chrome.runtime.onMessage?.addListener(onRuntimeMessage);
    window.addEventListener(EXTENSION_CONTEXT_INVALIDATED_EVENT, stop, { once: true, signal });

    window.addEventListener("kd:locationchange", () => schedule("history", 220), { signal });
    window.addEventListener("popstate", () => schedule("popstate", 220), { signal });
    window.addEventListener("hashchange", () => schedule("hashchange", 220), { signal });
    window.addEventListener("pageshow", () => schedule("pageshow", 220), { signal });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) schedule("visible", 220);
    }, { signal });

    for (const eventName of [
      "htmx:afterSwap",
      "htmx:afterSettle",
      "htmx:load",
      "htmx:historyRestore",
    ]) {
      document.addEventListener(eventName, () => schedule(eventName, 180), { signal });
    }

    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          ensureObserver();
          schedule("domcontentloaded", getInitDelay());
        },
        { once: true, signal }
      );
    } else {
      ensureObserver();
      schedule("start", getInitDelay());
    }
  }

  function onRuntimeMessage(message) {
    if (message?.action === "updateUI") schedule("updateUI", 100);
  }

  function register(handler) {
    if (!handler || typeof handler.render !== "function") return;
    const registered = { ...handler, attempts: 0 };
    const existingIndex = registered.name
      ? handlers.findIndex((item) => item.name === registered.name)
      : -1;
    if (existingIndex >= 0) handlers[existingIndex] = registered;
    else handlers.push(registered);
    state.targetSelector = handlers
      .map((registered) => registered.targetSelector)
      .filter(Boolean)
      .join(", ");
    start();
    schedule(`register:${handler.name || "handler"}`, getInitDelay());
  }

  window.KDRouteWatcher = {
    register,
    schedule,
  };
})();
