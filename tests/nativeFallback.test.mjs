import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const stored = {};
const created = [];
const cleared = [];

const fallbackChrome = {
  i18n: {
    getMessage(key, substitutions) {
      return `${key}:${Array.isArray(substitutions) ? substitutions.join('|') : ''}`;
    },
  },
  notifications: {
    create(id, options, callback) {
      created.push({ id, options });
      callback(id);
    },
    clear(id, callback) {
      cleared.push(id);
      callback(true);
    },
  },
  runtime: {
    lastError: null,
    getURL(path) {
      return `chrome-extension://test/${path}`;
    },
  },
  storage: {
    session: {
      async get(key) {
        return Object.hasOwn(stored, key) ? { [key]: structuredClone(stored[key]) } : {};
      },
      async set(values) {
        Object.assign(stored, structuredClone(values));
      },
      async remove(key) {
        delete stored[key];
      },
    },
  },
};

globalThis.chrome = fallbackChrome;

const root = path.resolve(import.meta.dirname, '..');
const asModuleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const constantsUrl = asModuleUrl(await readFile(path.join(root, 'background', 'constants.js'), 'utf8'));
const source = (await readFile(path.join(root, 'background', 'nativeFallback.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`);
const moduleUrl = asModuleUrl(source);
const fallback = await import(moduleUrl);

beforeEach(() => {
  globalThis.chrome = fallbackChrome;
  for (const key of Object.keys(stored)) delete stored[key];
  created.length = 0;
  cleared.length = 0;
});

function request(postId, taskCount = 1) {
  return {
    item: { source: 'default', service: 'patreon', userId: 'creator-1', postId },
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      url: `https://file.pawchive.pw/data/${postId}/${index}`,
      fileName: `${postId}-${index}.jpg`,
      type: 'attachment',
    })),
    externalLinks: [],
    tabId: 3,
  };
}

test('backend failures create one persistent two-button notification for a batch', async () => {
  const id = await fallback.enqueueNativeFallback([request('post-1', 2), request('post-2', 1)]);
  assert.equal(created.length, 1);
  assert.equal(created[0].id, id);
  assert.match(created[0].options.message, /^nativeFallbackMessage:3$/);
  assert.deepEqual(created[0].options.buttons.map((button) => button.title), [
    'continueDownloadAction:',
    'cancelDownloadAction:',
  ]);
  assert.equal(created[0].options.requireInteraction, true);
  assert.equal(stored.pendingNativeFallbacks[id].requests.length, 2);
});

test('taking a fallback decision is atomic and removes its session entry', async () => {
  const id = await fallback.enqueueNativeFallback(request('post-1'));
  const pending = await fallback.takeNativeFallback(id);
  assert.equal(pending.requests[0].item.postId, 'post-1');
  assert.equal(await fallback.takeNativeFallback(id), null);
  assert.equal(stored.pendingNativeFallbacks, undefined);

  await fallback.clearNativeFallbackNotification(id);
  assert.deepEqual(cleared, [id]);
});

test('legacy Pawchive fallback items rejoin the shared default history source', async () => {
  const legacy = request('legacy-paw-source');
  legacy.item.source = 'pawchive';
  const id = await fallback.enqueueNativeFallback(legacy);
  const pending = await fallback.takeNativeFallback(id);
  assert.equal(pending.requests[0].item.source, 'default');
});

test('fallback prompts reject empty or malformed task sets', async () => {
  await assert.rejects(fallback.enqueueNativeFallback({
    item: { service: 'patreon', userId: 'creator-1', postId: 'post-1' },
    tasks: [],
  }), /No native fallback tasks/);
  assert.equal(created.length, 0);
});

test('fallback tasks preserve request correlation and reject unsafe URLs', async () => {
  const correlated = request('post-1');
  correlated.item.requestId = 'request-123';
  const id = await fallback.enqueueNativeFallback(correlated);
  assert.equal(stored.pendingNativeFallbacks[id].requests[0].item.requestId, 'request-123');

  const unsafe = request('post-2');
  unsafe.tasks[0].url = 'file:///sensitive.txt';
  await assert.rejects(fallback.enqueueNativeFallback(unsafe), /No native fallback tasks/);
});

test('expired fallback decisions are discarded instead of starting stale downloads', async () => {
  const id = await fallback.enqueueNativeFallback(request('old-post'));
  stored.pendingNativeFallbacks[id].createdAt = Date.now() - 61 * 60 * 1000;
  assert.equal(await fallback.takeNativeFallback(id), null);
  assert.equal(stored.pendingNativeFallbacks, undefined);
});

test('pending fallback task limits apply across notifications', async () => {
  await fallback.enqueueNativeFallback([
    request('first-a', 1000),
    request('first-b', 1000),
    request('first-c', 1000),
  ]);
  await assert.rejects(fallback.enqueueNativeFallback([
    request('second-a', 1000),
    request('second-b', 1000),
    request('second-c', 1),
  ]), /pending native fallback tasks/);
  assert.equal(created.length, 1);
});

test('fallback state rejects oversized serialized task payloads before storage', async () => {
  const oversized = request('oversized', 1000);
  for (const task of oversized.tasks) {
    task.url = `https://file.pawchive.pw/data/${'x'.repeat(8140)}`;
    task.fileName = `${'n'.repeat(1020)}.jpg`;
  }
  await assert.rejects(fallback.enqueueNativeFallback(oversized), /8 MiB safety limit/);
  assert.equal(created.length, 0);
  assert.equal(stored.pendingNativeFallbacks, undefined);
});

test('a per-request task overflow is rejected instead of silently truncated', async () => {
  await assert.rejects(
    fallback.enqueueNativeFallback(request('too-many', 1001)),
    /exceeds 1000 tasks/
  );
  assert.equal(created.length, 0);
  assert.equal(stored.pendingNativeFallbacks, undefined);
});
