// injected/creators_page.js - page-context creator cache interception
(() => {
  const DB_NAME = 'ext_creators_db_v1';
  const STORE_NAME = 'creators';
  const API_PATH = '/api/v1/creators';
  const TARGET_HOSTS = new Set(['coomer.st', 'kemono.cr']);
  const host = location.hostname.toLowerCase();
  if (!TARGET_HOSTS.has(host)) return;

  let dbPromise = null;
  let dbInstance = null;
  let overrideEnabled = false;
  let stateReceived = false;
  let stateRequestTimer = 0;

  function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'host' });
        }
      };
      request.onsuccess = () => {
        dbInstance = request.result;
        dbInstance.onclose = () => {
          dbInstance = null;
          dbPromise = null;
        };
        dbInstance.onversionchange = () => {
          dbInstance.close();
          dbInstance = null;
          dbPromise = null;
        };
        resolve(dbInstance);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('indexedDB open failed'));
      };
    });
    return dbPromise;
  }

  function closeDB() {
    if (stateRequestTimer) clearInterval(stateRequestTimer);
    stateRequestTimer = 0;
    dbInstance?.close();
    dbInstance = null;
    dbPromise = null;
  }

  function transactionRequest(mode, work) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = work(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('creator cache transaction failed'));
    }));
  }

  function writeCache(payload) {
    const data = payload?.data ?? payload;
    if (!data || typeof data !== 'object') return Promise.resolve(false);
    return transactionRequest('readwrite', (store) => store.put({
      host,
      updatedAt: Number(payload?.updatedAt) || Date.now(),
      data,
    })).then(() => true);
  }

  function readCache() {
    if (!overrideEnabled) return Promise.resolve(null);
    return transactionRequest('readonly', (store) => store.get(host));
  }

  function creatorRequestUrl(value) {
    try {
      const raw = typeof value === 'string' ? value : value?.url;
      const url = new URL(String(raw || ''), location.href);
      if (url.origin !== location.origin) return null;
      if (url.pathname !== API_PATH && url.pathname !== `${API_PATH}/`) return null;
      return url;
    } catch (error) {
      return null;
    }
  }

  function requestState() {
    window.postMessage({
      direction: 'PAGE_TO_EXT',
      message: { action: 'creators.requestState', host },
    }, location.origin);
  }

  window.addEventListener('pagehide', closeDB, { once: true });
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data?.message;
    if (event.data?.direction !== 'EXT_TO_PAGE' || message?.action !== 'creators.state') return;
    if (String(message.host || '').toLowerCase() !== host) return;
    stateReceived = true;
    overrideEnabled = message.enabled === true;
    if (stateRequestTimer) clearInterval(stateRequestTimer);
    stateRequestTimer = 0;
    if (overrideEnabled && message.payload) writeCache(message.payload).catch(() => {});
  });

  requestState();
  let attempts = 1;
  stateRequestTimer = setInterval(() => {
    if (stateReceived || attempts >= 6) {
      clearInterval(stateRequestTimer);
      stateRequestTimer = 0;
      return;
    }
    attempts += 1;
    requestState();
  }, 800);

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    if (overrideEnabled && creatorRequestUrl(input)) {
      try {
        const cached = await readCache();
        if (cached?.data) {
          return new Response(JSON.stringify(cached.data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      } catch (error) {
        // Fall through to the site's request.
      }
    }
    return originalFetch(input, init);
  };

  const XHR = window.XMLHttpRequest;
  if (!XHR?.prototype) return;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  const requestMeta = new WeakMap();

  XHR.prototype.open = function (method, url) {
    requestMeta.set(this, { method: String(method || 'GET').toUpperCase(), url });
    return originalOpen.apply(this, arguments);
  };

  XHR.prototype.send = function (body) {
    const xhr = this;
    const meta = requestMeta.get(xhr);
    if (!overrideEnabled || meta?.method !== 'GET' || !creatorRequestUrl(meta.url)) {
      return originalSend.call(xhr, body);
    }

    readCache().then((cached) => {
      if (!cached?.data) {
        originalSend.call(xhr, body);
        return;
      }
      const responseText = JSON.stringify(cached.data);
      const response = xhr.responseType === 'json' ? cached.data : responseText;
      try {
        Object.defineProperties(xhr, {
          readyState: { configurable: true, get: () => 4 },
          status: { configurable: true, get: () => 200 },
          statusText: { configurable: true, get: () => 'OK' },
          responseText: { configurable: true, get: () => responseText },
          response: { configurable: true, get: () => response },
          responseURL: { configurable: true, get: () => creatorRequestUrl(meta.url).toString() },
          getResponseHeader: {
            configurable: true,
            value: (name) => String(name).toLowerCase() === 'content-type' ? 'application/json' : null,
          },
          getAllResponseHeaders: {
            configurable: true,
            value: () => 'content-type: application/json\r\n',
          },
        });
        xhr.dispatchEvent(new Event('readystatechange'));
        xhr.dispatchEvent(new ProgressEvent('load', { loaded: responseText.length, total: responseText.length }));
        xhr.dispatchEvent(new ProgressEvent('loadend', { loaded: responseText.length, total: responseText.length }));
      } catch (error) {
        originalSend.call(xhr, body);
      }
    }).catch(() => originalSend.call(xhr, body));
  };
})();
