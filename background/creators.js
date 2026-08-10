// background/creators.js - manage creators override cache and page-level push to site storage
import { CREATORS_OVERRIDE_KEY, CREATORS_OVERRIDE_ENABLED_KEY, API } from './constants.js';
import { readLimitedResponseText } from './network.js';

const TARGET_HOSTS = API.HOSTS;
const KEY_BASE = CREATORS_OVERRIDE_KEY; // will store per-host as KEY_BASE + '_' + host
const MAX_CREATORS_RESPONSE_BYTES = 16 * 1024 * 1024;
const CREATORS_REQUEST_TIMEOUT_MS = 45 * 1000;

function hostKey(host) {
  return `${KEY_BASE}_${host}`;
}

// Fetch real creators.json from a host using Accept: text/css to bypass DDoS guard heuristics
async function fetchCreatorsFromHost(host) {
  const url = `https://${host}${API.API_PREFIX}${API.CREATORS_PATH}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'text/css' },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(CREATORS_REQUEST_TIMEOUT_MS),
  });
  if (res.ok === false) throw new Error(`Creators fetch failed: HTTP ${res.status}`);
  const txt = await readLimitedResponseText(res, MAX_CREATORS_RESPONSE_BYTES, 'Creators');
  try {
    const parsed = JSON.parse(txt);
    if (!parsed || (typeof parsed !== 'object')) throw new Error('Unexpected creators response');
    return parsed;
  } catch (e) {
    throw new Error('Creators fetch returned invalid JSON');
  }
}

export async function setCreatorsOverrideEnabled(enabled) {
  try {
    await chrome.storage.local.set({ [CREATORS_OVERRIDE_ENABLED_KEY]: !!enabled });
    return true;
  } catch (e) {
    console.error('[Creators] setCreatorsOverrideEnabled error', e);
    throw e;
  }
}

// Update cache for a specific host (if host param provided) or for all hosts (if host omitted)
export async function updateCacheFromNetwork(host) {
  if (host) {
    if (!TARGET_HOSTS.includes(host)) throw new Error('Unknown host');
    const data = await fetchCreatorsFromHost(host);

    const payload = { updatedAt: Date.now(), sourceHost: host, data };
    // store large JSON into chrome.storage.local as string to avoid structure clone overhead
    const text = JSON.stringify(payload);
    try {
      await chrome.storage.local.set({
        [hostKey(host)]: { __text: text },
        [`${hostKey(host)}_meta`]: {
          updatedAt: payload.updatedAt,
          sourceHost: payload.sourceHost,
        },
      });
    } catch (e) {
      console.error('[Creators] storage.set payload failed', e);
      throw e;
    }
    return { updatedAt: payload.updatedAt, sourceHost: payload.sourceHost };

  }

  // update both hosts and return map
  const entries = await Promise.all(TARGET_HOSTS.map(async (h) => {
    try {
      return [h, await updateCacheFromNetwork(h)];
    } catch (e) {
      console.error('[Creators] update failed for', h, e);
      return [h, { error: e && e.message ? e.message : String(e) }];
    }
  }));
  return Object.fromEntries(entries);
}

export async function getCachedCreators(host) {
  if (host) {
    const st = await chrome.storage.local.get(hostKey(host));
    return st && st[hostKey(host)] ? st[hostKey(host)] : null;
  }
  // return mapping for all
  const keys = TARGET_HOSTS.map(hostKey);
  const stored = await chrome.storage.local.get(keys);
  return Object.fromEntries(
    TARGET_HOSTS.map((targetHost) => [targetHost, stored[hostKey(targetHost)] || null])
  );
}

export async function ensureRuleState() {
  try {
    const st = await chrome.storage.local.get(CREATORS_OVERRIDE_ENABLED_KEY);
    const enabled = st && st[CREATORS_OVERRIDE_ENABLED_KEY];
    return !!enabled;
  } catch (e) {
    console.error('[Creators] ensureRuleState error', e);
    return false;
  }
}
