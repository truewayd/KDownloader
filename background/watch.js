// background/watch.js - Pawchive creator watch storage, checks, and notifications
import {
  PAW,
  WATCH_ALARM,
  WATCH_DATA_KEY,
  WATCH_ICON_CACHE_KEY,
} from './constants.js';
import { loadWatchConfig } from './config.js';
import {
  fetchPawchiveJson,
  PAWCHIVE_CLOUDFLARE_ERROR_CODE,
  preparePawchiveWatchRequest,
  readLimitedResponseBytes,
} from './network.js';

const WATCH_SCHEMA_VERSION = 1;
const WATCH_BATCH_SIZE = 5;
const WATCH_BATCH_PAUSE_MS = 400;
const WATCH_ALL_CONCURRENCY = 25;
const MAX_NOTIFICATION_ICON_BYTES = 2 * 1024 * 1024;
const MAX_WATCHES = 5000;

let mutationQueue = Promise.resolve();
let activeCheck = null;

function withWatchMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.catch(() => {});
  return run;
}

function requiredString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 512 || /[\0\r\n]/.test(normalized)) {
    throw new Error(`Invalid watch ${label}`);
  }
  return normalized;
}

function boundedText(value, fallback, maxLength) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return fallback;
  return normalized.replace(/\0/g, '').slice(0, maxLength);
}

function timestampValue(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const zoned = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : null;
}

function watchIdentityKey(service, userId) {
  return JSON.stringify([
    requiredString(service, 'service').toLowerCase(),
    requiredString(userId, 'creator id'),
  ]);
}

function normalizeWatchRecord(value, { strict = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid watch record');
  }
  const service = requiredString(value.service, 'service').toLowerCase();
  const userId = requiredString(value.userId, 'creator id');
  const updated = boundedText(value.updated, '', 64);
  if (strict && updated && timestampValue(updated) === null) {
    throw new Error(`Invalid watch updated value for ${service}/${userId}`);
  }
  if (strict) {
    for (const [field, raw] of Object.entries({
      watchedAt: value.watchedAt,
      checkedAt: value.checkedAt,
      failedAt: value.failedAt,
    })) {
      if (raw && timestampValue(raw) === null) {
        throw new Error(`Invalid watch ${field} value for ${service}/${userId}`);
      }
    }
  }
  return {
    service,
    userId,
    name: boundedText(value.name, userId, 512),
    updated,
    watchedAt: boundedText(value.watchedAt, new Date().toISOString(), 64),
    checkedAt: boundedText(value.checkedAt, '', 64),
    failedAt: boundedText(value.failedAt, '', 64),
    lastError: boundedText(value.lastError, '', 2048),
  };
}

function normalizeWatchList(value, options) {
  const records = Array.isArray(value) ? value : [];
  if (records.length > MAX_WATCHES) throw new Error(`Watch list exceeds ${MAX_WATCHES} records`);
  const keys = new Set();
  return records.map((record) => {
    const normalized = normalizeWatchRecord(record, options);
    const key = watchIdentityKey(normalized.service, normalized.userId);
    if (keys.has(key)) throw new Error(`Duplicate watch identity: ${normalized.service}/${normalized.userId}`);
    keys.add(key);
    return normalized;
  });
}

async function loadWatches() {
  const stored = await chrome.storage.local.get(WATCH_DATA_KEY);
  const payload = stored[WATCH_DATA_KEY];
  return normalizeWatchList(payload && payload.watches);
}

async function saveWatches(watches) {
  await chrome.storage.local.set({
    [WATCH_DATA_KEY]: {
      schemaVersion: WATCH_SCHEMA_VERSION,
      watches,
    },
  });
}

async function loadIconCache() {
  const stored = await chrome.storage.local.get(WATCH_ICON_CACHE_KEY);
  const cache = stored[WATCH_ICON_CACHE_KEY];
  return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
}

async function saveWatchesAndIcons(watches, icons) {
  await chrome.storage.local.set({
    [WATCH_DATA_KEY]: {
      schemaVersion: WATCH_SCHEMA_VERSION,
      watches,
    },
    [WATCH_ICON_CACHE_KEY]: icons,
  });
}

function profileUrl(service, userId) {
  return `${PAW.ORIGIN}${PAW.API_PREFIX}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}/profile`;
}

function iconUrl(service, userId) {
  return `${PAW.ORIGIN}/icons/${encodeURIComponent(service)}/${encodeURIComponent(userId)}`;
}

function validateProfile(profile, service, userId) {
  if (!profile || String(profile.id || '') !== userId || String(profile.service || '').toLowerCase() !== service) {
    throw new Error('Invalid Pawchive profile response');
  }
  if (timestampValue(profile.updated) === null) throw new Error('Pawchive profile has no valid updated time');
  return profile;
}

async function fetchProfile(service, userId) {
  return validateProfile(await fetchPawchiveJson(profileUrl(service, userId)), service, userId);
}

function recordFromProfile(profile, existing = {}) {
  return normalizeWatchRecord({
    ...existing,
    service: profile.service,
    userId: profile.id,
    name: profile.name || existing.name || profile.id,
    updated: profile.updated,
    checkedAt: new Date().toISOString(),
    failedAt: '',
    lastError: '',
  });
}

export async function getWatchState(service, userId) {
  const key = watchIdentityKey(service, userId);
  const watch = (await loadWatches()).find((item) => watchIdentityKey(item.service, item.userId) === key);
  return { watched: !!watch, watch: watch || null };
}

export async function getWatchSummary() {
  const watches = await loadWatches();
  return { count: watches.length, watches };
}

export async function setWatchState(serviceValue, userIdValue, watchedValue) {
  const service = requiredString(serviceValue, 'service').toLowerCase();
  const userId = requiredString(userIdValue, 'creator id');
  const watched = watchedValue === true;
  const key = watchIdentityKey(service, userId);

  const result = await withWatchMutation(async () => {
    const watches = await loadWatches();
    const icons = await loadIconCache();
    const index = watches.findIndex((item) => watchIdentityKey(item.service, item.userId) === key);
    if (!watched) {
      if (index < 0) return { watched: false, watch: null };
      watches.splice(index, 1);
      delete icons[key];
      await saveWatchesAndIcons(watches, icons);
      return { watched: false, watch: null };
    }
    if (index >= 0) return { watched: true, watch: watches[index] };

    const profile = await fetchProfile(service, userId);
    const watch = recordFromProfile(profile, { watchedAt: new Date().toISOString() });
    let cachedIcon = '';
    try {
      cachedIcon = await fetchCreatorIconData(watch);
      icons[key] = cachedIcon;
    } catch (error) {
      console.warn('[Watch] initial creator icon fetch failed', error);
    }
    watches.push(watch);
    await saveWatchesAndIcons(watches, icons);
    return { watched: true, watch, added: true, cachedIcon };
  });

  if (result.added) {
    await notifyWatchStarted(result.watch, result.cachedIcon || fallbackIconUrl()).catch((error) => {
      console.warn('[Watch] initial notification failed', error);
    });
  }
  return { watched: result.watched, watch: result.watch };
}

export async function exportWatches() {
  return {
    schemaVersion: WATCH_SCHEMA_VERSION,
    site: PAW.HOST,
    exportedAt: new Date().toISOString(),
    watches: await loadWatches(),
  };
}

export function importWatches(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return Promise.reject(new Error('Invalid watch import file'));
  }
  if (payload.schemaVersion !== WATCH_SCHEMA_VERSION || payload.site !== PAW.HOST) {
    return Promise.reject(new Error('Unsupported watch import schema or site'));
  }
  if (!Array.isArray(payload.watches)) {
    return Promise.reject(new Error('Invalid watch import list'));
  }
  let watches;
  try {
    watches = normalizeWatchList(payload.watches, { strict: true });
  } catch (error) {
    return Promise.reject(error);
  }
  return withWatchMutation(async () => {
    const currentIcons = await loadIconCache();
    const nextKeys = new Set(watches.map((watch) => watchIdentityKey(watch.service, watch.userId)));
    const nextIcons = Object.fromEntries(
      Object.entries(currentIcons).filter(([key]) => nextKeys.has(key))
    );
    await saveWatchesAndIcons(watches, nextIcons);
    return { count: watches.length };
  });
}

function fallbackIconUrl() {
  return chrome.runtime.getURL('icons/icon48.png');
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function fetchCreatorIconData(watch) {
  const response = await fetch(iconUrl(watch.service, watch.userId), {
    method: 'GET',
    headers: { Accept: 'image/jpeg' },
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(45 * 1000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await readLimitedResponseBytes(response, MAX_NOTIFICATION_ICON_BYTES, 'Pawchive icon');
  if (!buffer.byteLength || buffer.byteLength > MAX_NOTIFICATION_ICON_BYTES) {
    throw new Error('Invalid Pawchive icon size');
  }
  const signature = new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
  if (signature.length < 3 || signature[0] !== 0xff || signature[1] !== 0xd8 || signature[2] !== 0xff) {
    throw new Error('Invalid Pawchive JPEG icon');
  }
  return `data:image/jpeg;base64,${bytesToBase64(buffer)}`;
}

async function getNotificationIcon(watch) {
  const key = watchIdentityKey(watch.service, watch.userId);
  const cached = (await loadIconCache())[key];
  if (typeof cached === 'string' && cached.startsWith('data:image/jpeg;base64,')) return cached;

  try {
    const icon = await fetchCreatorIconData(watch);
    await withWatchMutation(async () => {
      const watches = await loadWatches();
      if (!watches.some((item) => watchIdentityKey(item.service, item.userId) === key)) return;
      const icons = await loadIconCache();
      icons[key] = icon;
      await chrome.storage.local.set({ [WATCH_ICON_CACHE_KEY]: icons });
    });
    return icon;
  } catch (error) {
    console.warn('[Watch] creator icon fetch failed', error);
    return fallbackIconUrl();
  }
}

function message(key, substitutions, fallback) {
  try {
    const localized = substitutions == null
      ? chrome.i18n.getMessage(key)
      : chrome.i18n.getMessage(key, substitutions);
    return localized || fallback;
  } catch (error) {
    return fallback;
  }
}

function createNotification(id, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(id, options, (notificationId) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(lastError.message || 'Notification failed'));
      else resolve(notificationId);
    });
  });
}

async function notifyUpdates(updates) {
  if (updates.length === 0) return;
  const sorted = [...updates].sort((a, b) => timestampValue(b.updated) - timestampValue(a.updated));
  const latest = sorted[0];
  const icon = await getNotificationIcon(latest);
  const notificationMessage = sorted.length === 1
    ? message('watchNotificationSingle', [latest.name], `A watched creator, ${latest.name}, has updated.`)
    : message('watchNotificationMultiple', [latest.name, String(sorted.length)], `${latest.name} and ${sorted.length - 1} other watched creators have updated.`);
  await createNotification(`pawchive-watch-update-${Date.now()}`, {
    type: 'basic',
    iconUrl: icon,
    title: message('watchNotificationTitle', null, 'Pawchive Watch'),
    message: notificationMessage,
  });
}

async function notifyWatchStarted(watch, icon) {
  await createNotification(`pawchive-watch-started-${Date.now()}`, {
    type: 'basic',
    iconUrl: icon,
    title: message('watchStartedTitle', [watch.name], `Watching ${watch.name}`),
    message: message(
      'watchStartedMessage',
      null,
      'If this creator updates, future notifications will look like this.'
    ),
  });
}

async function notifyFailures(failures) {
  if (failures.length === 0) return;
  const first = failures[0];
  const notificationMessage = failures.length === 1
    ? message('watchFailureSingle', [first.name, first.error], `Failed to check ${first.name}: ${first.error}`)
    : message('watchFailureMultiple', [String(failures.length), first.error], `Failed to check ${failures.length} watched creators: ${first.error}`);
  await createNotification(`pawchive-watch-failure-${Date.now()}`, {
    type: 'basic',
    iconUrl: fallbackIconUrl(),
    title: message('watchFailureTitle', null, 'Pawchive Watch check failed'),
    message: notificationMessage,
  });
}

async function checkOne(watch, prefetchedProfile) {
  try {
    const profile = prefetchedProfile === undefined
      ? await fetchProfile(watch.service, watch.userId)
      : validateProfile(prefetchedProfile, watch.service, watch.userId);
    const previousTime = timestampValue(watch.updated);
    const nextTime = timestampValue(profile.updated);
    const hasUpdate = previousTime !== null && nextTime > previousTime;
    const nextRecord = nextTime >= (previousTime ?? -Infinity)
      ? recordFromProfile(profile, watch)
      : { ...watch, name: profile.name || watch.name, checkedAt: new Date().toISOString(), failedAt: '', lastError: '' };
    return {
      key: watchIdentityKey(watch.service, watch.userId),
      watchedAt: watch.watchedAt,
      baselineUpdated: watch.updated,
      watch: nextRecord,
      hasUpdate,
    };
  } catch (error) {
    return {
      key: watchIdentityKey(watch.service, watch.userId),
      watchedAt: watch.watchedAt,
      baselineUpdated: watch.updated,
      error: error && error.message ? error.message : String(error),
      cloudflareBlocked: error && error.code === PAWCHIVE_CLOUDFLARE_ERROR_CODE,
    };
  }
}

function checkWithPrefetch(watch, prefetchedProfiles) {
  const key = watchIdentityKey(watch.service, watch.userId);
  return checkOne(watch, prefetchedProfiles.has(key) ? prefetchedProfiles.get(key) : undefined);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run())
  );
  return results;
}

async function collectChecks(watches, mode, prefetchedProfiles) {
  if (mode === 'all') {
    return mapWithConcurrency(
      watches,
      WATCH_ALL_CONCURRENCY,
      (watch) => checkWithPrefetch(watch, prefetchedProfiles)
    );
  }
  const results = [];
  for (let offset = 0; offset < watches.length; offset += WATCH_BATCH_SIZE) {
    results.push(...await Promise.all(
      watches.slice(offset, offset + WATCH_BATCH_SIZE)
        .map((watch) => checkWithPrefetch(watch, prefetchedProfiles))
    ));
    if (offset + WATCH_BATCH_SIZE < watches.length) {
      await new Promise((resolve) => setTimeout(resolve, WATCH_BATCH_PAUSE_MS));
    }
  }
  return results;
}

async function performWatchCheck({ prepareCloudflareContext = false } = {}) {
  const [snapshot, config] = await Promise.all([loadWatches(), loadWatchConfig()]);
  if (snapshot.length === 0) return { checked: 0, updated: 0, failed: 0 };
  const prefetchedProfiles = new Map();
  if (prepareCloudflareContext) {
    const first = snapshot[0];
    try {
      const prepared = await preparePawchiveWatchRequest(profileUrl(first.service, first.userId));
      if (prepared && prepared.hasPrefetched) {
        prefetchedProfiles.set(watchIdentityKey(first.service, first.userId), prepared.value);
      }
    } catch (error) {
      console.warn('[Watch] Pawchive context preparation failed', error);
    }
  }
  const results = await collectChecks(snapshot, config.checkMode, prefetchedProfiles);

  const active = await withWatchMutation(async () => {
    const current = await loadWatches();
    const resultMap = new Map(results.map((result) => [result.key, result]));
    const updates = [];
    const failures = [];
    const checkedAt = new Date().toISOString();
    const next = current.map((watch) => {
      const result = resultMap.get(watchIdentityKey(watch.service, watch.userId));
      if (
        !result
        || result.watchedAt !== watch.watchedAt
        || result.baselineUpdated !== watch.updated
      ) return watch;
      if (result.error) {
        failures.push({
          name: watch.name,
          error: result.error,
          cloudflareBlocked: result.cloudflareBlocked,
        });
        return { ...watch, failedAt: checkedAt, lastError: result.error };
      }
      if (result.hasUpdate) updates.push(result.watch);
      return result.watch;
    });
    await saveWatches(next);
    return { updates, failures };
  });

  await notifyUpdates(active.updates);
  // Cloudflare failures already produce one deduplicated, actionable notice
  // from the shared Pawchive request layer.
  await notifyFailures(active.failures.filter((failure) => !failure.cloudflareBlocked));
  return { checked: results.length, updated: active.updates.length, failed: active.failures.length };
}

export function runWatchCheck(options = {}) {
  if (activeCheck) return activeCheck;
  activeCheck = performWatchCheck(options).finally(() => {
    activeCheck = null;
  });
  return activeCheck;
}

export async function configureWatchAlarm(config) {
  const resolved = config || await loadWatchConfig();
  const interval = Math.max(1, Math.floor(Number(resolved.intervalMinutes) || 30));
  await chrome.alarms.clear(WATCH_ALARM);
  chrome.alarms.create(WATCH_ALARM, { delayInMinutes: interval, periodInMinutes: interval });
}
