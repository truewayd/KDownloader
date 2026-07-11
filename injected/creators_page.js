// injected/creators_page.js - page-context script: site IndexedDB storage + fetch/XHR interception + startup pull
(function () {
  try {
    const DB_NAME = 'ext_creators_db_v1';
    const STORE_NAME = 'creators';
    let dbPromise = null;
    let dbInstance = null;

    function openDB() {
      if (dbPromise) return dbPromise;
      if (dbInstance) return Promise.resolve(dbInstance);
      dbPromise = new Promise((resolve, reject) => {
        try {
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = function (e) {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              db.createObjectStore(STORE_NAME, { keyPath: 'host' });
            }
          };
          req.onsuccess = function (e) {
            dbInstance = e.target.result;
            dbInstance.onclose = function () {
              dbInstance = null;
              dbPromise = null;
            };
            dbInstance.onversionchange = function () {
              try { dbInstance.close(); } catch (_) { }
              dbInstance = null;
              dbPromise = null;
            };
            resolve(dbInstance);
          };
          req.onerror = function (e) {
            dbPromise = null;
            reject(e.target.error || new Error('indexedDB open failed'));
          };
        } catch (err) {
          dbPromise = null;
          reject(err);
        }
      });
      return dbPromise;
    }

    function closeDB() {
      if (!dbInstance) return;
      try { dbInstance.close(); } catch (_) { }
      dbInstance = null;
      dbPromise = null;
    }

    window.addEventListener('pagehide', closeDB, { once: true });

    async function writeCache(host, payload) {
      const db = await openDB();
      const data = payload && payload.data ? payload.data : payload;
      const updatedAt = payload && payload.updatedAt ? payload.updatedAt : Date.now();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const rec = { host, updatedAt, data };
        const r = store.put(rec);
        r.onsuccess = () => resolve(true);
        r.onerror = (e) => reject(e.target && e.target.error ? e.target.error : new Error('put failed'));
      });
    }

    async function readCache(host) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const r = store.get(host);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = (e) => reject(e.target && e.target.error ? e.target.error : new Error('get failed'));
      });
    }

    // Listen to EXT_TO_PAGE (content/injector bridge)
    window.addEventListener('message', async (ev) => {
      const msg = ev.data;
      if (!msg || msg.direction !== 'EXT_TO_PAGE' || !msg.message) return;
      const m = msg.message;
      if (m.action === 'creators.pushToPage' && m.host && m.payload) {
        try { await writeCache(m.host, m.payload); } catch (_) { }
      } else if (m.action === 'creators.pushMeta' && m.host && m.meta) {
        // optional: meta only; nothing to persist
      }
    }, false);

    // Startup active pull (retry a few times)
    (function startupPull() {
      const host = location.hostname;
      let attempts = 0;
      const maxAttempts = 6;
      function requestOnce() {
        try { window.postMessage({ direction: 'PAGE_TO_EXT', message: { action: 'creators.requestCache', host } }, '*'); } catch (_) { }
        attempts++;
      }
      requestOnce();
      const id = setInterval(() => {
        if (attempts >= maxAttempts) {
          clearInterval(id);
          try { window.postMessage({ direction: 'PAGE_TO_EXT', message: { action: 'creators.requestSummary', host } }, '*'); } catch (_) { }
          return;
        }
        requestOnce();
      }, 800);
    })();

    // Local constants for injected script to avoid coupling to extension constants
    const API_PREFIX = '/api/v1';
    const CREATORS_PATH = '/creators';

    // Intercept fetch
    (function () {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
          if (url && url.indexOf(API_PREFIX + CREATORS_PATH) !== -1) {
            let host;
            try { host = /^https?:\/\//i.test(url) ? new URL(url).hostname : location.hostname; } catch (_) { host = location.hostname; }
            const cached = await readCache(host);
            if (cached && cached.data) {
              const body = JSON.stringify(cached.data);
              const headers = new Headers({ 'Content-Type': 'application/json' });
              return new Response(body, { status: 200, headers });
            }
          }
        } catch (_) { }
        return originalFetch(input, init);
      };
    })();

    // Intercept XHR
    (function () {
      try {
        const XHR = window.XMLHttpRequest;
        function FakeXHR() {
          const xhr = new XHR();
          let _url = null;
          const _open = xhr.open;
          xhr.open = function (method, url) { _url = url; return _open.apply(xhr, arguments); };
          const _send = xhr.send;
          xhr.send = function (body) {
            try {
              if (_url && _url.indexOf(API_PREFIX + CREATORS_PATH) !== -1) {
                let host;
                try { host = /^https?:\/\//i.test(_url) ? new URL(_url).hostname : location.hostname; } catch (_) { host = location.hostname; }
                readCache(host).then(cached => {
                  if (cached && cached.data) {
                    try {
                      xhr.readyState = 4; xhr.status = 200; xhr.responseText = JSON.stringify(cached.data);
                      if (typeof xhr.onload === 'function') xhr.onload();
                    } catch (_) { }
                    return;
                  }
                  _send.apply(xhr, arguments);
                }).catch(() => { _send.apply(xhr, arguments); });
                return;
              }
            } catch (_) { }
            return _send.apply(xhr, arguments);
          };
          return xhr;
        }
        window.XMLHttpRequest = FakeXHR;
      } catch (_) { }
    })();

  } catch (_) { }
})();
