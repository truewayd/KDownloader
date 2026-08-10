// background/config.js - load/save configs (watcher, backend, gist)
import {
  WATCH_CONFIG_KEY,
  BACKEND_CONFIG_KEY,
  DOWNLOAD_RULES_CONFIG_KEY,
  DEFAULT_EXCLUDED_EXTENSIONS,
  GIST_CONFIG_KEY,
} from './constants.js';

export function getDefaultWatchConfig() {
  return { intervalMinutes: 30, checkMode: 'batch' };
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizedBackendHost(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 253 || /[\s/@?#]/.test(raw)) return fallback;
  try {
    const url = new URL(`http://${raw}`);
    if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
      return fallback;
    }
    const hostname = url.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' ? hostname : fallback;
  } catch (error) {
    return fallback;
  }
}

function normalizedShortString(value, fallback = '', maxLength = 4096) {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback;
}

function normalizedSecret(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized.length <= 4096 && !/[\0\r\n]/.test(normalized) ? normalized : fallback;
}

export async function loadWatchConfig() {
  const r = await chrome.storage.sync.get(WATCH_CONFIG_KEY);
  const cfg = r[WATCH_CONFIG_KEY] || {};
  const def = getDefaultWatchConfig();
  return {
    intervalMinutes: boundedInteger(cfg.intervalMinutes, def.intervalMinutes, 1, 10080),
    checkMode: cfg.checkMode === 'all' ? 'all' : def.checkMode,
  };
}

export async function saveWatchConfig(cfg) {
  const current = await loadWatchConfig();
  const next = {
    intervalMinutes: boundedInteger(cfg && cfg.intervalMinutes, current.intervalMinutes, 1, 10080),
    checkMode: cfg && cfg.checkMode === 'all' ? 'all' : 'batch',
  };
  await chrome.storage.sync.set({ [WATCH_CONFIG_KEY]: next });
  return next;
}

export function getDefaultBackendConfig() {
  // Default per-post batch limit reduced to 100 because most posts have fewer files.
  // Larger batch downloads (many posts) are still supported by batching across posts.
  return { enabled: false, backendType: 'abdm', host: '127.0.0.1', port: 15151, retryCount: 3, protocol: 'http', concurrency: 3, perPostFileLimit: 100, gopeedHost: '127.0.0.1', gopeedPort: 9999, gopeedToken: '', gopeedProtocol: 'http' };
}

function normalizeBackendConfig(cfg, fallback = getDefaultBackendConfig()) {
  const value = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    backendType: value.backendType === 'gopeed' ? 'gopeed' : 'abdm',
    host: normalizedBackendHost(value.host, fallback.host),
    port: boundedInteger(value.port, fallback.port, 1, 65535),
    retryCount: boundedInteger(value.retryCount, fallback.retryCount, 0, 10),
    protocol: value.protocol === 'https' ? 'https' : 'http',
    concurrency: boundedInteger(value.concurrency, fallback.concurrency, 1, 6),
    perPostFileLimit: boundedInteger(value.perPostFileLimit, fallback.perPostFileLimit, 1, 1000),
    gopeedHost: normalizedBackendHost(value.gopeedHost, fallback.gopeedHost),
    gopeedPort: boundedInteger(value.gopeedPort, fallback.gopeedPort, 1, 65535),
    gopeedToken: normalizedSecret(value.gopeedToken, fallback.gopeedToken),
    gopeedProtocol: value.gopeedProtocol === 'https' ? 'https' : 'http',
  };
}

export async function loadBackendConfig() {
  const r = await chrome.storage.sync.get(BACKEND_CONFIG_KEY);
  return normalizeBackendConfig(r[BACKEND_CONFIG_KEY]);
}

export async function saveBackendConfig(cfg) {
  const current = await loadBackendConfig();
  const next = normalizeBackendConfig({ ...current, ...(cfg || {}) }, current);
  await chrome.storage.sync.set({ [BACKEND_CONFIG_KEY]: next });
  return next;
}

function normalizeExcludedExtensions(value, fallback = DEFAULT_EXCLUDED_EXTENSIONS) {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = [];
  const seen = new Set();
  for (const entry of value) {
    const raw = String(entry || '').trim().toLowerCase();
    const extension = raw.startsWith('.') ? raw : `.${raw}`;
    if (!/^\.[a-z0-9]{1,16}$/.test(extension) || seen.has(extension)) continue;
    seen.add(extension);
    normalized.push(extension);
  }
  return normalized;
}

export function getDefaultDownloadRulesConfig() {
  return {
    enabled: false,
    excludedExtensions: [...DEFAULT_EXCLUDED_EXTENSIONS],
  };
}

export function getDefaultGistConfig() {
  return { enabled: false, token: '', gistId: '' };
}

export async function restoreDefaultConfigs() {
  const configs = {
    backend: getDefaultBackendConfig(),
    downloadRules: getDefaultDownloadRulesConfig(),
    watch: getDefaultWatchConfig(),
    gist: getDefaultGistConfig(),
  };
  await chrome.storage.sync.set({
    [BACKEND_CONFIG_KEY]: configs.backend,
    [DOWNLOAD_RULES_CONFIG_KEY]: configs.downloadRules,
    [WATCH_CONFIG_KEY]: configs.watch,
    [GIST_CONFIG_KEY]: configs.gist,
  });
  return configs;
}

export async function loadDownloadRulesConfig() {
  const r = await chrome.storage.sync.get(DOWNLOAD_RULES_CONFIG_KEY);
  const cfg = r[DOWNLOAD_RULES_CONFIG_KEY] || {};
  const def = getDefaultDownloadRulesConfig();
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : def.enabled,
    excludedExtensions: normalizeExcludedExtensions(cfg.excludedExtensions),
  };
}

export async function saveDownloadRulesConfig(cfg) {
  const next = {
    enabled: !!(cfg && cfg.enabled),
    excludedExtensions: normalizeExcludedExtensions(cfg && cfg.excludedExtensions),
  };
  await chrome.storage.sync.set({ [DOWNLOAD_RULES_CONFIG_KEY]: next });
  return next;
}

export async function loadGistConfig() {
  const r = await chrome.storage.sync.get(GIST_CONFIG_KEY);
  const cfg = r[GIST_CONFIG_KEY] || {};
  const def = getDefaultGistConfig();
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : def.enabled,
    token: normalizedSecret(cfg.token, def.token),
    gistId: normalizedShortString(cfg.gistId, def.gistId, 128).trim(),
  };
}

export async function saveGistConfig(cfg) {
  const current = await loadGistConfig();
  const value = { ...current, ...(cfg || {}) };
  const next = {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : current.enabled,
    token: normalizedSecret(value.token, current.token),
    gistId: normalizedShortString(value.gistId, current.gistId, 128).trim(),
  };
  await chrome.storage.sync.set({ [GIST_CONFIG_KEY]: next });
  return next;
}
