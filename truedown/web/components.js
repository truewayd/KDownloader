// Canonical UI component runtime shared by the extension and desktop dashboard.
(function () {
  "use strict";

  const ACTION_TAG = "kd-ui-action";
  const LINKS_DIALOG_TAG = "kd-ui-links-dialog";
  const busyButtons = new WeakMap();
  const busyControlLabels = new WeakMap();
  const componentStyleSheets = new Map();
  const manualActionControls = new WeakMap();
  const linksDialogControllers = new WeakMap();
  let confirmDialogSequence = 0;
  const HTMLElementBase = globalThis.HTMLElement || class {};

  const CONTENT_COMPONENT_STYLES = String.raw`
    :host {
      --kd-content-surface: #1e2525;
      --kd-content-surface-raised: #2a3434;
      --kd-content-border: rgba(224, 235, 235, 0.22);
      --kd-content-text: #f1f5f5;
      --kd-content-muted: #a6b2b2;
      --kd-content-accent: #487a7a;
      --kd-content-accent-hover: #3c6868;
      --kd-content-accent-text: #ffffff;
      --kd-content-focus: #79a8a8;
      --kd-content-success: #47773e;
      --kd-content-success-hover: #3f7038;
      --kd-content-success-text: #d4ebd0;
      --kd-content-warning: #d19a5b;
      --kd-content-warning-hover: #b87c3d;
      --kd-content-warning-text: #151a1a;
      --kd-content-error: #ad5047;
      --kd-content-error-hover: #b65349;
      --kd-content-error-text: #f2c6c1;
      --kd-content-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      box-sizing: border-box;
      display: inline-block;
      pointer-events: auto;
      cursor: pointer;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      letter-spacing: 0;
    }

    :host([hidden]) { display: none !important; }
    :host([disabled]) { cursor: not-allowed; }
    :host([aria-busy="true"]),
    :host([data-status="SCANNING"]),
    :host([data-status="SENDING"]) { cursor: progress; }

    button {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-width: 0;
      min-height: 36px;
      margin: 0;
      border: 1px solid color-mix(in srgb, var(--kd-content-accent) 70%, transparent);
      border-radius: 8px;
      padding: 8px 12px;
      background: var(--kd-content-accent);
      color: var(--kd-content-accent-text);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.14) inset;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 720;
      line-height: 1;
      text-align: center;
      text-decoration: none;
      white-space: nowrap;
      appearance: none;
      transition:
        background-color 140ms ease,
        border-color 140ms ease,
        box-shadow 140ms ease,
        transform 80ms ease;
    }

    button:hover:not(:disabled) {
      border-color: var(--kd-content-accent-hover);
      background: var(--kd-content-accent-hover);
    }

    button:active:not(:disabled) { transform: translateY(1px); }

    button:focus-visible,
    a:focus-visible {
      outline: 2px solid var(--kd-content-focus);
      outline-offset: 2px;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.58;
    }

    button[aria-busy="true"],
    :host([data-status="SCANNING"]) button,
    :host([data-status="SENDING"]) button { cursor: progress; }

    :host([data-status="SCANNING"]) button::before,
    :host([data-status="SENDING"]) button::before {
      content: "";
      display: block;
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      border: 2px solid color-mix(in srgb, currentColor 28%, transparent);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: kd-component-spin 1s linear infinite;
    }

    :host([data-status="SUCCESS"]) button {
      border-color: var(--kd-content-success);
      background: var(--kd-content-success);
      color: #fff;
    }

    :host([data-status="SUCCESS"]) button:hover:not(:disabled) {
      background: var(--kd-content-success-hover);
    }

    :host([data-status="PARTIAL"]) button {
      border-color: var(--kd-content-warning);
      background: var(--kd-content-warning);
      color: var(--kd-content-warning-text);
    }

    :host([data-status="PARTIAL"]) button:hover:not(:disabled) {
      background: var(--kd-content-warning-hover);
    }

    :host([data-status="ERROR"]) button {
      border-color: var(--kd-content-error);
      background: var(--kd-content-error);
      color: #fff;
    }

    :host([data-status="ERROR"]) button:hover:not(:disabled) {
      background: var(--kd-content-error-hover);
    }

    :host(.kd-watch-button[data-watched="true"]) button {
      border-color: var(--kd-content-border);
      background: var(--kd-content-surface-raised);
      color: var(--kd-content-text);
    }

    :host([variant="creator"]),
    :host([variant="flag"]) {
      position: absolute;
      right: 8px;
      bottom: 8px;
      z-index: 10;
      display: inline-flex;
      width: 40px;
      height: 40px;
    }

    :host([variant="creator"]) button,
    :host([variant="flag"]) button {
      width: 100%;
      height: 100%;
      min-height: 0;
      border-color: var(--kd-content-border);
      border-radius: 50%;
      padding: 0;
      background: var(--kd-content-surface);
      background: color-mix(in srgb, var(--kd-content-surface) 88%, transparent);
      color: var(--kd-content-text);
      box-shadow: var(--kd-content-shadow);
      font-size: 18px;
      font-weight: 750;
      user-select: none;
      -webkit-backdrop-filter: blur(12px) saturate(150%);
      backdrop-filter: blur(12px) saturate(150%);
    }

    :host([variant="creator"]) button:hover:not(:disabled),
    :host([variant="flag"]) button:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--kd-content-accent) 62%, var(--kd-content-border));
      background: var(--kd-content-surface-raised);
    }

    :host([variant="creator"][data-status="SUCCESS"]) button {
      border-color: color-mix(in srgb, var(--kd-content-success) 72%, transparent);
      background: color-mix(in srgb, var(--kd-content-surface) 88%, transparent);
      color: var(--kd-content-success-text);
    }

    :host([variant="creator"][data-status="PARTIAL"]) button {
      border-color: color-mix(in srgb, var(--kd-content-warning) 76%, transparent);
      background: color-mix(in srgb, var(--kd-content-surface) 88%, transparent);
      color: var(--kd-content-warning);
    }

    :host([variant="creator"][data-status="ERROR"]) button {
      border-color: color-mix(in srgb, var(--kd-content-error) 72%, transparent);
      background: color-mix(in srgb, var(--kd-content-surface) 88%, transparent);
      color: var(--kd-content-error-text);
    }

    :host([variant="creator"][data-status="SCANNING"]),
    :host([variant="creator"][data-status="SENDING"]) {
      animation: kd-component-spin 1s linear infinite;
    }

    :host([variant="creator"][data-status="SCANNING"]) button::before,
    :host([variant="creator"][data-status="SENDING"]) button::before { content: none; }

    :host([variant="flag"]) {
      width: 36px;
      height: 36px;
    }

    :host([variant="flag"]) button::before {
      content: "";
      width: 12px;
      height: 12px;
      border: 2px solid color-mix(in srgb, #5f8d55 78%, #fff);
      border-radius: 50%;
      background: #5f8d55;
      box-shadow: 0 0 0 2px color-mix(in srgb, #5f8d55 18%, transparent);
    }

    :host([variant="flag"][data-flag="true"]) button::before {
      border-color: color-mix(in srgb, #c95f52 78%, #fff);
      background: #c95f52;
      box-shadow: 0 0 0 2px color-mix(in srgb, #c95f52 18%, transparent);
    }

    :host(.kd-coomerfans-post-button) { width: fit-content; margin-top: 8px; }

    @media (prefers-color-scheme: light) {
      :host {
        --kd-content-surface: #ffffff;
        --kd-content-surface-raised: #e6eeee;
        --kd-content-border: rgba(47, 69, 69, 0.24);
        --kd-content-text: #202b2b;
        --kd-content-muted: #5e6f6f;
        --kd-content-accent: #487a7a;
        --kd-content-accent-hover: #3c6868;
        --kd-content-accent-text: #ffffff;
        --kd-content-focus: #487a7a;
        --kd-content-success: #4b8042;
        --kd-content-success-hover: #3f7038;
        --kd-content-success-text: #365b2f;
        --kd-content-warning: #8b5e20;
        --kd-content-warning-hover: #704714;
        --kd-content-warning-text: #ffffff;
        --kd-content-error: #b0453a;
        --kd-content-error-hover: #96372f;
        --kd-content-error-text: #8b3326;
        --kd-content-shadow: 0 8px 24px rgba(35, 60, 60, 0.18);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      button { transition-duration: 1ms !important; }
      :host([data-status="SCANNING"]) button::before,
      :host([data-status="SENDING"]) button::before,
      :host([variant="creator"][data-status="SCANNING"]),
      :host([variant="creator"][data-status="SENDING"]) {
        animation-duration: 1ms !important;
        animation-iteration-count: 1 !important;
      }
    }

    @keyframes kd-component-spin { to { transform: rotate(360deg); } }
  `;

  const LINKS_DIALOG_STYLES = String.raw`
    :host {
      --kd-content-surface: #1e2525;
      --kd-content-surface-raised: #2a3434;
      --kd-content-border: rgba(224, 235, 235, 0.22);
      --kd-content-text: #f1f5f5;
      --kd-content-muted: #a6b2b2;
      --kd-content-link: #8eb2b2;
      --kd-content-focus: #79a8a8;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: block;
      box-sizing: border-box;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }

    .overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      background: rgba(0, 0, 0, 0.72);
      -webkit-backdrop-filter: blur(4px);
      backdrop-filter: blur(4px);
      animation: kd-links-overlay-in 180ms ease-out;
    }

    .dialog {
      box-sizing: border-box;
      width: min(640px, 100%);
      max-height: min(80vh, 720px);
      overflow-y: auto;
      border: 1px solid var(--kd-content-border);
      border-radius: 8px;
      padding: 20px;
      background: var(--kd-content-surface);
      color: var(--kd-content-text);
      box-shadow: 0 20px 54px rgba(0, 0, 0, 0.46);
      animation: kd-links-dialog-in 180ms ease-out;
    }

    .dialog * { box-sizing: border-box; }
    h3 { margin: 0 0 8px; color: var(--kd-content-text); font-size: 18px; font-weight: 700; line-height: 1.3; }
    p { margin: 0 0 14px; color: var(--kd-content-muted); font-size: 13px; line-height: 1.5; }
    ul { display: flex; flex-direction: column; gap: 8px; margin: 0 0 16px; padding: 0; list-style: none; }
    li { min-width: 0; border-left: 3px solid color-mix(in srgb, #487a7a 72%, transparent); padding: 8px 10px; background: color-mix(in srgb, var(--kd-content-surface-raised) 62%, transparent); }
    a { color: var(--kd-content-link); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; text-decoration: none; }
    a:hover { text-decoration: underline; }
    a:focus-visible,
    button:focus-visible { outline: 2px solid var(--kd-content-focus); outline-offset: 2px; }
    button { width: 100%; min-height: 36px; border: 1px solid rgba(72, 122, 122, 0.78); border-radius: 8px; padding: 8px 12px; background: #487a7a; color: #fff; cursor: pointer; font: inherit; font-size: 13px; font-weight: 700; }
    button:hover { border-color: #3c6868; background: #3c6868; }
    .dialog::-webkit-scrollbar { width: 8px; }
    .dialog::-webkit-scrollbar-track { border-radius: 4px; background: color-mix(in srgb, var(--kd-content-surface-raised) 45%, transparent); }
    .dialog::-webkit-scrollbar-thumb { border-radius: 4px; background: var(--kd-content-border); }

    @media (prefers-color-scheme: light) {
      :host {
        --kd-content-surface: #ffffff;
        --kd-content-surface-raised: #e6eeee;
        --kd-content-border: rgba(47, 69, 69, 0.24);
        --kd-content-text: #202b2b;
        --kd-content-muted: #5e6f6f;
        --kd-content-link: #3c6868;
        --kd-content-focus: #487a7a;
      }
    }

    @media (max-width: 480px) { .dialog { padding: 16px; } }
    @media (prefers-reduced-motion: reduce) {
      .overlay,
      .dialog { animation-duration: 1ms !important; animation-iteration-count: 1 !important; }
    }
    @keyframes kd-links-overlay-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes kd-links-dialog-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  `;

  function appendStyle(root, cssText, key) {
    if (globalThis.CSSStyleSheet
      && "adoptedStyleSheets" in root
      && typeof CSSStyleSheet.prototype.replaceSync === "function") {
      try {
        let sheet = componentStyleSheets.get(key);
        if (!sheet) {
          sheet = new CSSStyleSheet();
          sheet.replaceSync(cssText);
          componentStyleSheets.set(key, sheet);
        }
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        return;
      } catch (error) {
        componentStyleSheets.delete(key);
      }
    }
    const style = (root.ownerDocument || document).createElement("style");
    style.textContent = cssText;
    root.appendChild(style);
  }

  function initializeManualActionElement(element) {
    let root = element.shadowRoot;
    if (!root) root = element.attachShadow({ mode: "open", delegatesFocus: true });
    let control = root.querySelector("button");
    if (!control) {
      appendStyle(root, CONTENT_COMPONENT_STYLES, "action");
      control = (element.ownerDocument || document).createElement("button");
      control.type = "button";
      root.appendChild(control);
    }

    if (manualActionControls.get(element) === control) return control;
    manualActionControls.set(element, control);
    const nativeSetAttribute = element.setAttribute.bind(element);
    const nativeRemoveAttribute = element.removeAttribute.bind(element);
    const nativeToggleAttribute = element.toggleAttribute.bind(element);
    const syncAttribute = (name) => {
      const value = element.getAttribute(name);
      if (name === "disabled") {
        control.disabled = value !== null;
      } else if (name === "type") {
        control.type = value || "button";
      } else if (name === "title" || name.startsWith("aria-")) {
        if (value === null) control.removeAttribute(name);
        else control.setAttribute(name, value);
      }
    };

    Object.defineProperties(element, {
      disabled: {
        configurable: true,
        get: () => control.disabled,
        set: (value) => {
          nativeToggleAttribute("disabled", Boolean(value));
          control.disabled = Boolean(value);
        },
      },
      type: {
        configurable: true,
        get: () => control.type || "button",
        set: (value) => {
          nativeSetAttribute("type", value || "button");
          control.type = value || "button";
        },
      },
      title: {
        configurable: true,
        get: () => control.title || "",
        set: (value) => {
          nativeSetAttribute("title", String(value ?? ""));
          control.title = String(value ?? "");
        },
      },
      textContent: {
        configurable: true,
        get: () => control.textContent || "",
        set: (value) => { control.textContent = String(value ?? ""); },
      },
      focus: {
        configurable: true,
        value: (options) => control.focus(options),
      },
      click: {
        configurable: true,
        value: () => control.click(),
      },
      setAttribute: {
        configurable: true,
        value: (name, value) => {
          nativeSetAttribute(name, value);
          syncAttribute(String(name));
        },
      },
      removeAttribute: {
        configurable: true,
        value: (name) => {
          nativeRemoveAttribute(name);
          syncAttribute(String(name));
        },
      },
      toggleAttribute: {
        configurable: true,
        value: (name, force) => {
          const normalizedName = String(name);
          const result = force === undefined
            ? nativeToggleAttribute(normalizedName)
            : nativeToggleAttribute(normalizedName, force);
          syncAttribute(normalizedName);
          return result;
        },
      },
    });

    for (const attribute of element.getAttributeNames()) syncAttribute(attribute);
    return control;
  }

  function initializeLinksDialogElement(element) {
    const existing = linksDialogControllers.get(element);
    if (existing) return existing;

    const ownerDocument = element.ownerDocument || document;
    let root = element.shadowRoot;
    if (!root) root = element.attachShadow({ mode: "open", delegatesFocus: true });
    const state = {
      closed: true,
      dialog: null,
      returnFocus: null,
    };

    const dispatchClose = () => {
      const EventConstructor = ownerDocument.defaultView?.CustomEvent || globalThis.CustomEvent;
      if (typeof EventConstructor === "function") {
        element.dispatchEvent(new EventConstructor("kd-close"));
      }
    };
    const restoreFocus = () => {
      const returnFocus = state.returnFocus;
      state.returnFocus = null;
      if (returnFocus?.isConnected && typeof returnFocus.focus === "function") {
        returnFocus.focus({ preventScroll: true });
      }
    };
    const handleKeydown = (event) => {
      if (state.closed) return;
      if (event.key === "Escape") {
        event.preventDefault();
        controller.close();
        return;
      }
      if (event.key !== "Tab" || !state.dialog) return;
      const focusable = Array.from(
        state.dialog.querySelectorAll("a[href], button:not(:disabled)")
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = root.activeElement;
      if (!state.dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const controller = {
      show({
        title,
        description,
        links,
        closeLabel,
        returnFocus = ownerDocument.activeElement,
      }) {
        ownerDocument.removeEventListener("keydown", handleKeydown);
        state.closed = true;
        state.dialog = null;
        state.returnFocus = null;
        root.replaceChildren();
        try {
          root.adoptedStyleSheets = [];
        } catch (error) {
          /* A local style fallback is appended below. */
        }
        appendStyle(root, LINKS_DIALOG_STYLES, "links-dialog");
        state.returnFocus = returnFocus;
        state.closed = false;

        const overlay = ownerDocument.createElement("div");
        overlay.className = "overlay";
        const dialog = ownerDocument.createElement("section");
        dialog.className = "dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-labelledby", "kd-links-title");
        dialog.setAttribute("aria-describedby", "kd-links-description");

        const heading = ownerDocument.createElement("h3");
        heading.id = "kd-links-title";
        heading.textContent = title;
        const copy = ownerDocument.createElement("p");
        copy.id = "kd-links-description";
        copy.textContent = description;
        const list = ownerDocument.createElement("ul");
        for (const href of links) {
          const item = ownerDocument.createElement("li");
          const anchor = ownerDocument.createElement("a");
          anchor.href = href;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.textContent = href;
          item.appendChild(anchor);
          list.appendChild(item);
        }
        const closeButton = ownerDocument.createElement("button");
        closeButton.type = "button";
        closeButton.textContent = closeLabel;
        closeButton.addEventListener("click", () => controller.close());
        overlay.addEventListener("click", (event) => {
          if (event.target === overlay) controller.close();
        });

        dialog.append(heading, copy, list, closeButton);
        overlay.appendChild(dialog);
        root.appendChild(overlay);
        state.dialog = dialog;
        ownerDocument.addEventListener("keydown", handleKeydown);
        closeButton.focus({ preventScroll: true });
      },
      close() {
        if (state.closed) return;
        state.closed = true;
        ownerDocument.removeEventListener("keydown", handleKeydown);
        state.dialog = null;
        element.remove();
        restoreFocus();
        dispatchClose();
      },
      disconnect() {
        ownerDocument.removeEventListener("keydown", handleKeydown);
        if (state.closed) return;
        state.closed = true;
        state.dialog = null;
        restoreFocus();
        dispatchClose();
      },
    };
    linksDialogControllers.set(element, controller);

    if (typeof element.show !== "function") {
      Object.defineProperty(element, "show", {
        configurable: true,
        value: (options) => controller.show(options),
      });
    }
    if (typeof element.close !== "function") {
      Object.defineProperty(element, "close", {
        configurable: true,
        value: () => controller.close(),
      });
    }
    return controller;
  }

  function scheduleActionStyleAudit(element, control) {
    if (typeof requestAnimationFrame !== "function") return;
    requestAnimationFrame(() => {
      if (!element.isConnected || !control?.isConnected) return;
      let style;
      try {
        style = getComputedStyle(control);
      } catch (error) {
        return;
      }
      const backgroundMissing = style.backgroundColor === "rgba(0, 0, 0, 0)"
        || style.backgroundColor === "transparent";
      const status = element.getAttribute("data-status");
      const expectedCursor = status === "SCANNING" || status === "SENDING" || control.getAttribute("aria-busy") === "true"
        ? "progress"
        : (control.disabled ? "not-allowed" : "pointer");
      const baseStylesReady = style.display === "inline-flex" && style.cursor === expectedCursor;
      const variant = element.getAttribute("variant");
      const overlayStylesReady = variant !== "creator" && variant !== "flag"
        ? true
        : style.borderRadius === "50%" && !backgroundMissing;
      if (baseStylesReady && overlayStylesReady) {
        return;
      }
      const root = element.shadowRoot;
      if (!root || root.querySelector("style[data-kd-action-fallback]")) return;
      const fallback = (element.ownerDocument || document).createElement("style");
      fallback.setAttribute("data-kd-action-fallback", "true");
      fallback.textContent = CONTENT_COMPONENT_STYLES;
      root.prepend(fallback);
    });
  }

  class KDActionElement extends HTMLElementBase {
    static get observedAttributes() {
      return ["disabled", "title", "type"];
    }

    constructor() {
      super();
      const root = this.attachShadow({ mode: "open", delegatesFocus: true });
      appendStyle(root, CONTENT_COMPONENT_STYLES, "action");
      this.control = document.createElement("button");
      this.control.type = "button";
      root.appendChild(this.control);
    }

    connectedCallback() {
      for (const name of KDActionElement.observedAttributes) {
        this.#syncAttribute(name, this.getAttribute(name));
      }
      scheduleActionStyleAudit(this, this.control);
    }

    attributeChangedCallback(name, _oldValue, newValue) {
      this.#syncAttribute(name, newValue);
    }

    setAttribute(name, value) {
      if (String(name).startsWith("aria-") && this.control) {
        this.control.setAttribute(name, String(value));
        if (name === "aria-busy") super.setAttribute(name, value);
        return;
      }
      super.setAttribute(name, value);
    }

    getAttribute(name) {
      if (String(name).startsWith("aria-") && this.control) {
        return this.control.getAttribute(name);
      }
      return super.getAttribute(name);
    }

    removeAttribute(name) {
      if (String(name).startsWith("aria-") && this.control) {
        this.control.removeAttribute(name);
        if (name === "aria-busy") super.removeAttribute(name);
        return;
      }
      super.removeAttribute(name);
    }

    #syncAttribute(name, value) {
      if (!this.control) return;
      if (name === "disabled") {
        this.control.disabled = value !== null;
        return;
      }
      if (name === "type") {
        this.control.type = value || "button";
        return;
      }
      if (value === null) this.control.removeAttribute(name);
      else this.control.setAttribute(name, value);
    }

    get disabled() { return this.control?.disabled || false; }
    set disabled(value) { this.toggleAttribute("disabled", Boolean(value)); }
    get type() { return this.control?.type || "button"; }
    set type(value) { this.setAttribute("type", value || "button"); }
    get textContent() { return this.control?.textContent || ""; }
    set textContent(value) {
      if (this.control) this.control.textContent = String(value ?? "");
    }
    focus(options) { this.control?.focus(options); }
    click() { this.control?.click(); }
  }

  class KDLinksDialogElement extends HTMLElementBase {
    constructor() {
      super();
      initializeLinksDialogElement(this);
    }

    show(options) { linksDialogControllers.get(this)?.show(options); }
    close() { linksDialogControllers.get(this)?.close(); }
    disconnectedCallback() { linksDialogControllers.get(this)?.disconnect(); }
  }

  if (globalThis.customElements && globalThis.HTMLElement && globalThis.document) {
    if (!customElements.get(ACTION_TAG)) customElements.define(ACTION_TAG, KDActionElement);
    if (!customElements.get(LINKS_DIALOG_TAG)) customElements.define(LINKS_DIALOG_TAG, KDLinksDialogElement);
  }

  function ensureActionElement(element) {
    if (!element || element.localName !== ACTION_TAG) {
      throw new TypeError(`Expected a ${ACTION_TAG} element`);
    }
    if (!element.shadowRoot?.querySelector("button")) {
      try {
        globalThis.customElements?.upgrade?.(element);
      } catch (error) {
        /* Isolated-world nodes are hydrated imperatively below. */
      }
    }
    const control = element.shadowRoot?.querySelector("button")
      || initializeManualActionElement(element);
    scheduleActionStyleAudit(element, control);
    return element;
  }

  function createActionElement(ownerDocument = document) {
    return ensureActionElement(ownerDocument.createElement(ACTION_TAG));
  }

  function ensureLinksDialogElement(element) {
    if (!element || element.localName !== LINKS_DIALOG_TAG) {
      throw new TypeError(`Expected a ${LINKS_DIALOG_TAG} element`);
    }
    if (typeof element.show !== "function" || typeof element.close !== "function" || !element.shadowRoot) {
      try {
        globalThis.customElements?.upgrade?.(element);
      } catch (error) {
        /* Isolated-world nodes are hydrated imperatively below. */
      }
    }
    if (typeof element.show !== "function" || typeof element.close !== "function" || !element.shadowRoot) {
      initializeLinksDialogElement(element);
    }
    return element;
  }

  function createLinksDialogElement(ownerDocument = document) {
    return ensureLinksDialogElement(ownerDocument.createElement(LINKS_DIALOG_TAG));
  }

  async function withBusyButton(button, task) {
    if (!button) return task();
    let state = busyButtons.get(button);
    if (!state) {
      state = {
        count: 0,
        wasDisabled: button.disabled,
        previousBusy: button.getAttribute("aria-busy"),
        previousDisabled: button.getAttribute("aria-disabled"),
      };
      busyButtons.set(button, state);
    }
    state.count += 1;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-disabled", "true");
    try {
      return await task();
    } finally {
      state.count -= 1;
      if (state.count === 0) {
        busyButtons.delete(button);
        button.disabled = state.wasDisabled;
        if (state.previousBusy === null) button.removeAttribute("aria-busy");
        else button.setAttribute("aria-busy", state.previousBusy);
        if (state.previousDisabled === null) button.removeAttribute("aria-disabled");
        else button.setAttribute("aria-disabled", state.previousDisabled);
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

  function confirmAction({ title, message, confirmLabel, cancelLabel, danger = false } = {}) {
    const ownerDocument = document;
    const returnFocus = ownerDocument.activeElement;
    const dialog = ownerDocument.createElement("dialog");
    dialog.className = "kd-confirm-dialog";
    const heading = ownerDocument.createElement("h2");
    const description = ownerDocument.createElement("p");
    const dialogID = `kd-confirm-${++confirmDialogSequence}`;
    heading.id = `${dialogID}-title`;
    description.id = `${dialogID}-description`;
    heading.textContent = String(title ?? "");
    description.textContent = String(message ?? "");
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-describedby", description.id);
    const actions = ownerDocument.createElement("div");
    actions.className = "kd-confirm-actions";
    const cancel = ownerDocument.createElement("button");
    cancel.type = "button";
    cancel.className = "kd-button secondary";
    cancel.textContent = String(cancelLabel ?? "");
    cancel.autofocus = true;
    const confirm = ownerDocument.createElement("button");
    confirm.type = "button";
    confirm.className = `kd-button ${danger ? "danger" : "primary"}`;
    confirm.textContent = String(confirmLabel ?? "");
    actions.append(cancel, confirm);
    dialog.append(heading, description, actions);

    return new Promise((resolve, reject) => {
      const handleKeydown = (event) => {
        if (!dialog.open || event.key !== "Tab") return;
        event.preventDefault();
        const controls = [cancel, confirm].filter((control) => !control.disabled);
        const current = controls.indexOf(ownerDocument.activeElement);
        const next = current < 0
          ? (event.shiftKey ? controls.length - 1 : 0)
          : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus({ preventScroll: true });
      };
      const finish = () => {
        ownerDocument.removeEventListener("keydown", handleKeydown, true);
        dialog.remove();
        resolve(dialog.returnValue === "confirm");
        // A caller may restore its busy button after awaiting this result.
        requestAnimationFrame(() => {
          if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        });
      };
      dialog.addEventListener("close", finish, { once: true });
      cancel.addEventListener("click", () => dialog.close("cancel"));
      confirm.addEventListener("click", () => dialog.close("confirm"));
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        dialog.close("cancel");
      });
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < bounds.top || event.clientY > bounds.bottom) {
          dialog.close("cancel");
        }
      });
      ownerDocument.body.appendChild(dialog);
      try {
        dialog.showModal();
        ownerDocument.addEventListener("keydown", handleKeydown, true);
        cancel.focus({ preventScroll: true });
      } catch (error) {
        ownerDocument.removeEventListener("keydown", handleKeydown, true);
        dialog.remove();
        reject(error);
      }
    });
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

  function setBusyState(control, busy, { manageDisabled = true, busyLabel } = {}) {
    if (!control) return;
    if (busy) control.setAttribute("aria-busy", "true");
    else control.removeAttribute("aria-busy");
    if (manageDisabled) control.disabled = Boolean(busy);
    control.setAttribute("aria-disabled", String(Boolean(control.disabled)));
    if (busy && busyLabel !== undefined) {
      if (!busyControlLabels.has(control)) {
        busyControlLabels.set(control, control.getAttribute("aria-label"));
      }
      control.setAttribute("aria-label", String(busyLabel));
    } else if (!busy && busyControlLabels.has(control)) {
      const label = busyControlLabels.get(control);
      busyControlLabels.delete(control);
      if (label === null) control.removeAttribute("aria-label");
      else control.setAttribute("aria-label", label);
    }
  }

  function prepareDecorativeIcons(scope = document) {
    if (!scope?.querySelectorAll) return;
    for (const icon of scope.querySelectorAll(".kd-icon, .kd-button-icon, svg.icon")) {
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("focusable", "false");
    }
  }

  function createProgress({ root, fill, track, label } = {}) {
    const hide = () => {
      root?.classList.add("kd-hidden");
      root?.setAttribute("aria-hidden", "true");
    };
    const show = ({ value, text }) => {
      const normalized = Math.min(100, Math.max(0, Number(value) || 0));
      if (fill) fill.style.width = `${normalized}%`;
      track?.setAttribute("aria-valuenow", String(normalized));
      if (label && text !== undefined) label.textContent = String(text);
      root?.classList.remove("kd-hidden");
      root?.setAttribute("aria-hidden", "false");
    };
    return Object.freeze({ hide, show });
  }

  globalThis.KDComponents = Object.freeze({
    ACTION_TAG,
    LINKS_DIALOG_TAG,
    createActionElement,
    createLinksDialogElement,
    createProgress,
    createToast,
    confirmAction,
    prepareDecorativeIcons,
    ensureActionElement,
    ensureLinksDialogElement,
    setBusyState,
    setIconButton,
    setSegmentedValue,
    withBusyButton,
  });
})();
