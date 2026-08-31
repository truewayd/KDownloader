// background/config.js - load/save configs (watcher, backend, gist)
import {
  WATCH_CONFIG_KEY,
  BACKEND_CONFIG_KEY,
  BACKEND_SECRETS_KEY,
  DOWNLOAD_RULES_CONFIG_KEY,
  DEFAULT_EXCLUDED_EXTENSIONS,
  EXTERNAL_LINK_FILTER_CONFIG_KEY,
  DEFAULT_EXTERNAL_LINK_BLACKLIST,
  GIST_CONFIG_KEY,
  GIST_SECRETS_KEY,
} from './constants.js';
import { hasUnpairedSurrogate } from './util.js';

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

function normalizedGistId(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized.length <= 128
    && !/[\x00-\x1f\x7f]/.test(normalized)
    && !hasUnpairedSurrogate(normalized, 128)
    ? normalized
    : fallback;
}

function validatedGistId(value) {
  if (typeof value !== 'string') throw new Error('Gist ID must be a string');
  const normalized = value.trim();
  if (normalized.length > 128 || /[\x00-\x1f\x7f]/.test(normalized)
      || hasUnpairedSurrogate(normalized, 128)) {
    throw new Error('Gist ID is too long or contains invalid characters');
  }
  return normalized;
}

function normalizedSecret(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized.length <= 4096 && /^[\x20-\x7e]*$/.test(normalized) ? normalized : fallback;
}

function normalizedApiKey(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  if (!normalized) return '';
  return /^[\x20-\x7e]{32,256}$/.test(normalized)
    ? normalized
    : fallback;
}

function validatedHeaderSecret(value, label, { apiKey = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  const valid = apiKey
    ? (!normalized || /^[\x20-\x7e]{32,256}$/.test(normalized))
    : (normalized.length <= 4096 && /^[\x20-\x7e]*$/.test(normalized));
  if (!valid) {
    throw new Error(apiKey
      ? `${label} must contain 32 to 256 printable ASCII characters`
      : `${label} must contain at most 4096 printable ASCII characters`);
  }
  return normalized;
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
  return { enabled: false, backendType: 'abdm', host: '127.0.0.1', port: 15151, retryCount: 3, protocol: 'http', concurrency: 3, perPostFileLimit: 100, apiKey: '', gopeedHost: '127.0.0.1', gopeedPort: 9999, gopeedToken: '', gopeedProtocol: 'http' };
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
    apiKey: normalizedApiKey(value.apiKey, fallback.apiKey),
    gopeedHost: normalizedBackendHost(value.gopeedHost, fallback.gopeedHost),
    gopeedPort: boundedInteger(value.gopeedPort, fallback.gopeedPort, 1, 65535),
    gopeedToken: normalizedSecret(value.gopeedToken, fallback.gopeedToken),
    gopeedProtocol: value.gopeedProtocol === 'https' ? 'https' : 'http',
  };
}

export async function loadBackendConfig() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(BACKEND_CONFIG_KEY),
    chrome.storage.local.get(BACKEND_SECRETS_KEY),
  ]);
  const legacy = synced[BACKEND_CONFIG_KEY] || {};
  const secrets = local[BACKEND_SECRETS_KEY] || {};
  const config = normalizeBackendConfig({
    ...legacy,
    apiKey: Object.hasOwn(secrets, 'apiKey') ? secrets.apiKey : legacy.apiKey,
    gopeedToken: Object.hasOwn(secrets, 'gopeedToken') ? secrets.gopeedToken : legacy.gopeedToken,
  });
  if (Object.hasOwn(legacy, 'apiKey') || Object.hasOwn(legacy, 'gopeedToken')) {
    const publicConfig = { ...config };
    delete publicConfig.apiKey;
    delete publicConfig.gopeedToken;
    // Persist the local-only copy before removing the synced legacy fields. A
    // failed local write must never turn a privacy migration into data loss.
    await chrome.storage.local.set({
      [BACKEND_SECRETS_KEY]: {
        apiKey: config.apiKey,
        gopeedToken: config.gopeedToken,
      },
    });
    await chrome.storage.sync.set({ [BACKEND_CONFIG_KEY]: publicConfig });
  }
  return config;
}

export async function saveBackendConfig(cfg) {
  const current = await loadBackendConfig();
  const input = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? { ...cfg } : {};
  if (Object.hasOwn(input, 'apiKey')) {
    input.apiKey = validatedHeaderSecret(input.apiKey, 'API Key', { apiKey: true });
  }
  if (Object.hasOwn(input, 'gopeedToken')) {
    input.gopeedToken = validatedHeaderSecret(input.gopeedToken, 'Gopeed token');
  }
  const next = normalizeBackendConfig({ ...current, ...input }, current);
  const publicConfig = { ...next };
  delete publicConfig.apiKey;
  delete publicConfig.gopeedToken;
  await chrome.storage.local.set({
    [BACKEND_SECRETS_KEY]: {
      apiKey: next.apiKey,
      gopeedToken: next.gopeedToken,
    },
  });
  await chrome.storage.sync.set({ [BACKEND_CONFIG_KEY]: publicConfig });
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

function normalizeExternalLinkBlacklist(value, fallback = DEFAULT_EXTERNAL_LINK_BLACKLIST) {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = [];
  const seen = new Set();
  let totalLength = 0;
  for (const entry of value) {
    const host = String(entry || '').trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
    if (!host || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) || seen.has(host)) continue;
    if (normalized.length >= 100 || totalLength + host.length > 6000) break;
    seen.add(host);
    normalized.push(host);
    totalLength += host.length;
  }
  return normalized;
}

export function getDefaultDownloadRulesConfig() {
  return {
    enabled: false,
    excludedExtensions: [...DEFAULT_EXCLUDED_EXTENSIONS],
    syncToTrueDown: true,
  };
}

export function getDefaultExternalLinkFilterConfig() {
  return {
    mode: 'blacklist',
    blacklist: [...DEFAULT_EXTERNAL_LINK_BLACKLIST],
  };
}

export function getDefaultGistConfig() {
  return { enabled: false, token: '', gistId: '' };
}

export async function restoreDefaultConfigs() {
  const configs = {
    backend: getDefaultBackendConfig(),
    downloadRules: getDefaultDownloadRulesConfig(),
    externalLinkFilter: getDefaultExternalLinkFilterConfig(),
    watch: getDefaultWatchConfig(),
    gist: getDefaultGistConfig(),
  };
  const publicBackend = { ...configs.backend };
  delete publicBackend.apiKey;
  delete publicBackend.gopeedToken;
  const publicGist = { ...configs.gist };
  delete publicGist.token;
  await chrome.storage.local.set({
    [BACKEND_SECRETS_KEY]: { apiKey: '', gopeedToken: '' },
    [GIST_SECRETS_KEY]: { token: '' },
  });
  await chrome.storage.sync.set({
    [BACKEND_CONFIG_KEY]: publicBackend,
    [DOWNLOAD_RULES_CONFIG_KEY]: configs.downloadRules,
    [EXTERNAL_LINK_FILTER_CONFIG_KEY]: configs.externalLinkFilter,
    [WATCH_CONFIG_KEY]: configs.watch,
    [GIST_CONFIG_KEY]: publicGist,
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
    syncToTrueDown: typeof cfg.syncToTrueDown === 'boolean' ? cfg.syncToTrueDown : def.syncToTrueDown,
  };
}

export async function saveDownloadRulesConfig(cfg) {
  const next = {
    enabled: !!(cfg && cfg.enabled),
    excludedExtensions: normalizeExcludedExtensions(cfg && cfg.excludedExtensions),
    syncToTrueDown: !cfg || cfg.syncToTrueDown !== false,
  };
  await chrome.storage.sync.set({ [DOWNLOAD_RULES_CONFIG_KEY]: next });
  return next;
}

export async function loadExternalLinkFilterConfig() {
  const r = await chrome.storage.sync.get(EXTERNAL_LINK_FILTER_CONFIG_KEY);
  const cfg = r[EXTERNAL_LINK_FILTER_CONFIG_KEY] || {};
  const def = getDefaultExternalLinkFilterConfig();
  return {
    mode: cfg.mode === 'disabled' ? 'disabled' : def.mode,
    blacklist: normalizeExternalLinkBlacklist(cfg.blacklist),
  };
}

export async function saveExternalLinkFilterConfig(cfg) {
  const next = {
    mode: cfg && cfg.mode === 'disabled' ? 'disabled' : 'blacklist',
    blacklist: normalizeExternalLinkBlacklist(cfg && cfg.blacklist),
  };
  await chrome.storage.sync.set({ [EXTERNAL_LINK_FILTER_CONFIG_KEY]: next });
  return next;
}

export async function loadGistConfig() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(GIST_CONFIG_KEY),
    chrome.storage.local.get(GIST_SECRETS_KEY),
  ]);
  const legacy = synced[GIST_CONFIG_KEY] || {};
  const secrets = local[GIST_SECRETS_KEY] || {};
  const cfg = {
    ...legacy,
    token: Object.hasOwn(secrets, 'token') ? secrets.token : legacy.token,
  };
  const def = getDefaultGistConfig();
  const config = {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : def.enabled,
    token: normalizedSecret(cfg.token, def.token),
    gistId: normalizedGistId(cfg.gistId, def.gistId),
  };
  if (Object.hasOwn(legacy, 'token')) {
    const publicConfig = { ...config };
    delete publicConfig.token;
    await chrome.storage.local.set({ [GIST_SECRETS_KEY]: { token: config.token } });
    await chrome.storage.sync.set({ [GIST_CONFIG_KEY]: publicConfig });
  }
  return config;
}

export async function saveGistConfig(cfg) {
  const current = await loadGistConfig();
  const input = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? { ...cfg } : {};
  if (Object.hasOwn(input, 'token')) {
    input.token = validatedHeaderSecret(input.token, 'Gist token');
  }
  if (Object.hasOwn(input, 'gistId')) input.gistId = validatedGistId(input.gistId);
  const value = { ...current, ...input };
  const next = {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : current.enabled,
    token: normalizedSecret(value.token, current.token),
    gistId: normalizedGistId(value.gistId, current.gistId),
  };
  const publicConfig = { ...next };
  delete publicConfig.token;
  await chrome.storage.local.set({ [GIST_SECRETS_KEY]: { token: next.token } });
  await chrome.storage.sync.set({ [GIST_CONFIG_KEY]: publicConfig });
  return next;
}
