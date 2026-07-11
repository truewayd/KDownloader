(function (root) {
  "use strict";

  if (root.KDI18n) return;

  const cache = new Map();
  const api = globalThis.chrome?.i18n;

  function get(key, substitutions, fallback = key) {
    if (!substitutions && cache.has(key)) return cache.get(key);
    const message = api?.getMessage(key, substitutions) || fallback;
    if (!substitutions) cache.set(key, message);
    return message;
  }

  function localize(scope = document) {
    const selectors = ["data-i18n", "data-i18n-placeholder", "data-i18n-title", "data-i18n-aria-label"];
    const nodes = scope.querySelectorAll(selectors.map((name) => `[${name}]`).join(","));
    for (const node of nodes) {
      const textKey = node.dataset.i18n;
      if (textKey) node.textContent = get(textKey, null, node.textContent);
      const placeholderKey = node.dataset.i18nPlaceholder;
      if (placeholderKey) node.placeholder = get(placeholderKey, null, node.placeholder);
      const titleKey = node.dataset.i18nTitle;
      if (titleKey) node.title = get(titleKey, null, node.title);
      const ariaKey = node.dataset.i18nAriaLabel;
      if (ariaKey) node.setAttribute("aria-label", get(ariaKey, null, node.getAttribute("aria-label")));
    }
    const language = api?.getUILanguage?.();
    if (language && scope === document) document.documentElement.lang = language;
  }

  root.KDI18n = Object.freeze({ get, localize });
})(globalThis);
