import { LINK_HISTORY_DB } from './constants.js';

let opening;
function openDatabase() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(LINK_HISTORY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('links', { keyPath: 'url' });
    request.onerror = () => { opening = undefined; reject(request.error); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
  });
  return opening;
}

// A keyless MEGA link is a source clue, never a completed extraction identity.
export function completeLinkKey(value) {
  if (typeof value !== 'string' || value.length > 8192) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    if (['mega.nz', 'www.mega.nz', 'mega.co.nz', 'www.mega.co.nz'].includes(url.hostname)) {
      const modern = (/^\/file\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && /^#[A-Za-z0-9_-]{43}$/.test(url.hash))
        || (/^\/folder\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && /^#[A-Za-z0-9_-]{22}(?:\/.*)?$/.test(url.hash));
      const legacy = /^#![A-Za-z0-9_-]+![A-Za-z0-9_-]{43}$/.test(url.hash)
        || /^#F![A-Za-z0-9_-]+![A-Za-z0-9_-]{22}(?:!.*)?$/.test(url.hash);
      if (!modern && !legacy) return '';
    }
    return url.toString();
  } catch { return ''; }
}

export async function readLinkRecords(values) {
  const keys = [...new Set(values.map(completeLinkKey).filter(Boolean))];
  if (keys.length > 5000) throw new Error('Too many external links');
  if (!keys.length) return {};
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('links', 'readonly');
    const found = {};
    for (const key of keys) {
      const request = tx.objectStore('links').get(key);
      request.onsuccess = () => { if (request.result) found[key] = request.result; };
    }
    tx.oncomplete = () => resolve(found);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Cannot read link history'));
  });
}

export async function writeLinkRecords(values, status = 'extracted') {
  if (!['extracted', 'accepted', 'failed', 'manual', 'remove'].includes(status)) throw new Error('Invalid link status');
  if (!Array.isArray(values) || values.length > 5000) throw new Error('Too many external links');
  const keys = [...new Set(values.map(completeLinkKey).filter(Boolean))];
  if (!keys.length) return { count: 0 };
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('links', 'readwrite');
    const store = tx.objectStore('links');
    for (const url of keys) {
      if (status === 'remove') store.delete(url);
      else {
        const read = store.get(url);
        read.onsuccess = () => {
          // A TXT declaration must not erase a known backend outcome.
          if (status === 'extracted' && read.result) return;
          store.put({ url, status, updatedAt: Date.now() });
        };
      }
    }
    tx.oncomplete = () => resolve({ count: keys.length });
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Cannot save link history'));
  });
}
