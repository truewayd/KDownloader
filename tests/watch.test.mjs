import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const asModuleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const areas = { local: {}, sync: {} };
const notifications = [];
const alarms = [];
let profile;
let profileStatus;
let requestedUrls;
let profiles;
let profileDelayMs;
let profileRequestsInFlight;
let maxProfileRequestsInFlight;

function storageArea(name) {
  return {
    async get(key) {
      if (key === null || key === undefined) return clone(areas[name]);
      return Object.hasOwn(areas[name], key) ? { [key]: clone(areas[name][key]) } : {};
    },
    async set(values) {
      Object.assign(areas[name], clone(values));
    },
  };
}

const watchChrome = {
  alarms: {
    async clear(name) {
      alarms.push({ action: 'clear', name });
      return true;
    },
    create(name, options) {
      alarms.push({ action: 'create', name, options });
    },
  },
  i18n: {
    getMessage(key, substitutions) {
      return `${key}:${Array.isArray(substitutions) ? substitutions.join('|') : ''}`;
    },
  },
  notifications: {
    create(id, options, callback) {
      notifications.push({ id, options });
      callback(id);
    },
  },
  runtime: {
    lastError: null,
    getURL(value) {
      return `chrome-extension://test/${value}`;
    },
  },
  storage: {
    local: storageArea('local'),
    sync: storageArea('sync'),
  },
};

const watchFetch = async (url) => {
  requestedUrls.push(url);
  if (url.includes('/icons/')) {
    return {
      ok: true,
      async arrayBuffer() {
        return Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer;
      },
    };
  }
  if (profileStatus !== 200) return { ok: false, status: profileStatus };
  const userId = decodeURIComponent(url.match(/\/user\/([^/]+)\/profile$/)?.[1] || '');
  profileRequestsInFlight++;
  maxProfileRequestsInFlight = Math.max(maxProfileRequestsInFlight, profileRequestsInFlight);
  if (profileDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, profileDelayMs));
  profileRequestsInFlight--;
  return {
    ok: true,
    async json() {
      return clone(profiles.get(userId) || profile);
    },
  };
};

globalThis.chrome = watchChrome;
globalThis.fetch = watchFetch;

const constantsSource = await readFile(path.join(root, 'background', 'constants.js'), 'utf8');
const constantsUrl = asModuleUrl(constantsSource);
const networkSource = (await readFile(path.join(root, 'background', 'network.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`);
const networkUrl = asModuleUrl(networkSource);
const configSource = (await readFile(path.join(root, 'background', 'config.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`);
const configUrl = asModuleUrl(configSource);
const watchSource = (await readFile(path.join(root, 'background', 'watch.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`)
  .replace(/from\s+['"]\.\/config\.js['"]/, `from '${configUrl}'`)
  .replace(/from\s+['"]\.\/network\.js['"]/, `from '${networkUrl}'`);
const watch = await import(asModuleUrl(watchSource));

beforeEach(() => {
  globalThis.chrome = watchChrome;
  globalThis.fetch = watchFetch;
  delete watchChrome.tabs;
  areas.local = {};
  areas.sync = { watchConfig: { intervalMinutes: 30, checkMode: 'all' } };
  notifications.length = 0;
  alarms.length = 0;
  requestedUrls = [];
  profileStatus = 200;
  profile = {
    id: 'creator-1',
    name: 'Mock Creator',
    service: 'patreon',
    updated: '2026-07-01T17:42:37.101402',
  };
  profiles = new Map([[profile.id, profile]]);
  profileDelayMs = 0;
  profileRequestsInFlight = 0;
  maxProfileRequestsInFlight = 0;
});

test('manual watch caches the icon, sends a sample notification, and stores a baseline', async () => {
  const state = await watch.setWatchState('patreon', 'creator-1', true);
  assert.equal(state.watched, true);
  assert.equal(state.watch.updated, profile.updated);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].options.message, /^watchStartedMessage:/);
  const cachedIcons = areas.local.pawchiveWatchIcons;
  assert.equal(Object.keys(cachedIcons).length, 1);
  assert.match(Object.values(cachedIcons)[0], /^data:image\/jpeg;base64,/);

  const result = await watch.runWatchCheck();
  assert.deepEqual(result, { checked: 1, updated: 0, failed: 0 });
  assert.equal(notifications.length, 1);
});

test('setting the same watch state repeatedly is idempotent', async () => {
  await watch.setWatchState('patreon', 'creator-1', true);
  const profileRequestCount = requestedUrls.length;
  await watch.setWatchState('patreon', 'creator-1', true);
  assert.equal(requestedUrls.length, profileRequestCount);
  assert.equal((await watch.getWatchSummary()).count, 1);
  assert.equal(notifications.length, 1);

  await watch.setWatchState('patreon', 'creator-1', false);
  await watch.setWatchState('patreon', 'creator-1', false);
  assert.equal((await watch.getWatchSummary()).count, 0);
  assert.deepEqual(areas.local.pawchiveWatchIcons, {});
});

test('a newer updated value reuses the cached icon for one update notification', async () => {
  await watch.setWatchState('patreon', 'creator-1', true);
  notifications.length = 0;
  requestedUrls = [];
  profile.updated = '2026-07-14T09:00:00.000000';

  const result = await watch.runWatchCheck();
  assert.deepEqual(result, { checked: 1, updated: 1, failed: 0 });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].options.iconUrl, /^data:image\/jpeg;base64,/);
  assert.equal(requestedUrls.some((url) => url.includes('/icons/')), false);
  assert.equal((await watch.getWatchSummary()).watches[0].updated, profile.updated);
});

test('scheduled check probes directly once and reuses the profile when no Pawchive tab is open', async () => {
  await watch.setWatchState('patreon', 'creator-1', true);
  notifications.length = 0;
  requestedUrls = [];

  const result = await watch.runWatchCheck({ prepareCloudflareContext: true });
  assert.deepEqual(result, { checked: 1, updated: 0, failed: 0 });
  assert.deepEqual(requestedUrls, [
    'https://pawchive.pw/api/v1/patreon/user/creator-1/profile',
  ]);
  assert.equal(notifications.length, 0);
});

test('manual check does not create a Pawchive tab when none is open', async () => {
  await watch.setWatchState('patreon', 'creator-1', true);
  let createCount = 0;
  watchChrome.tabs = {
    async query() {
      return [];
    },
    async create() {
      createCount++;
      return { id: 32 };
    },
    async sendMessage() {
      throw new Error('unexpected message');
    },
  };

  const result = await watch.runWatchCheck();
  assert.deepEqual(result, { checked: 1, updated: 0, failed: 0 });
  assert.equal(createCount, 0);
});

test('scheduled check continues through a silently opened pinned tab after probe failure', async () => {
  await watch.setWatchState('patreon', 'creator-1', true);
  notifications.length = 0;
  requestedUrls = [];
  profileStatus = 503;
  const created = [];
  const openTabs = [];
  watchChrome.tabs = {
    async query() {
      return clone(openTabs);
    },
    async create(options) {
      created.push(options);
      const tab = { id: 31, active: options.active, pinned: options.pinned, lastAccessed: 1 };
      openTabs.push(tab);
      return clone(tab);
    },
    async sendMessage(tabId, message) {
      assert.equal(tabId, 31);
      if (message.action === 'pawchive.api.ping') return { ready: true };
      assert.equal(message.action, 'pawchive.api.fetch');
      return {
        success: true,
        response: {
          ok: true,
          status: 200,
          url: message.url,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(profile),
        },
      };
    },
  };

  const result = await watch.runWatchCheck({ prepareCloudflareContext: true });
  assert.deepEqual(result, { checked: 1, updated: 0, failed: 0 });
  assert.deepEqual(created, [{
    url: 'https://pawchive.pw',
    active: false,
    pinned: true,
  }]);
  assert.deepEqual(requestedUrls, [
    'https://pawchive.pw/api/v1/patreon/user/creator-1/profile',
  ]);
  assert.equal(notifications.length, 0);
});

test('a failed profile check produces a failure notification and retains its baseline', async () => {
  await watch.setWatchState('patreon', 'creator-1', true);
  notifications.length = 0;
  const baseline = profile.updated;
  profileStatus = 503;

  const result = await watch.runWatchCheck();
  assert.deepEqual(result, { checked: 1, updated: 0, failed: 1 });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].options.title, /^watchFailureTitle:/);
  const stored = (await watch.getWatchSummary()).watches[0];
  assert.equal(stored.updated, baseline);
  assert.match(stored.lastError, /503/);
});

test('watch export/import is site-scoped and replaces the list', async () => {
  await watch.setWatchState('patreon', 'creator-1', true);
  const exported = await watch.exportWatches();
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.site, 'pawchive.pw');
  assert.equal(exported.watches.length, 1);

  await watch.importWatches({ ...exported, watches: [] });
  assert.equal((await watch.getWatchSummary()).count, 0);
  assert.deepEqual(areas.local.pawchiveWatchIcons, {});
  await assert.rejects(
    watch.importWatches({ ...exported, site: 'pawchive.st' }),
    /Unsupported watch import/
  );
  await assert.rejects(
    watch.importWatches({ ...exported, watches: [exported.watches[0], exported.watches[0]] }),
    /Duplicate watch identity/
  );
});

test('multiple updates use one notification with the newest creator icon', async () => {
  const watchedAt = '2026-07-14T00:00:00.000Z';
  await watch.importWatches({
    schemaVersion: 1,
    site: 'pawchive.pw',
    watches: [
      { service: 'patreon', userId: 'creator-1', name: 'Creator One', updated: '2026-07-01T00:00:00', watchedAt },
      { service: 'fanbox', userId: 'creator-2', name: 'Creator Two', updated: '2026-07-01T00:00:00', watchedAt },
    ],
  });
  profiles = new Map([
    ['creator-1', { id: 'creator-1', service: 'patreon', name: 'Creator One', updated: '2026-07-10T00:00:00' }],
    ['creator-2', { id: 'creator-2', service: 'fanbox', name: 'Creator Two', updated: '2026-07-12T00:00:00' }],
  ]);

  const result = await watch.runWatchCheck();
  assert.deepEqual(result, { checked: 2, updated: 2, failed: 0 });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].options.message, /^watchNotificationMultiple:Creator Two\|2$/);
  assert.ok(requestedUrls.includes('https://pawchive.pw/icons/fanbox/creator-2'));
});

async function importConcurrencyFixtures(count = 6) {
  const watches = [];
  profiles = new Map();
  for (let index = 1; index <= count; index++) {
    const userId = `creator-${index}`;
    watches.push({
      service: 'patreon',
      userId,
      name: `Creator ${index}`,
      updated: '2026-07-01T00:00:00',
      watchedAt: new Date(Date.UTC(2026, 6, 14, 0, 0, index)).toISOString(),
    });
    profiles.set(userId, {
      id: userId,
      service: 'patreon',
      name: `Creator ${index}`,
      updated: '2026-07-01T00:00:00',
    });
  }
  await watch.importWatches({ schemaVersion: 1, site: 'pawchive.pw', watches });
  profileDelayMs = 10;
}

test('batch mode checks at most five creator profiles concurrently', async () => {
  areas.sync.watchConfig.checkMode = 'batch';
  await importConcurrencyFixtures();
  await watch.runWatchCheck();
  assert.equal(maxProfileRequestsInFlight, 5);
});

test('all mode checks every creator with bounded high concurrency', async () => {
  areas.sync.watchConfig.checkMode = 'all';
  await importConcurrencyFixtures(30);
  await watch.runWatchCheck();
  assert.equal(maxProfileRequestsInFlight, 25);
});

test('default alarm scheduling uses a 30-minute period', async () => {
  areas.sync = {};
  await watch.configureWatchAlarm();
  assert.deepEqual(alarms.at(-1), {
    action: 'create',
    name: 'pawchiveWatchCheck',
    options: { delayInMinutes: 30, periodInMinutes: 30 },
  });
});
