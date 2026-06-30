// content/injector.js - inject page context script and bridge messages between extension and page
(function () {
  try {
    // inject the page script (runs in page context, so it has access to window.fetch & IndexedDB)
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected/creators_page.js');
    s.dataset.extInjected = 'creators';
    (document.documentElement || document.head || document.body).appendChild(s);
  } catch (e) {
    console.error('[Injector] failed to inject page script', e);
  }

  // Bridge messages from background to page script via window.postMessage
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (!message || !message.action) return false;
      // Only handle our creators messages to reduce noise
      if (/^creators\./.test(message.action)) {
        window.postMessage({ direction: 'EXT_TO_PAGE', message }, '*');
        sendResponse && sendResponse({ success: true });
        return true;
      }
    } catch (e) {
      console.error('[Injector] forward message failed', e);
      try { sendResponse && sendResponse({ success: false, error: e.message }); } catch (_) { }
    }
    return false;
  });


  // Bridge messages from page to extension: page sends PAGE_TO_EXT requests via window.postMessage
  window.addEventListener('message', (ev) => {
    try {
      if (!ev || ev.source !== window) return;
      const msg = ev.data;
      if (!msg || msg.direction !== 'PAGE_TO_EXT' || !msg.message) return;
      const m = msg.message;
      if (m.action === 'creators.requestCache' && m.host) {
        const key = `creatorsOverride_${m.host}`;
        chrome.storage.local.get([key], (res) => {
          let payload = null;
          const stored = res && res[key] ? res[key] : null;
          if (stored && typeof stored.__text === 'string') {
            try { payload = JSON.parse(stored.__text); } catch (e) { payload = null; }
          } else if (stored) {
            // backward compatibility for earlier format
            payload = stored;
          }
          window.postMessage({ direction: 'EXT_TO_PAGE', message: { action: 'creators.pushToPage', host: m.host, payload } }, '*');
        });
      } else if (m.action === 'creators.requestSummary') {
        const metaKey = `creatorsOverride_${m.host}_meta`;
        chrome.storage.local.get([metaKey], (res) => {
          const meta = res && res[metaKey] ? res[metaKey] : null;
          window.postMessage({ direction: 'EXT_TO_PAGE', message: { action: 'creators.pushMeta', host: m.host, meta } }, '*');
        });
      }
    } catch (e) {
      console.error('[Injector] page->ext bridge error', e);
    }
  }, false);

})();
