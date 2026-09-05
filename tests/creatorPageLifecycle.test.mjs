import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../injected/creators_page.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  const nativeSends = [];
  const stateRequests = [];
  const openRequests = [];
  class FakeXHR extends EventTarget {
    responseType = '';
    open(method, url) { this.nativeUrl = url; }
    send() { nativeSends.push(this.nativeUrl); }
    abort() {}
  }
  const window = new EventTarget();
  window.XMLHttpRequest = FakeXHR;
  window.fetch = async () => ({ network: true });
  window.postMessage = (message) => stateRequests.push(message);
  const context = vm.createContext({
    window, console, Event, ProgressEvent: Event, DOMException, Request, Response, URL,
    location: { hostname: 'kemono.cr', origin: 'https://kemono.cr', href: 'https://kemono.cr/artists' },
    indexedDB: { open() { const request = {}; openRequests.push(request); return request; } },
    setInterval: () => 0,
    clearInterval() {},
  });
  vm.runInContext(source.replace('  const XHR = window.XMLHttpRequest;', `
    globalThis.bridge = {
      enable() { overrideEnabled = true; },
      setReadCache(value) { readCache = value; },
      openDB,
    };
    const XHR = window.XMLHttpRequest;`), context);
  return { window, nativeSends, stateRequests, openRequests, bridge: context.bridge };
}

for (const outcome of ['hit', 'miss', 'failure']) {
  test(`reopening a creator XHR discards its pending cache ${outcome}`, async () => {
    const h = harness();
    let resolveCache;
    let rejectCache;
    h.bridge.enable();
    h.bridge.setReadCache(() => new Promise((resolve, reject) => {
      resolveCache = resolve;
      rejectCache = reject;
    }));
    const xhr = new h.window.XMLHttpRequest();
    let loads = 0;
    xhr.addEventListener('load', () => loads++);
    xhr.open('GET', '/api/v1/creators');
    xhr.send();
    xhr.open('GET', '/api/v1/posts');
    xhr.send();
    if (outcome === 'failure') rejectCache(new Error('cache unavailable'));
    else resolveCache(outcome === 'hit' ? { data: ['old creators'] } : null);
    await settle();
    assert.deepEqual(h.nativeSends, ['/api/v1/posts']);
    assert.equal(Object.hasOwn(xhr, 'responseText'), false);
    assert.equal(loads, 0);
  });
}

for (const action of ['abort', 'open']) {
  test(`creator XHR loadstart ${action} prevents a stale synthetic response`, async () => {
    const h = harness();
    h.bridge.enable();
    h.bridge.setReadCache(async () => ({ data: ['cached'] }));
    const xhr = new h.window.XMLHttpRequest();
    xhr.addEventListener('loadstart', () => {
      if (action === 'abort') xhr.abort();
      else { xhr.open('GET', '/api/v1/posts'); xhr.send(); }
    });
    let loads = 0;
    xhr.addEventListener('load', () => loads++);
    xhr.open('GET', '/api/v1/creators');
    xhr.send();
    await settle();
    assert.equal(Object.hasOwn(xhr, 'responseText'), false);
    assert.equal(loads, 0);
    assert.deepEqual(h.nativeSends, action === 'open' ? ['/api/v1/posts'] : []);
  });
}

test('creator XHR ready-state listeners may reopen without receiving obsolete load events', async () => {
  const h = harness();
  h.bridge.enable();
  h.bridge.setReadCache(async () => ({ data: ['cached'] }));
  const xhr = new h.window.XMLHttpRequest();
  let loads = 0;
  xhr.addEventListener('readystatechange', () => {
    xhr.open('GET', '/api/v1/posts');
    xhr.send();
  });
  xhr.addEventListener('load', () => loads++);
  xhr.open('GET', '/api/v1/creators');
  xhr.send();
  await settle();
  assert.equal(loads, 0);
  assert.equal(Object.hasOwn(xhr, 'responseText'), false);
  assert.deepEqual(h.nativeSends, ['/api/v1/posts']);
});

test('pagehide cannot let an old IndexedDB open replace a newer connection', async () => {
  const h = harness();
  const pending = h.bridge.openDB();
  h.window.dispatchEvent(new Event('pagehide'));
  const fresh = h.bridge.openDB();
  const oldDB = { closed: false, close() { this.closed = true; } };
  const freshDB = { close() {} };
  Object.assign(h.openRequests[1], { result: freshDB });
  h.openRequests[1].onsuccess();
  assert.equal(await fresh, freshDB);
  Object.assign(h.openRequests[0], { result: oldDB });
  h.openRequests[0].onsuccess();
  await assert.rejects(pending, /connection closed/);
  assert.equal(oldDB.closed, true);
  assert.equal(await h.bridge.openDB(), freshDB);
});

test('restoring a page from bfcache asks for current creator override state', async () => {
  const h = harness();
  h.bridge.enable();
  h.bridge.setReadCache(async () => ({ data: ['cached'] }));
  h.window.dispatchEvent(new Event('pagehide'));
  assert.equal((await h.window.fetch('/api/v1/creators')).network, true);
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  h.window.dispatchEvent(event);
  assert.equal(h.stateRequests.length, 2);
  assert.equal(h.stateRequests[1].message.action, 'creators.requestState');
});
