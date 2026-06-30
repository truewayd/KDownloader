// background/config.js - load/save configs (favorites, backend, gist)
import { FAVORITES_CONFIG_KEY, BACKEND_CONFIG_KEY, GIST_CONFIG_KEY } from './constants.js';

export function getDefaultFavoritesConfig() {
  return { enabled: false, intervalMinutes: 360 };
}

export async function loadFavoritesConfig() {
  const r = await chrome.storage.sync.get(FAVORITES_CONFIG_KEY);
  const cfg = r[FAVORITES_CONFIG_KEY] || {};
  const def = getDefaultFavoritesConfig();
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : def.enabled,
    intervalMinutes: Number.isFinite(cfg.intervalMinutes) && cfg.intervalMinutes > 0 ? cfg.intervalMinutes : def.intervalMinutes,
  };
}

export async function saveFavoritesConfig(cfg) {
  const current = await loadFavoritesConfig();
  const next = { ...current, ...cfg };
  await chrome.storage.sync.set({ [FAVORITES_CONFIG_KEY]: next });
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

export async function loadGistConfig() {
  const r = await chrome.storage.sync.get(GIST_CONFIG_KEY);
  const cfg = r[GIST_CONFIG_KEY] || {};
  return {
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
