// content/injector.js - creator-cache bridge between extension and page contexts
(() => {
  const TARGET_HOSTS = new Set(['coomer.st', 'kemono.cr']);
  const ENABLED_KEY = 'creatorsOverrideEnabled';
  const host = location.hostname.toLowerCase();
  if (!TARGET_HOSTS.has(host)) return;

  function postState(enabled, payload = null) {
    window.postMessage({
      direction: 'EXT_TO_PAGE',
      message: {
        action: 'creators.state',
        host,
        enabled: enabled === true,
        payload: enabled === true ? payload : null,
      },
    }, location.origin);
  }

  function readAndPostState() {
    const key = `creatorsOverride_${host}`;
    chrome.storage.local.get([ENABLED_KEY, key], (stored) => {
      if (chrome.runtime.lastError) {
        postState(false);
        return;
      }
      const enabled = stored?.[ENABLED_KEY] === true;
      const cached = stored?.[key] || null;
      let payload = null;
      if (enabled && cached && typeof cached.__text === 'string') {
        try {
          payload = JSON.parse(cached.__text);
        } catch (error) {
          payload = null;
        }
      } else if (enabled && cached && typeof cached === 'object') {
        payload = cached;
      }
      postState(enabled, payload);
    });
  }

  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected/creators_page.js');
    script.dataset.extInjected = 'creators';
    script.addEventListener('load', () => script.remove(), { once: true });
    script.addEventListener('error', () => script.remove(), { once: true });
    (document.documentElement || document.head || document.body).appendChild(script);
  } catch (error) {
    console.error('[Injector] failed to inject creator cache script', error);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data?.message;
    if (event.data?.direction !== 'PAGE_TO_EXT' || message?.action !== 'creators.requestState') return;
    if (String(message.host || '').toLowerCase() !== host) return;
    readAndPostState();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[ENABLED_KEY] || changes[`creatorsOverride_${host}`]) readAndPostState();
  });
})();
