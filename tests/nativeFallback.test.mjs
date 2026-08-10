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
