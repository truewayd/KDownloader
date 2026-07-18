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

export async function loadWatchConfig() {
  const r = await chrome.storage.sync.get(WATCH_CONFIG_KEY);
  const cfg = r[WATCH_CONFIG_KEY] || {};
  const def = getDefaultWatchConfig();
  return {
    intervalMinutes: Number.isFinite(cfg.intervalMinutes) && cfg.intervalMinutes > 0 ? cfg.intervalMinutes : def.intervalMinutes,
    checkMode: cfg.checkMode === 'all' ? 'all' : def.checkMode,
  };
}

export async function saveWatchConfig(cfg) {
  const current = await loadWatchConfig();
  const next = {
    intervalMinutes: Number.isFinite(cfg && cfg.intervalMinutes) && cfg.intervalMinutes > 0
      ? Number(cfg.intervalMinutes)
      : current.intervalMinutes,
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

export async function loadBackendConfig() {
  const r = await chrome.storage.sync.get(BACKEND_CONFIG_KEY);
  const cfg = r[BACKEND_CONFIG_KEY] || {};
  const def = getDefaultBackendConfig();
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : def.enabled,
    backendType: cfg.backendType === 'gopeed' ? 'gopeed' : 'abdm',
    host: typeof cfg.host === 'string' && cfg.host.trim() ? cfg.host.trim() : def.host,
    port: Number.isFinite(cfg.port) && cfg.port > 0 ? Number(cfg.port) : def.port,
    retryCount: Number.isFinite(cfg.retryCount) && cfg.retryCount >= 0 ? Number(cfg.retryCount) : def.retryCount,
    protocol: cfg.protocol === 'https' ? 'https' : 'http',
    concurrency: Number.isFinite(cfg.concurrency) && cfg.concurrency > 0 ? Number(cfg.concurrency) : def.concurrency,
    perPostFileLimit: Number.isFinite(cfg.perPostFileLimit) && cfg.perPostFileLimit > 0 ? Number(cfg.perPostFileLimit) : def.perPostFileLimit,
    gopeedHost: typeof cfg.gopeedHost === 'string' && cfg.gopeedHost.trim() ? cfg.gopeedHost.trim() : def.gopeedHost,
    gopeedPort: Number.isFinite(cfg.gopeedPort) && cfg.gopeedPort > 0 ? Number(cfg.gopeedPort) : def.gopeedPort,
    gopeedToken: typeof cfg.gopeedToken === 'string' ? cfg.gopeedToken : def.gopeedToken,
    gopeedProtocol: cfg.gopeedProtocol === 'https' ? 'https' : 'http',
  };
}

export async function saveBackendConfig(cfg) {
  const current = await loadBackendConfig();
  const next = { ...current, ...cfg };
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
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : false,
    token: typeof cfg.token === 'string' ? cfg.token : '',
    gistId: typeof cfg.gistId === 'string' ? cfg.gistId : ''
  };
}

export async function saveGistConfig(cfg) {
  const current = await loadGistConfig();
  const next = { ...current, ...cfg };
  await chrome.storage.sync.set({ [GIST_CONFIG_KEY]: next });
  return next;
}
