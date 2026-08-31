// Canonical UI component runtime shared by the extension and desktop dashboard.
(function () {
  "use strict";

  const ACTION_TAG = "kd-ui-action";
  const LINKS_DIALOG_TAG = "kd-ui-links-dialog";
  const busyButtons = new WeakMap();
  const componentStyleSheets = new Map();
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
      --kd-content-success: #5c9452;
      --kd-content-success-hover: #6aa660;
      --kd-content-warning: #d19a5b;
      --kd-content-warning-hover: #b87c3d;
      --kd-content-error: #ad5047;
      --kd-content-error-hover: #c15d52;
      --kd-content-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      box-sizing: border-box;
      display: inline-block;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      letter-spacing: 0;
    }

    :host([hidden]) { display: none !important; }

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
      font-weight: 700;
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
      opacity: 0.62;
    }

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
      color: #fff;
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
      color: #d3e6cd;
    }

    :host([variant="creator"][data-status="PARTIAL"]) button {
      border-color: color-mix(in srgb, var(--kd-content-warning) 76%, transparent);
      background: color-mix(in srgb, var(--kd-content-surface) 88%, transparent);
      color: var(--kd-content-warning);
    }

    :host([variant="creator"][data-status="ERROR"]) button {
      border-color: color-mix(in srgb, var(--kd-content-error) 72%, transparent);
      background: color-mix(in srgb, var(--kd-content-surface) 88%, transparent);
      color: #f0c4bd;
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
        --kd-content-success: #4e8445;
        --kd-content-success-hover: #3f7038;
        --kd-content-warning: #8b5e20;
        --kd-content-warning-hover: #704714;
        --kd-content-error: #b0453a;
        --kd-content-error-hover: #96372f;
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
      --kd-content-accent-hover: #3c6868;
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
    a { color: var(--kd-content-accent-hover); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; text-decoration: none; }
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
        --kd-content-accent-hover: #3c6868;
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
      let sheet = componentStyleSheets.get(key);
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText);
        componentStyleSheets.set(key, sheet);
      }
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return;
    }
    const style = document.createElement("style");
    style.textContent = cssText;
    root.appendChild(style);
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
    }

    attributeChangedCallback(name, _oldValue, newValue) {
      this.#syncAttribute(name, newValue);
    }

    setAttribute(name, value) {
      if (String(name).startsWith("aria-") && this.control) {
        this.control.setAttribute(name, String(value));
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
      this.attachShadow({ mode: "open", delegatesFocus: true });
      this._closed = true;
      this._onKeydown = (event) => this.#handleKeydown(event);
    }

    show({ title, description, links, closeLabel, returnFocus = document.activeElement }) {
      const root = this.shadowRoot;
      root.replaceChildren();
      root.adoptedStyleSheets = [];
      appendStyle(root, LINKS_DIALOG_STYLES, "links-dialog");
      this._returnFocus = returnFocus;
      this._closed = false;

      const overlay = document.createElement("div");
      overlay.className = "overlay";
      const dialog = document.createElement("section");
      dialog.className = "dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "kd-links-title");
      dialog.setAttribute("aria-describedby", "kd-links-description");

      const heading = document.createElement("h3");
      heading.id = "kd-links-title";
      heading.textContent = title;
      const copy = document.createElement("p");
      copy.id = "kd-links-description";
      copy.textContent = description;
      const list = document.createElement("ul");
      for (const href of links) {
        const item = document.createElement("li");
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.textContent = href;
        item.appendChild(anchor);
        list.appendChild(item);
      }
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.textContent = closeLabel;
      closeButton.addEventListener("click", () => this.close());
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) this.close();
      });

      dialog.append(heading, copy, list, closeButton);
      overlay.appendChild(dialog);
      root.appendChild(overlay);
      this._dialog = dialog;
      this._closeButton = closeButton;
      document.addEventListener("keydown", this._onKeydown);
      closeButton.focus({ preventScroll: true });
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      document.removeEventListener("keydown", this._onKeydown);
      const returnFocus = this._returnFocus;
      this._returnFocus = null;
      this.remove();
      if (returnFocus?.isConnected && typeof returnFocus.focus === "function") {
        returnFocus.focus({ preventScroll: true });
      }
      this.dispatchEvent(new CustomEvent("kd-close"));
    }

    disconnectedCallback() {
      document.removeEventListener("keydown", this._onKeydown);
      if (this._closed) return;
      this._closed = true;
      const returnFocus = this._returnFocus;
      this._returnFocus = null;
      if (returnFocus?.isConnected && typeof returnFocus.focus === "function") {
        returnFocus.focus({ preventScroll: true });
      }
      this.dispatchEvent(new CustomEvent("kd-close"));
    }

    #handleKeydown(event) {
      if (this._closed) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key !== "Tab" || !this._dialog) return;
      const focusable = Array.from(this._dialog.querySelectorAll("a[href], button:not(:disabled)"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = this.shadowRoot.activeElement;
      if (!this._dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  if (globalThis.customElements && globalThis.HTMLElement && globalThis.document) {
    if (!customElements.get(ACTION_TAG)) customElements.define(ACTION_TAG, KDActionElement);
    if (!customElements.get(LINKS_DIALOG_TAG)) customElements.define(LINKS_DIALOG_TAG, KDLinksDialogElement);
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

  function setBusyState(control, busy, { manageDisabled = true } = {}) {
    if (!control) return;
    if (busy) control.setAttribute("aria-busy", "true");
    else control.removeAttribute("aria-busy");
    if (manageDisabled) control.disabled = Boolean(busy);
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
    createProgress,
    createToast,
    prepareDecorativeIcons,
    setBusyState,
    setIconButton,
    setSegmentedValue,
    withBusyButton,
  });
})();
