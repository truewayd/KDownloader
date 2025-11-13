// background/network.js - network helpers (API fetch, cookies)

export async function handleAPIRequest(url, headers = {}) {
  try {
    const resp = await fetch(url, { method: 'GET', headers, credentials: 'include', mode: 'cors' });
    if (!resp.ok) {
      if (resp.status === 403) throw new Error('Access denied (403).');
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const text = await resp.text();
    if (!text || !text.trim()) throw new Error('Empty API response');
    try { return JSON.parse(text); } catch (e) { throw new Error('Invalid JSON from API'); }
  } catch (e) {
    console.error('[Background] handleAPIRequest error', e);
    throw e;
  }
}

export async function getCookies(domain) {
  try {
    const cookies = await chrome.cookies.getAll({ domain });
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (e) {
    console.error('[Background] getCookies error', e);
    return '';
  }
}
