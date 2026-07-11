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
  };

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
    return isElement(node) && nodeHasSelector(node, '[data-batch-download="true"]');
  }

  function mutationLooksRelevant(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (isOwnInjectedNode(node)) continue;
        for (const handler of handlers) {
          if (nodeHasSelector(node, handler.targetSelector)) return true;
        }
      }
      for (const node of mutation.removedNodes) {
        if (isOwnInjectedNode(node)) continue;
        for (const handler of handlers) {
          if (nodeHasSelector(node, handler.targetSelector)) return true;
        }
      }
    }
    return false;
  }

  function patchHistory() {
    if (history.__kdRouteWatcherPatched) return;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      window.dispatchEvent(new Event("kd:locationchange"));
      return result;
    };

    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      window.dispatchEvent(new Event("kd:locationchange"));
      return result;
    };

    Object.defineProperty(history, "__kdRouteWatcherPatched", {
      value: true,
      configurable: false,
    });
  }

  function getInitDelay() {
    try {
      return typeof CONFIG !== "undefined" && CONFIG && CONFIG.INIT_DELAY
        ? CONFIG.INIT_DELAY
        : 300;
    } catch (e) {
      return 300;
    }
  }

  function ensureObserver() {
    const target = document.documentElement || document.body;
    if (!target || state.observer) return;
    state.observer = new MutationObserver((mutations) => {
      if (mutationLooksRelevant(mutations)) schedule("mutation", 180);
    });
    state.observer.observe(target, { childList: true, subtree: true });
  }

  function schedule(reason = "manual", delayMs = 250) {
    state.pendingReason = reason;
    if (state.timer) clearTimeout(state.timer);
    state.scheduled = true;
    state.timer = setTimeout(run, delayMs);
  }

  async function run() {
    if (state.running) {
      schedule("rerun", 250);
      return;
    }

    state.running = true;
    state.scheduled = false;
    const reason = state.pendingReason || "scheduled";
    const href = location.href;
    const urlChanged = href !== state.lastHref;
    if (urlChanged) state.generation += 1;
    const generation = state.generation;
    const context = {
      reason,
      href,
      urlChanged,
      generation,
      isCurrent: () => generation === state.generation && href === location.href,
    };
    let needsRetry = false;

    try {
      for (const handler of handlers) {
        const matches = typeof handler.match === "function" ? handler.match() : true;
        if (!matches) {
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
      }
    } catch (err) {
      console.warn("[KD Router] render failed", err);
    } finally {
      state.lastHref = href;
      state.running = false;
      if (needsRetry) schedule("wait-targets", 300);
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    patchHistory();

    window.addEventListener("kd:locationchange", () => schedule("history", 220));
    window.addEventListener("popstate", () => schedule("popstate", 220));
    window.addEventListener("hashchange", () => schedule("hashchange", 220));
    window.addEventListener("pageshow", () => schedule("pageshow", 220));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) schedule("visible", 220);
    });

    for (const eventName of [
      "htmx:afterSwap",
      "htmx:afterSettle",
      "htmx:load",
      "htmx:historyRestore",
    ]) {
      document.addEventListener(eventName, () => schedule(eventName, 180));
    }

    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          ensureObserver();
          schedule("domcontentloaded", getInitDelay());
        },
        { once: true }
      );
    } else {
      ensureObserver();
      schedule("start", getInitDelay());
    }
  }

  function register(handler) {
    if (!handler || typeof handler.render !== "function") return;
    handlers.push({ attempts: 0, ...handler });
    start();
    schedule(`register:${handler.name || "handler"}`, getInitDelay());
  }

  window.KDRouteWatcher = {
    register,
    schedule,
  };
})();
