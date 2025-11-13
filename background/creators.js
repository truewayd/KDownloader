// background/creators.js - manage creators override cache and page-level push to site storage
import { CREATORS_OVERRIDE_KEY, CREATORS_OVERRIDE_ENABLED_KEY, API } from './constants.js';

const TARGET_HOSTS = API.HOSTS;
const KEY_BASE = CREATORS_OVERRIDE_KEY; // will store per-host as KEY_BASE + '_' + host

function hostKey(host) {
  return `${KEY_BASE}_${host}`;
}

// Fetch real creators.json from a host using Accept: text/css to bypass DDoS guard heuristics
async function fetchCreatorsFromHost(host) {
  const url = `https://${host}${API.API_PREFIX}${API.CREATORS_PATH}`;
  const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'text/css' }, cache: 'no-store', credentials: 'omit' });
  const txt = await res.text();
  try {
    return JSON.parse(txt);
  } catch (e) {
    const m = txt.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (ee) { throw new Error('Failed to parse creators response'); }
    }
    throw new Error('Creators fetch returned non-JSON response');
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
    console.log('[Creators] updateCacheFromNetwork start', host);
    const data = await fetchCreatorsFromHost(host);
    console.log('[Creators] fetch ok', host, Array.isArray(data) ? `items:${data.length}` : typeof data);
    // For kemono.cr, if a creator with id 105486 exists, rename its name to 'Cached' for debugging
    try {
      if (host === 'kemono.cr' && Array.isArray(data)) {
        const targetId = '105486';
        let found = false;
        for (let i = 0; i < data.length; i++) {
          const d = data[i];
          if (!d) continue;
          if (String(d.id) === String(targetId)) {
            d.name = 'Cached';
            found = true;
            console.log('[Creators] renamed creator id', targetId, '-> name Cached');
            break;
          }
        }
        if (!found) console.log('[Creators] creator id 105486 not found in fetched data');
      }
    } catch (e) { console.warn('[Creators] rename cached failed', e); }

    const payload = { updatedAt: Date.now(), sourceHost: host, data };
    // store large JSON into chrome.storage.local as string to avoid structure clone overhead
    const text = JSON.stringify(payload);
    try {
      await chrome.storage.local.set({ [hostKey(host)]: { __text: text } });
    } catch (e) {
      console.error('[Creators] storage.set payload failed', e);
      throw e;
    }
    // also store small meta
    try { await chrome.storage.local.set({ [`${hostKey(host)}_meta`]: { updatedAt: payload.updatedAt, sourceHost: payload.sourceHost } }); } catch (e) { console.warn('[Creators] write meta failed', e); }
    // light notify pages
    try {
      const tabs = await chrome.tabs.query({ url: [`*://${host}/*`] });
      for (const t of tabs) {
        try { chrome.tabs.sendMessage(t.id, { action: 'creators.pagePull', host }, () => { void chrome.runtime.lastError; }); } catch (e) { }
      }
    } catch (e) { console.warn('[Creators] notify tabs pagePull failed', e); }
    return { updatedAt: payload.updatedAt, sourceHost: payload.sourceHost };

  }

  // update both hosts and return map
  const result = {};
  for (const h of TARGET_HOSTS) {
    try {
      result[h] = await updateCacheFromNetwork(h);
    } catch (e) {
      console.error('[Creators] update failed for', h, e);
      result[h] = { error: e && e.message ? e.message : String(e) };
    }
  }
  return result;
}

export async function getCachedCreators(host) {
  if (host) {
    const st = await chrome.storage.local.get(hostKey(host));
    return st && st[hostKey(host)] ? st[hostKey(host)] : null;
  }
  // return mapping for all
  const map = {};
  for (const h of TARGET_HOSTS) {
    const st = await chrome.storage.local.get(hostKey(h));
    map[h] = st && st[hostKey(h)] ? st[hostKey(h)] : null;
  }
  return map;
}

export async function ensureRuleState() {
  try {
    const st = await chrome.storage.local.get(CREATORS_OVERRIDE_ENABLED_KEY);
    const enabled = st && st[CREATORS_OVERRIDE_ENABLED_KEY];
    console.log('[Creators] ensureRuleState', { enabled });
  } catch (e) {
    console.error('[Creators] ensureRuleState error', e);
  }
}
