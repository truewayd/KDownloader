import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { beforeEach, test } from 'node:test';
import vm from 'node:vm';
import { createNotification, clearNotification } from '../background/notifications.js';

let created;
beforeEach(() => {
  created = [];
  globalThis.chrome = {
    runtime: { lastError: null, getURL: (path) => `chrome-extension://test/${path}` },
    notifications: {
      create(id, options, callback) { created.push({ id, options }); callback(id); },
      clear(_id, callback) { callback(true); },
    },
  };
});

test('system notifications use the bundled 128px icon, brand and creation time', async () => {
  const start = Date.now();
  assert.equal(await createNotification('issue', { title: 'Issue', message: 'Retry' }), 'issue');
  const { options } = created[0];
  assert.equal(options.type, 'basic');
  assert.equal(options.iconUrl, 'chrome-extension://test/icons/notifications/info.png');
  assert.equal(options.contextMessage, 'KDownloader');
  assert.ok(options.eventTime >= start && options.eventTime <= Date.now());
  const png = await readFile(new URL('../icons/notifications/info.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), 128);
  assert.equal(png.readUInt32BE(20), 128);
});

test('business kinds select distinct packaged icons and never leak internal fields to Chrome', async () => {
  for (const kind of ['error', 'warning', 'info', 'announcement', 'success', 'unknown']) {
    await createNotification(kind, { kind, title: kind, message: 'Notice' });
    const options = created.at(-1).options;
    assert.equal(options.iconUrl, `chrome-extension://test/icons/notifications/${kind === 'unknown' ? 'info' : kind}.png`);
    assert.equal(Object.hasOwn(options, 'kind'), false);
  }
});

test('avatar failure retries once with the same notification ID, time and actions', async (t) => {
  const originalCreate = chrome.notifications.create;
  t.mock.method(chrome.notifications, 'create', (id, options, callback) => {
    if (created.length) return originalCreate(id, options, callback);
    created.push({ id, options });
    chrome.runtime.lastError = { message: 'Unable to download all specified images' };
    try { callback(); } finally { chrome.runtime.lastError = null; }
  });
  const options = { kind: 'announcement', title: 'Watch', message: 'Updated', iconUrl: 'data:image/jpeg;base64,broken',
    buttons: [{ title: 'Open' }], requireInteraction: true };
  assert.equal(await createNotification('watch', options), 'watch');
  assert.equal(created.length, 2);
  assert.equal(created[1].id, created[0].id);
  assert.deepEqual(created[1].options, { ...created[0].options, iconUrl: 'chrome-extension://test/icons/notifications/announcement.png' });
  assert.equal(options.iconUrl, 'data:image/jpeg;base64,broken');
});

test('notification creation surfaces failures and never loops on the bundled icon', async (t) => {
  let attempts = 0;
  t.mock.method(chrome.notifications, 'create', () => { attempts++; throw new Error('Unavailable'); });
  await assert.rejects(createNotification('issue', { title: 'Issue', message: 'Retry' }), /Unavailable/);
  assert.equal(attempts, 2);
  await assert.rejects(createNotification('watch', { iconUrl: 'data:image/jpeg;base64,broken' }), /Unavailable/);
  assert.equal(attempts, 5);
});

test('missing generated artwork reaches the canonical brand as the final fallback', async (t) => {
  t.mock.method(chrome.notifications, 'create', (id, options, callback) => {
    created.push({ id, options });
    chrome.runtime.lastError = options.iconUrl.includes('/notifications/') ? { message: 'Missing image' } : null;
    try { callback(id); } finally { chrome.runtime.lastError = null; }
  });
  await createNotification('missing-icon', { kind: 'warning', title: 'Warning', message: 'Retry' });
  assert.equal(created.length, 2);
  assert.equal(created[1].options.iconUrl, 'chrome-extension://test/icons/icon128.png');
});

test('clearing notifications consumes callback errors and synchronous failures', async (t) => {
  assert.equal(await clearNotification('issue'), true);
  t.mock.method(chrome.notifications, 'clear', (_id, callback) => {
    chrome.runtime.lastError = { message: 'Already gone' };
    try { callback(false); } finally { chrome.runtime.lastError = null; }
  });
  assert.equal(await clearNotification('issue'), false);
  t.mock.method(chrome.notifications, 'clear', () => { throw new Error('Unavailable'); });
  assert.equal(await clearNotification('issue'), false);
});

async function notificationHandlers({ failOpen = false } = {}) {
  const listeners = {};
  const actions = [];
  const event = (name) => ({ addListener(callback) { listeners[name] = callback; } });
  const context = vm.createContext({
    chrome: {
      runtime: { onInstalled: event('installed'), onStartup: event('startup') },
      alarms: { onAlarm: event('alarm') },
      notifications: { onClicked: event('click'), onButtonClicked: event('button'), onClosed: event('close') },
    },
    WATCH_ALARM: 'watch',
    PAWCHIVE_CLOUDFLARE_NOTIFICATION_ID: 'pawchive-cloudflare-blocked',
    registerMessageHandlers() {},
    async openPawchiveForVerification() { actions.push('open'); if (failOpen) throw new Error('Tab failed'); },
    async clearNotification(id) { actions.push(['clear', id]); },
    async handleNativeFallbackDecision(id, confirmed) { actions.push([id, confirmed]); },
    console: { error() { actions.push('error'); } },
  });
  const source = await readFile(new URL('../background/index.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, ''), context);
  return { listeners, actions };
}

test('verification opens from the body or its button, then clears the notice', async () => {
  const { listeners, actions } = await notificationHandlers();
  listeners.click('pawchive-cloudflare-blocked');
  await new Promise(setImmediate);
  listeners.button('pawchive-cloudflare-blocked', 0);
  await new Promise(setImmediate);
  assert.deepEqual(actions, ['open', ['clear', 'pawchive-cloudflare-blocked'], 'open', ['clear', 'pawchive-cloudflare-blocked']]);
});

test('fallback requires an explicit button; unrelated clicks and invalid indices do nothing', async () => {
  const { listeners, actions } = await notificationHandlers();
  listeners.click('native-fallback-test');
  listeners.click('download-issue:test');
  listeners.button('native-fallback-test', 9);
  listeners.button('download-issue:test', 0);
  listeners.button('pawchive-cloudflare-blocked', 1);
  assert.deepEqual(actions, []);
  listeners.button('native-fallback-test', 0);
  listeners.button('native-fallback-test', 1);
  listeners.close('native-fallback-test');
  assert.deepEqual(actions, [['native-fallback-test', true], ['native-fallback-test', false], ['native-fallback-test', false]]);
});

test('a failed verification-page open retains the notification for retry', async () => {
  const { listeners, actions } = await notificationHandlers({ failOpen: true });
  listeners.click('pawchive-cloudflare-blocked');
  await new Promise(setImmediate);
  assert.deepEqual(actions, ['open', 'error']);
});
