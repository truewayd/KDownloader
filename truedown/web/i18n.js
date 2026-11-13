/* Shared by the main document and retained auxiliary WebViews. */
(() => {
  'use strict';
  const key = 'truedown-language-v1';
  const supported = new Set(['system', 'zh-CN', 'en']);
  const normalize = value => supported.has(value) ? value : 'system';
  let preference = 'system';
  try { preference = normalize(localStorage.getItem(key)); } catch (_) { }
  const language = () => preference === 'system'
    ? (/^zh\b/i.test(navigator.language || '') ? 'zh-CN' : 'en') : preference;
  const originals = new WeakMap();
  // User-owned names, links, diagnostics and preview payloads remain literal.
  const protectedSelector = 'script,style,textarea,pre,code,[contenteditable],.kd-selectable,.task-name,.task-link,.task-path,.task-detail-value,.detail-value,#preview-stage,#preview-content,#preview-text,#logs-content,#app-log-content,.task-file-name,.task-info-value,[data-i18n-ignore]';
  const attributes = ['title', 'aria-label', 'placeholder', 'data-tooltip', 'data-kd-notice-title'];
  const messages = window.TrueDownEnglish || {};
  const templates = Object.entries(messages).filter(([key]) => /\{\d+\}/.test(key))
    .sort(([a], [b]) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length)
    .map(([key, output]) => {
      const indices = [];
      const pattern = key.split(/(\{\d+\})/).map(part => {
        if (/^\{\d+\}$/.test(part)) { indices.push(part.slice(1, -1)); return '(.*?)'; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      return { pattern: new RegExp(`^${pattern}$`), indices, output };
    });
  function english(value) {
    if (Object.hasOwn(messages, value)) return messages[value];
    if (value.length > 4096 || !/[\u4e00-\u9fff]/.test(value)) return value;
    for (const template of templates) {
      const match = template.pattern.exec(value);
      if (!match) continue;
      const values = Object.fromEntries(template.indices.map((index, offset) => [index, match[offset + 1]]));
      return template.output.replace(/\{(\d+)\}/g, (_, index) => messages[values[index]] || values[index]);
    }
    return value;
  }
  function translate(value) {
    const trimmed = value.trim();
    return value.replace(trimmed, language() === 'en' ? english(trimmed) : trimmed);
  }
  function update(node, field, read, write) {
    const current = read();
    let fields = originals.get(node);
    if (!fields) { fields = new Map(); originals.set(node, fields); }
    const previous = fields.get(field);
    const source = previous && current === previous.output ? previous.source : current;
    const output = translate(source);
    fields.set(field, { source, output });
    if (current !== output) write(output);
  }
  function localize(root = document.body) {
    if (!root) return;
    if (root.nodeType === 3) {
      if (!root.parentElement?.closest(protectedSelector)) update(root, 'text', () => root.nodeValue, value => { root.nodeValue = value; });
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1 && root.closest(protectedSelector)) return;
    if (root.nodeType === 1) {
      for (const attr of attributes) if (root.hasAttribute(attr)) update(root, attr, () => root.getAttribute(attr), value => root.setAttribute(attr, value));
      // Native selects also carry their accessible name in a generated button.
    }
    for (const child of root.childNodes) localize(child);
  }
  function apply() {
    document.documentElement.lang = language();
    localize(document.body);
    localize(document.querySelector?.("title"));
    const select = document.getElementById('application-language');
    if (select) select.value = preference;
  }
  function setLanguage(value) {
    const next = normalize(value);
    // Persist first: failed storage writes must not claim a saved preference.
    localStorage.setItem(key, next);
    preference = next;
    apply();
    window.dispatchEvent(new CustomEvent('truedown:language-changed', { detail: language() }));
  }
  window.TrueDownI18n = Object.freeze({ get language() { return language(); }, get preference() { return preference; }, t: translate, localize, setLanguage });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList') for (const node of record.addedNodes) localize(node);
        else localize(record.target);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });
    document.getElementById('application-language')?.addEventListener('change', event => {
      try { setLanguage(event.target.value); }
      catch (error) { event.target.value = preference; window.showToast?.(error.message, 'error'); }
    });
  });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = normalize(event.newValue); apply(); }
  });
})();
