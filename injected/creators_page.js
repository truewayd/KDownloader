// injected/creators_page.js - page-context creator cache interception
(() => {
  const DB_NAME = 'ext_creators_db_v1';
  const STORE_NAME = 'creators';
  const API_PATH = '/api/v1/creators';
  const TARGET_HOSTS = new Set(['coomer.st', 'kemono.cr']);
  const host = location.hostname.toLowerCase();
  if (!TARGET_HOSTS.has(host)) return;
  const INSTALL_KEY = '__kdCreatorsPageInstalledV1';
  if (window[INSTALL_KEY]) return;
  Object.defineProperty(window, INSTALL_KEY, { value: true, configurable: false });

  let dbPromise = null;
  let dbInstance = null;
  let dbOpenSequence = 0;
  let overrideEnabled = false;
  let stateReceived = false;
  let stateRequestTimer = 0;
  let stateSequence = 0;
  let cacheWritePromise = Promise.resolve();

  function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    if (dbPromise) return dbPromise;
    const sequence = ++dbOpenSequence;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'host' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (sequence !== dbOpenSequence) {
          db.close();
          reject(new Error('Creator cache connection closed'));
          return;
        }
        dbInstance = db;
        const release = () => {
          if (dbInstance !== db) return;
          dbInstance = null;
          dbPromise = null;
        };
        db.onclose = release;
        db.onversionchange = () => {
          db.close();
          release();
        };
        resolve(db);
      };
      request.onerror = () => {
        if (sequence === dbOpenSequence) dbPromise = null;
        reject(request.error || new Error('indexedDB open failed'));
      };
    });
    return dbPromise;
  }

  function closeDB() {
    stateSequence++;
    dbOpenSequence++;
    overrideEnabled = false;
    stateReceived = false;
    if (stateRequestTimer) clearInterval(stateRequestTimer);
    stateRequestTimer = 0;
    const pending = dbPromise;
    dbInstance?.close();
    dbInstance = null;
    dbPromise = null;
    pending?.then((db) => db.close()).catch(() => {});
  }

  function transactionRequest(mode, work) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      let request;
      let result = null;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(transaction.error || request?.error || new Error('creator cache transaction failed'));
      };
      try {
        request = work(transaction.objectStore(STORE_NAME));
      } catch (error) {
        reject(error);
        return;
      }
      request.onsuccess = () => { result = request.result ?? null; };
      request.onerror = fail;
      transaction.onerror = fail;
      transaction.onabort = fail;
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
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

  function createAbortError(signal) {
    if (signal && 'reason' in signal && signal.reason !== undefined) return signal.reason;
    try {
      return new DOMException('The operation was aborted.', 'AbortError');
    } catch (error) {
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      return abortError;
    }
  }

  window.addEventListener('pagehide', closeDB);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) requestState();
  });
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data?.message;
    if (event.data?.direction !== 'EXT_TO_PAGE' || message?.action !== 'creators.state') return;
    if (String(message.host || '').toLowerCase() !== host) return;
    stateReceived = true;
    overrideEnabled = message.enabled === true;
    const sequence = ++stateSequence;
    if (stateRequestTimer) clearInterval(stateRequestTimer);
    stateRequestTimer = 0;
    if (overrideEnabled && message.payload) {
      cacheWritePromise = cacheWritePromise
        .catch(() => {})
        .then(() => {
          if (!overrideEnabled || sequence !== stateSequence) return false;
          return writeCache(message.payload);
        });
    }
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
    let method = 'GET';
    try {
      method = String(
        init?.method
        || (typeof Request === 'function' && input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
    } catch (error) {
      return originalFetch(input, init);
    }
    const hasBody = init?.body != null
      || (typeof Request === 'function' && input instanceof Request && input.body != null);
    if (overrideEnabled && method === 'GET' && !hasBody && creatorRequestUrl(input)) {
      const interceptionSequence = stateSequence;
      const signal = init?.signal
        || (typeof Request === 'function' && input instanceof Request ? input.signal : null);
      if (signal?.aborted) throw createAbortError(signal);
      let cached = null;
      try {
        cached = await readCache();
      } catch (error) {
        // Fall through to the site's request after checking cancellation.
      }
      if (signal?.aborted) throw createAbortError(signal);
      if (!overrideEnabled || interceptionSequence !== stateSequence) {
        return originalFetch(input, init);
      }
      if (cached?.data) {
        try {
          return new Response(JSON.stringify(cached.data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          if (signal?.aborted) throw createAbortError(signal);
          // Fall through to the site's request for unserializable cache data.
        }
      }
    }
    return originalFetch(input, init);
  };

  const XHR = window.XMLHttpRequest;
  if (!XHR?.prototype) return;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  const originalAbort = XHR.prototype.abort;
  const requestMeta = new WeakMap();
  const SYNTHETIC_PROPERTIES = [
    'readyState',
    'status',
    'statusText',
    'responseText',
    'response',
    'responseURL',
    'getResponseHeader',
    'getAllResponseHeaders',
  ];

  function clearSyntheticProperties(xhr) {
    for (const property of SYNTHETIC_PROPERTIES) {
      try {
        delete xhr[property];
      } catch (error) {
        /* Ignore host-object cleanup failures and let native open decide. */
      }
    }
  }

  XHR.prototype.open = function (method, url, asyncFlag) {
    clearSyntheticProperties(this);
    const result = originalOpen.apply(this, arguments);
    const previous = requestMeta.get(this);
    if (previous) previous.aborted = true;
    requestMeta.set(this, {
      method: String(method || 'GET').toUpperCase(),
      url,
      async: asyncFlag === undefined ? true : Boolean(asyncFlag),
      aborted: false,
      dispatched: false,
      pending: false,
      syntheticComplete: false,
    });
    return result;
  };

  XHR.prototype.send = function (body) {
    const xhr = this;
    const meta = requestMeta.get(xhr);
    if (meta?.pending || meta?.dispatched) {
      throw new DOMException('The object is in an invalid state.', 'InvalidStateError');
    }
    if (!overrideEnabled
      || meta?.method !== 'GET'
      || meta.async === false
      || body != null
      || (xhr.responseType && xhr.responseType !== 'text' && xhr.responseType !== 'json')
      || !creatorRequestUrl(meta.url)) {
      if (meta) meta.dispatched = true;
      return originalSend.call(xhr, body);
    }

    meta.pending = true;
    const interceptionSequence = stateSequence;
    const isCurrent = () => requestMeta.get(xhr) === meta && !meta.aborted;
    const sendOriginal = () => {
      if (!isCurrent() || meta.dispatched) return;
      meta.pending = false;
      meta.dispatched = true;
      originalSend.call(xhr, body);
    };
    readCache().then((cached) => {
      if (!isCurrent()) return;
      if (!overrideEnabled || interceptionSequence !== stateSequence || !cached?.data) {
        sendOriginal();
        return;
      }
      const responseText = JSON.stringify(cached.data);
      const response = xhr.responseType === 'json' ? cached.data : responseText;
      try {
        xhr.dispatchEvent(new ProgressEvent('loadstart'));
        if (!isCurrent()) return;
        if (!overrideEnabled || interceptionSequence !== stateSequence) {
          sendOriginal();
          return;
        }
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
        meta.pending = false;
        meta.dispatched = true;
        meta.syntheticComplete = true;
        xhr.dispatchEvent(new Event('readystatechange'));
        if (!isCurrent()) return;
        xhr.dispatchEvent(new ProgressEvent('load', { loaded: responseText.length, total: responseText.length }));
        if (!isCurrent()) return;
        xhr.dispatchEvent(new ProgressEvent('loadend', { loaded: responseText.length, total: responseText.length }));
      } catch (error) {
        sendOriginal();
      }
    }).catch(sendOriginal);
  };

  XHR.prototype.abort = function () {
    const meta = requestMeta.get(this);
    if (meta?.syntheticComplete) return;
    if (meta) {
      meta.aborted = true;
      meta.pending = false;
    }
    return originalAbort.apply(this, arguments);
  };
})();
