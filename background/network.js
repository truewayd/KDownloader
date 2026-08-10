// background/network.js - network helpers (API fetch, cookies)
import { API, PAW } from './constants.js';

export const PAWCHIVE_CLOUDFLARE_ERROR_CODE = 'PAWCHIVE_CLOUDFLARE_BLOCKED';

export const PAWCHIVE_CLOUDFLARE_NOTIFICATION_ID = 'pawchive-cloudflare-blocked';
const PAWCHIVE_CLOUDFLARE_NOTICE_COOLDOWN_MS = 5 * 60 * 1000;
const PAWCHIVE_BRIDGE_READY_TIMEOUT_MS = 15 * 1000;
const PAWCHIVE_BRIDGE_POLL_MS = 250;
const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const NETWORK_REQUEST_TIMEOUT_MS = 45 * 1000;
const ALLOWED_COOKIE_DOMAINS = new Set([...API.HOSTS, API.COOMERFANS_HOST, ...PAW.HOSTS]);
const SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'pragma',
]);
const CLOUDFLARE_BODY_MARKERS = [
  'cf-chl-',
  'cf-error-code',
  'challenge-platform',
  'cloudflare ray id',
  'attention required! | cloudflare',
  'just a moment...',
];

let lastPawchiveCloudflareNoticeAt = 0;
let pawchiveCloudflareNoticePromise = null;

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(NETWORK_REQUEST_TIMEOUT_MS) });
}

function getHeader(response, name) {
  try {
    return String(response && response.headers && response.headers.get(name) || '').toLowerCase();
  } catch (error) {
    return '';
  }
}

function localizedMessage(key, fallback) {
  try {
    return chrome.i18n.getMessage(key) || fallback;
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

async function notifyPawchiveCloudflareBlocked() {
  if (!globalThis.chrome || !chrome.notifications || typeof chrome.notifications.create !== 'function') return;
  const now = Date.now();
  if (pawchiveCloudflareNoticePromise) return pawchiveCloudflareNoticePromise;
  if (now - lastPawchiveCloudflareNoticeAt < PAWCHIVE_CLOUDFLARE_NOTICE_COOLDOWN_MS) return;

  lastPawchiveCloudflareNoticeAt = now;
  pawchiveCloudflareNoticePromise = createNotification(PAWCHIVE_CLOUDFLARE_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title: localizedMessage('pawchiveCloudflareTitle', 'Pawchive verification required'),
    message: localizedMessage(
      'pawchiveCloudflareMessage',
      'Open pawchive.pw, complete the Cloudflare verification, keep that tab open, and retry. If it is already complete, Cloudflare may have blocked this network.'
    ),
    requireInteraction: true,
    buttons: [{
      title: localizedMessage('openPawchiveAction', 'Open Pawchive'),
    }],
  }).catch((error) => {
    console.warn('[Background] Pawchive Cloudflare notification failed', error);
  }).finally(() => {
    pawchiveCloudflareNoticePromise = null;
  });
  return pawchiveCloudflareNoticePromise;
}

export async function openPawchiveForVerification() {
  if (!globalThis.chrome || !chrome.tabs || typeof chrome.tabs.create !== 'function') return;
  const tabs = await queryOpenPawchiveTabs();
  if (tabs.length > 0 && typeof chrome.tabs.update === 'function') {
    await chrome.tabs.update(tabs[0].id, { active: true });
    return;
  }
  await chrome.tabs.create({ url: PAW.ORIGIN, active: true });
}

function isPawchiveApiUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === PAW.ORIGIN
      && (parsed.pathname === PAW.API_PREFIX || parsed.pathname.startsWith(`${PAW.API_PREFIX}/`));
  } catch (error) {
    return false;
  }
}

function isSharedApiUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && API.HOSTS.includes(parsed.hostname.toLowerCase())
      && (parsed.pathname === API.API_PREFIX || parsed.pathname.startsWith(`${API.API_PREFIX}/`));
  } catch (error) {
    return false;
  }
}

function isPawchiveDmsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === PAW.ORIGIN
      && /^\/[^/]+\/user\/[^/]+\/dms\/?$/.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function looksLikeCloudflareBlock(response, bodyText) {
  const status = Number(response && response.status) || 0;
  const mitigated = getHeader(response, 'cf-mitigated');
  const server = getHeader(response, 'server');
  const cfRay = getHeader(response, 'cf-ray');
  const contentType = getHeader(response, 'content-type');
  const responseUrl = String(response && response.url || '').toLowerCase();
  const normalizedBody = String(bodyText || '').slice(0, 256 * 1024).toLowerCase();
  const hasMarker = CLOUDFLARE_BODY_MARKERS.some((marker) => normalizedBody.includes(marker));

  if (mitigated === 'challenge' || responseUrl.includes('/cdn-cgi/challenge-platform/')) return true;
  if (hasMarker) return true;
  if ((status === 403 || status === 429) && (server.includes('cloudflare') || cfRay)) return true;
  return status === 403 && contentType.includes('text/html');
}

async function hasCloudflareClearanceCookie() {
  if (!globalThis.chrome || !chrome.cookies || typeof chrome.cookies.get !== 'function') return null;
  try {
    const cookie = await chrome.cookies.get({ url: PAW.ORIGIN, name: 'cf_clearance' });
    return !!cookie;
  } catch (error) {
    return null;
  }
}

function pawchiveCloudflareError(status = 0, cause) {
  const suffix = status ? ` (HTTP ${status})` : '';
  const error = new Error(
    `Pawchive Cloudflare verification is required or the request was blocked${suffix}. Open ${PAW.ORIGIN}, complete verification, keep that tab open, and retry.`
  );
  error.name = 'PawchiveCloudflareError';
  error.code = PAWCHIVE_CLOUDFLARE_ERROR_CODE;
  if (cause) error.cause = cause;
  return error;
}

function safeRequestHeaders(headers, defaults = {}) {
  const result = {};
  const input = {
    ...defaults,
    ...(headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {}),
  };
  for (const [name, value] of Object.entries(input)) {
    if (!SAFE_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    const normalized = String(value ?? '').trim();
    if (!normalized || normalized.length > 4096 || /[\r\n\0]/.test(normalized)) continue;
    result[name] = normalized;
  }
  return result;
}

function pawchiveRequestHeaders(headers) {
  let language = '';
  try {
    language = chrome.i18n.getUILanguage().replace(/_/g, '-');
  } catch (error) {
    language = '';
  }
  return safeRequestHeaders(headers, {
    Accept: 'application/json',
    ...(language ? { 'Accept-Language': language } : {}),
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  });
}

export async function readLimitedResponseText(response, maxBytes, label = 'Network') {
  const declaredBytes = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new Error(`${label} response exceeds the ${maxBytes} byte safety limit`);
  }

  const reader = response?.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null;
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`${label} response exceeds the ${maxBytes} byte safety limit`);
    }
    return text;
  }

  const decoder = new TextDecoder();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response exceeds the ${maxBytes} byte safety limit`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock?.();
  }
}

export async function readLimitedResponseBytes(response, maxBytes, label = 'Network') {
  const declaredBytes = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new Error(`${label} response exceeds the ${maxBytes} byte safety limit`);
  }

  const reader = response?.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null;
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`${label} response exceeds the ${maxBytes} byte safety limit`);
    }
    return buffer;
  }

  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response exceeds the ${maxBytes} byte safety limit`);
      }
      chunks.push(value);
    }
    const result = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result.buffer;
  } finally {
    reader.releaseLock?.();
  }
}

function bridgeResponse(payload) {
  const values = payload && payload.headers && typeof payload.headers === 'object'
    ? payload.headers
    : {};
  return {
    ok: payload && payload.ok === true,
    status: Number(payload && payload.status) || 0,
    url: String(payload && payload.url || ''),
    headers: {
      get(name) {
        const target = String(name).toLowerCase();
        const key = Object.keys(values).find((candidate) => candidate.toLowerCase() === target);
        return key ? values[key] : null;
      },
    },
    async text() {
      return String(payload && payload.body || '');
    },
  };
}

async function queryOpenPawchiveTabs() {
  if (!globalThis.chrome || !chrome.tabs || typeof chrome.tabs.query !== 'function') return [];
  try {
    const tabs = await chrome.tabs.query({ url: `${PAW.ORIGIN}/*` });
    return (Array.isArray(tabs) ? tabs : [])
      .filter((tab) => Number.isInteger(tab && tab.id) && tab.discarded !== true)
      .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
  } catch (error) {
    return [];
  }
}

async function fetchPawchiveFromOpenTab(url, headers) {
  if (!globalThis.chrome || !chrome.tabs || typeof chrome.tabs.query !== 'function' || typeof chrome.tabs.sendMessage !== 'function') {
    return null;
  }

  for (const tab of await queryOpenPawchiveTabs()) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, {
        action: 'pawchive.api.fetch',
        url,
        headers,
      });
      if (result && result.success === true && result.response) return bridgeResponse(result.response);
    } catch (error) {
      // The tab may still be on the challenge/interstitial page or may predate
      // this extension version. Try another tab, then the background fallback.
    }
  }
  return null;
}

async function parsePawchiveResponse(response, { notifyOnCloudflare = true } = {}) {
  let text = '';
  if (typeof response.text === 'function') {
    text = await readLimitedResponseText(response, MAX_API_RESPONSE_BYTES, 'Pawchive API');
  } else if (response.ok && typeof response.json === 'function') {
    return response.json();
  }

  if (looksLikeCloudflareBlock(response, text)) {
    if (notifyOnCloudflare) await notifyPawchiveCloudflareBlocked();
    throw pawchiveCloudflareError(Number(response.status) || 0);
  }
  if (response.url && !isPawchiveApiUrl(response.url)) {
    throw new Error('Pawchive API redirected outside the allowed API path');
  }
  if (!response.ok) throw new Error(`Pawchive API HTTP ${response.status}`);
  if (!text || !text.trim()) throw new Error('Empty Pawchive API response');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Invalid JSON from Pawchive API');
  }
}

export async function fetchPawchiveJson(url, headers = {}, options = {}) {
  if (!isPawchiveApiUrl(url)) throw new Error('Refusing Pawchive credentials for an unexpected API URL');

  const {
    notifyOnCloudflare = true,
    preferOpenTab = true,
  } = options;
  const requestHeaders = pawchiveRequestHeaders(headers);
  if (preferOpenTab) {
    const bridgedResponse = await fetchPawchiveFromOpenTab(url, requestHeaders);
    if (bridgedResponse) return parsePawchiveResponse(bridgedResponse, { notifyOnCloudflare });
  }

  let response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: requestHeaders,
      // Browser-managed credentials carry cf_clearance and other matching
      // Cloudflare cookies while preserving the real User-Agent/client hints.
      credentials: 'include',
      mode: 'cors',
      cache: 'no-store',
      redirect: 'follow',
    });
  } catch (error) {
    const hasClearance = await hasCloudflareClearanceCookie();
    if (hasClearance === false || error instanceof TypeError) {
      if (notifyOnCloudflare) await notifyPawchiveCloudflareBlocked();
      throw pawchiveCloudflareError(0, error);
    }
    throw error;
  }

  return parsePawchiveResponse(response, { notifyOnCloudflare });
}

export async function fetchPawchiveDmsHtml(url) {
  if (!isPawchiveDmsUrl(url)) throw new Error('Refusing to fetch an unexpected Pawchive HTML URL');

  const requestHeaders = pawchiveRequestHeaders({
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });
  let response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: requestHeaders,
      credentials: 'include',
      mode: 'cors',
      cache: 'no-store',
      redirect: 'follow',
    });
  } catch (error) {
    const hasClearance = await hasCloudflareClearanceCookie();
    if (hasClearance === false || error instanceof TypeError) {
      await notifyPawchiveCloudflareBlocked();
      throw pawchiveCloudflareError(0, error);
    }
    throw error;
  }

  const text = await readLimitedResponseText(response, MAX_API_RESPONSE_BYTES, 'Pawchive DMs');
  if (looksLikeCloudflareBlock(response, text)) {
    await notifyPawchiveCloudflareBlocked();
    throw pawchiveCloudflareError(Number(response.status) || 0);
  }
  if (response.url && !isPawchiveDmsUrl(response.url)) {
    throw new Error('Pawchive DMs redirected outside the allowed creator page');
  }
  if (!response.ok) throw new Error(`Pawchive DMs HTTP ${response.status}`);
  if (!text.trim()) throw new Error('Empty Pawchive DMs response');
  return text;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPawchiveBridge(tabId) {
  if (!chrome.tabs || typeof chrome.tabs.sendMessage !== 'function') return false;
  const deadline = Date.now() + PAWCHIVE_BRIDGE_READY_TIMEOUT_MS;
  do {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'pawchive.api.ping' });
      if (response && response.ready === true) return true;
    } catch (error) {
      // The document-start bridge is not ready yet.
    }
    await delay(PAWCHIVE_BRIDGE_POLL_MS);
  } while (Date.now() < deadline);
  return false;
}

export async function preparePawchiveWatchRequest(url) {
  if (!isPawchiveApiUrl(url)) throw new Error('Invalid Pawchive Watch probe URL');
  if ((await queryOpenPawchiveTabs()).length > 0) {
    return { tabAvailable: true, opened: false, hasPrefetched: false };
  }

  try {
    const value = await fetchPawchiveJson(url, {}, {
      notifyOnCloudflare: false,
      preferOpenTab: false,
    });
    return {
      tabAvailable: false,
      opened: false,
      hasPrefetched: true,
      value,
    };
  } catch (probeError) {
    if (!globalThis.chrome || !chrome.tabs || typeof chrome.tabs.create !== 'function') {
      return { tabAvailable: false, opened: false, hasPrefetched: false };
    }
    try {
      const tab = await chrome.tabs.create({
        url: PAW.ORIGIN,
        active: false,
        pinned: true,
      });
      const ready = Number.isInteger(tab && tab.id)
        ? await waitForPawchiveBridge(tab.id)
        : false;
      return {
        tabAvailable: ready,
        opened: true,
        hasPrefetched: false,
        tabId: Number.isInteger(tab && tab.id) ? tab.id : null,
      };
    } catch (error) {
      console.warn('[Background] failed to open pinned Pawchive Watch tab', error);
      return { tabAvailable: false, opened: false, hasPrefetched: false };
    }
  }
}

export async function handleAPIRequest(url, headers = {}) {
  if (isPawchiveApiUrl(url)) return fetchPawchiveJson(url, headers);
  if (!isSharedApiUrl(url)) throw new Error('Refusing an unexpected API URL');
  try {
    const resp = await fetchWithTimeout(url, {
      method: 'GET',
      headers: safeRequestHeaders(headers, { Accept: 'application/json' }),
      credentials: 'include',
      mode: 'cors',
      cache: 'no-store',
      redirect: 'error',
    });
    if (!resp.ok) {
      if (resp.status === 403) throw new Error('Access denied (403).');
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const text = await readLimitedResponseText(resp, MAX_API_RESPONSE_BYTES, 'API');
    if (!text || !text.trim()) throw new Error('Empty API response');
    try { return JSON.parse(text); } catch (e) { throw new Error('Invalid JSON from API'); }
  } catch (e) {
    console.error('[Background] handleAPIRequest error', e);
    throw e;
  }
}

export async function getCookies(domain) {
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  if (!ALLOWED_COOKIE_DOMAINS.has(normalizedDomain)) {
    throw new Error('Refusing to export cookies for an unexpected domain');
  }
  try {
    const cookies = await chrome.cookies.getAll({ domain: normalizedDomain });
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (e) {
    console.error('[Background] getCookies error', e);
    return '';
  }
}
