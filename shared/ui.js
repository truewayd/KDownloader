// Shared extension-page interaction primitives.
(function () {
  "use strict";

  const TRANSIENT_ERROR = /Receiving end does not exist|message port closed|Could not establish connection/i;
  const busyButtons = new WeakMap();

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

  async function withBusyButton(button, task) {
    if (!button) return task();
    let state = busyButtons.get(button);
    if (!state) {
      state = {
        count: 0,
        wasDisabled: button.disabled,
        previousBusy: button.getAttribute("aria-busy"),
      };
      busyButtons.set(button, state);
    }
    state.count += 1;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      return await task();
    } finally {
      state.count -= 1;
      if (state.count === 0) {
        busyButtons.delete(button);
        button.disabled = state.wasDisabled;
        if (state.previousBusy === null) button.removeAttribute("aria-busy");
        else button.setAttribute("aria-busy", state.previousBusy);
      }
    }
  }

  function createToast(element, { statusElement = null, duration = 2600 } = {}) {
    let timer = null;
    let presentation = 0;
    const hide = () => {
      presentation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      element?.classList.remove("is-visible");
    };
    const show = (message, type = "success") => {
      if (!element) return;
      const version = ++presentation;
      if (timer) clearTimeout(timer);
      const normalizedType = type === "error" ? "error" : "success";
      element.classList.add("kd-toast");
      element.classList.remove("success", "error", "is-visible");
      element.classList.add(normalizedType);
      element.textContent = String(message ?? "");
      element.setAttribute("aria-live", normalizedType === "error" ? "assertive" : "polite");
      if (statusElement) statusElement.textContent = String(message ?? "");
      requestAnimationFrame(() => {
        if (version === presentation) element.classList.add("is-visible");
      });
      timer = setTimeout(hide, duration);
    };
    return Object.freeze({ show, hide });
  }

  function setIconButton(button, iconId, label, iconRoot = "") {
    if (!button) return;
    const svg = button.querySelector("svg.kd-button-icon") || document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("kd-button-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = svg.querySelector("use") || document.createElementNS("http://www.w3.org/2000/svg", "use");
    const href = `${iconRoot}#${iconId}`;
    use.setAttribute("href", href);
    use.setAttributeNS("http://www.w3.org/1999/xlink", "href", href);
    if (!use.parentNode) svg.appendChild(use);
    const labelElement = button.querySelector("span") || document.createElement("span");
    labelElement.textContent = label;
    button.replaceChildren(svg, labelElement);
  }

  function setSegmentedValue(buttons, value, attribute = "data-value") {
    for (const button of buttons || []) {
      const active = button.getAttribute(attribute) === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function prepareDecorativeIcons(scope = document) {
    if (!scope?.querySelectorAll) return;
    for (const icon of scope.querySelectorAll(".kd-icon, .kd-button-icon")) {
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("focusable", "false");
    }
  }

  prepareDecorativeIcons();

  globalThis.KDUI = Object.freeze({
    sendMessage,
    withBusyButton,
    createToast,
    setIconButton,
    setSegmentedValue,
    prepareDecorativeIcons,
  });
})();
