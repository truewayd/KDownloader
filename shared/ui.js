// Shared extension-page interaction primitives.
(function () {
  "use strict";

  const TRANSIENT_ERROR = /Receiving end does not exist|message port closed|Could not establish connection/i;

  function sendMessage(message, timeout = 7000, opts = {}) {
    const retries = Math.max(0, Number.isFinite(opts.retries) ? opts.retries : 1);
    const retryDelay = Math.max(
      0,
      Number.isFinite(opts.retryDelay) ? opts.retryDelay : 300
    );

    const attempt = (remaining) => new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback(value);
      };

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            const error = new Error(runtimeError.message || "Runtime error");
            if (remaining > 0 && TRANSIENT_ERROR.test(error.message)) {
              finish(() => setTimeout(() => attempt(remaining - 1).then(resolve, reject), retryDelay));
            } else {
              finish(reject, error);
            }
            return;
          }
          if (!response) {
            finish(reject, new Error("No response from extension"));
            return;
          }
          if (response.success === false) {
            finish(reject, new Error(response.error || "Request failed"));
            return;
          }
          finish(resolve, response);
        });
      } catch (error) {
        if (remaining > 0 && TRANSIENT_ERROR.test(error?.message || "")) {
          finish(() => setTimeout(() => attempt(remaining - 1).then(resolve, reject), retryDelay));
        } else {
          finish(reject, error);
        }
      }

      if (timeout > 0) {
        timer = setTimeout(() => {
          const error = new Error("Request timed out");
          // The service worker may still be processing a request whose reply
          // timed out. Retrying here could duplicate a state-changing action.
          finish(reject, error);
        }, timeout);
      }
    });

    return attempt(retries);
  }

  if (!globalThis.KDComponents) {
    throw new Error("KDComponents must load before shared/ui.js");
  }

  KDComponents.prepareDecorativeIcons();

  globalThis.KDUI = Object.freeze({
    sendMessage,
    createProgress: KDComponents.createProgress,
    withBusyButton: KDComponents.withBusyButton,
    createToast: KDComponents.createToast,
    setIconButton: KDComponents.setIconButton,
    setSegmentedValue: KDComponents.setSegmentedValue,
    setBusyState: KDComponents.setBusyState,
    prepareDecorativeIcons: KDComponents.prepareDecorativeIcons,
  });
})();
