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
import { hasUnpairedSurrogate } from './util.js';

const WATCH_SCHEMA_VERSION = 1;
const WATCH_BATCH_SIZE = 5;
const WATCH_BATCH_PAUSE_MS = 400;
const WATCH_ALL_CONCURRENCY = 25;
const MAX_NOTIFICATION_ICON_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_RESPONSE_BYTES = 256 * 1024;
const MAX_WATCHES = 5000;
const MAX_WATCH_STORAGE_BYTES = 4 * 1024 * 1024;
const MAX_ICON_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_ICON_DATA_URI_LENGTH = Math.ceil(MAX_NOTIFICATION_ICON_BYTES * 4 / 3) + 64;
const WATCH_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))?$/i;

let mutationQueue = Promise.resolve();
let activeCheck = null;
const watchStateIntents = new Map();

function withWatchMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function requiredString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 512 || /[\x00-\x1f\x7f]/.test(normalized)
      || hasUnpairedSurrogate(normalized, 512)) {
    throw new Error(`Invalid watch ${label}`);
  }
  return normalized;
}

function boundedText(value, fallback, maxLength) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return fallback;
  let end = Math.min(normalized.length, maxLength);
  if (end < normalized.length
      && end > 0
      && normalized.charCodeAt(end - 1) >= 0xd800
      && normalized.charCodeAt(end - 1) <= 0xdbff
      && normalized.charCodeAt(end) >= 0xdc00
      && normalized.charCodeAt(end) <= 0xdfff) {
    end--;
  }
  const bounded = normalized.slice(0, end).replace(/\0/g, '');
  if (!hasUnpairedSurrogate(bounded, maxLength)) return bounded || fallback;

  const parts = [];
  let segmentStart = 0;
  for (let index = 0; index < bounded.length; index++) {
    const code = bounded.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = bounded.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index++;
        continue;
      }
    } else if (code < 0xdc00 || code > 0xdfff) {
      continue;
    }
    parts.push(bounded.slice(segmentStart, index), '\ufffd');
    segmentStart = index + 1;
  }
  parts.push(bounded.slice(segmentStart));
  return parts.join('') || fallback;
}

function timestampValue(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 64) return null;
  const match = WATCH_TIMESTAMP_RE.exec(raw);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = month === 2 ? (leap ? 29 : 28) : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (
    month < 1 || month > 12 || day < 1 || day > monthDays
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59
    || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
  ) return null;
  const zoned = /(?:z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : `${raw}Z`;
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
  if (strict && (typeof value.updated !== 'string' || value.updated.trim().length > 64
      || timestampValue(updated) === null)) {
    throw new Error(`Invalid watch updated value for ${service}/${userId}`);
  }
  if (strict) {
    for (const [field, raw] of Object.entries({
      watchedAt: value.watchedAt,
      checkedAt: value.checkedAt,
      failedAt: value.failedAt,
    })) {
      const required = field === 'watchedAt';
      if ((required && (typeof raw !== 'string' || raw.trim().length > 64 || timestampValue(raw) === null))
          || (raw !== undefined && raw !== '' && (typeof raw !== 'string'
            || raw.trim().length > 64 || timestampValue(raw) === null))) {
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
  const normalizedRecords = records.map((record) => {
    const normalized = normalizeWatchRecord(record, options);
    const key = watchIdentityKey(normalized.service, normalized.userId);
    if (keys.has(key)) throw new Error(`Duplicate watch identity: ${normalized.service}/${normalized.userId}`);
    keys.add(key);
    return normalized;
  });
  if (new TextEncoder().encode(JSON.stringify(normalizedRecords)).byteLength > MAX_WATCH_STORAGE_BYTES) {
    throw new Error('Watch list exceeds the 4 MiB storage safety limit');
  }
  return normalizedRecords;
}

async function loadWatches() {
  const stored = await chrome.storage.local.get(WATCH_DATA_KEY);
  const payload = stored[WATCH_DATA_KEY];
  return normalizeWatchList(payload && payload.watches);
}

async function saveWatches(watches) {
  const normalized = normalizeWatchList(watches);
  await chrome.storage.local.set({
    [WATCH_DATA_KEY]: {
      schemaVersion: WATCH_SCHEMA_VERSION,
      watches: normalized,
    },
  });
}

async function loadIconCache() {
  const stored = await chrome.storage.local.get(WATCH_ICON_CACHE_KEY);
  const cache = stored[WATCH_ICON_CACHE_KEY];
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return {};
  const entries = [];
  let bytes = 0;
  for (const [key, value] of Object.entries(cache)) {
    if (key.length > 2048 || typeof value !== 'string'
        || !value.startsWith('data:image/jpeg;base64,')
        || value.length > MAX_ICON_DATA_URI_LENGTH) continue;
    if (bytes + value.length > MAX_ICON_CACHE_BYTES) break;
    entries.push([key, value]);
    bytes += value.length;
  }
  return Object.fromEntries(entries);
}

function putCachedIcon(cache, key, icon) {
  delete cache[key];
  if (typeof icon !== 'string' || icon.length > MAX_ICON_DATA_URI_LENGTH
      || !icon.startsWith('data:image/jpeg;base64,')) return false;
  let bytes = Object.values(cache).reduce(
    (total, value) => total + (typeof value === 'string' ? value.length : 0),
    0
  );
  for (const oldestKey of Object.keys(cache)) {
    if (bytes + icon.length <= MAX_ICON_CACHE_BYTES) break;
    bytes -= typeof cache[oldestKey] === 'string' ? cache[oldestKey].length : 0;
    delete cache[oldestKey];
  }
  if (bytes + icon.length > MAX_ICON_CACHE_BYTES) return false;
  cache[key] = icon;
  return true;
}

async function saveWatchesAndIcons(watches, icons) {
  const normalized = normalizeWatchList(watches);
  await chrome.storage.local.set({
    [WATCH_DATA_KEY]: {
      schemaVersion: WATCH_SCHEMA_VERSION,
      watches: normalized,
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
  return validateProfile(await fetchPawchiveJson(profileUrl(service, userId), {}, {
    maxResponseBytes: MAX_PROFILE_RESPONSE_BYTES,
  }), service, userId);
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
  const intent = { watched };
  watchStateIntents.set(key, intent);

  try {
    if (!watched) {
      return await withWatchMutation(async () => {
        const watches = await loadWatches();
        const index = watches.findIndex((item) => watchIdentityKey(item.service, item.userId) === key);
        if (watchStateIntents.get(key) !== intent) {
          return { watched: index >= 0, watch: index >= 0 ? watches[index] : null };
        }
        if (index < 0) return { watched: false, watch: null };
        const icons = await loadIconCache();
        watches.splice(index, 1);
        delete icons[key];
        await saveWatchesAndIcons(watches, icons);
        return { watched: false, watch: null };
      });
    }

    const existing = await withWatchMutation(async () => {
      const watches = await loadWatches();
      const index = watches.findIndex((item) => watchIdentityKey(item.service, item.userId) === key);
      return { watched: index >= 0, watch: index >= 0 ? watches[index] : null };
    });
    if (watchStateIntents.get(key) !== intent) return existing;
    if (existing.watched) return existing;

    // Network work stays outside the mutation queue so a slow icon or profile
    // response cannot block unrelated unwatch/import/check commits.
    const profile = await fetchProfile(service, userId);
    const candidate = recordFromProfile(profile, { watchedAt: new Date().toISOString() });
    let cachedIcon = '';
    try {
      cachedIcon = await fetchCreatorIconData(candidate);
    } catch (error) {
      console.warn('[Watch] initial creator icon fetch failed', error);
    }

    const result = await withWatchMutation(async () => {
      const watches = await loadWatches();
      const index = watches.findIndex((item) => watchIdentityKey(item.service, item.userId) === key);
      if (watchStateIntents.get(key) !== intent) {
        return { watched: index >= 0, watch: index >= 0 ? watches[index] : null };
      }
      if (index >= 0) return { watched: true, watch: watches[index] };
      if (watches.length >= MAX_WATCHES) throw new Error(`Watch list exceeds ${MAX_WATCHES} records`);
      const icons = await loadIconCache();
      if (cachedIcon) putCachedIcon(icons, key, cachedIcon);
      watches.push(candidate);
      await saveWatchesAndIcons(watches, icons);
      return { watched: true, watch: candidate, added: true, cachedIcon };
    });

    if (result.added && watchStateIntents.get(key) === intent) {
      await notifyWatchStarted(result.watch, result.cachedIcon || fallbackIconUrl()).catch((error) => {
        console.warn('[Watch] initial notification failed', error);
      });
    }
    return { watched: result.watched, watch: result.watch };
  } finally {
    if (watchStateIntents.get(key) === intent) watchStateIntents.delete(key);
  }
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
  // A replacement import is newer than any state change that was still
  // waiting on profile/icon I/O when the import began.
  watchStateIntents.clear();
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
      if (!putCachedIcon(icons, key, icon)) return;
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

function notificationId(prefix) {
  const suffix = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

async function notifyUpdates(updates) {
  if (updates.length === 0) return;
  const sorted = [...updates].sort((a, b) => timestampValue(b.updated) - timestampValue(a.updated));
  const latest = sorted[0];
  const icon = await getNotificationIcon(latest);
  const notificationMessage = sorted.length === 1
    ? message('watchNotificationSingle', [latest.name], `A watched creator, ${latest.name}, has updated.`)
    : message('watchNotificationMultiple', [latest.name, String(sorted.length)], `${latest.name} and ${sorted.length - 1} other watched creators have updated.`);
  await createNotification(notificationId('pawchive-watch-update'), {
    type: 'basic',
    iconUrl: icon,
    title: message('watchNotificationTitle', null, 'Pawchive Watch'),
    message: notificationMessage,
  });
}

async function notifyWatchStarted(watch, icon) {
  await createNotification(notificationId('pawchive-watch-started'), {
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
  await createNotification(notificationId('pawchive-watch-failure'), {
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
