// content/paw_api_bridge.js - same-origin Pawchive API bridge for Cloudflare
(() => {
  const PAW_ORIGIN = 'https://pawchive.pw';
  const REQUEST_TIMEOUT_MS = 45 * 1000;
  const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
  const RESPONSE_HEADER_NAMES = [
    'cf-mitigated',
    'cf-ray',
    'content-type',
    'server',
  ];

  function normalizeApiUrl(value) {
    const url = new URL(String(value || ''), location.origin);
    if (location.origin !== PAW_ORIGIN
      || url.origin !== PAW_ORIGIN
      || url.username
      || url.password
      || !url.pathname.startsWith('/api/v1/')) {
      throw new Error('Rejected non-Pawchive API bridge request');
    }
    return url.toString();
  }

  function safeHeaders(value) {
    const input = value && typeof value === 'object' ? value : {};
    const output = {};
    for (const [name, headerValue] of Object.entries(input)) {
      if (!/^(accept|accept-language|cache-control|pragma)$/i.test(name)) continue;
      const normalized = String(headerValue).trim();
      if (normalized && normalized.length <= 4096 && !/[\0\r\n]/.test(normalized)) {
        output[name] = normalized;
      }
    }
    return output;
  }

  async function readLimitedText(response, maxResponseBytes) {
    const reader = response.body && typeof response.body.getReader === 'function'
      ? response.body.getReader()
      : null;
    if (!reader) {
      const body = await response.text();
      if (new Blob([body]).size > maxResponseBytes) {
        throw new Error('Pawchive API response is too large for the extension bridge');
      }
      return body;
    }
    let bytes = new Uint8Array(Math.min(maxResponseBytes, 64 * 1024));
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (chunk.byteLength > maxResponseBytes - received) {
          try { await reader.cancel(); } catch (error) { /* preserve the size error */ }
          throw new Error('Pawchive API response is too large for the extension bridge');
        }
        const required = received + chunk.byteLength;
        if (required > bytes.byteLength) {
          let capacity = bytes.byteLength;
          while (capacity < required) {
            capacity = Math.min(maxResponseBytes, Math.max(required, capacity * 2));
          }
          const grown = new Uint8Array(capacity);
          grown.set(bytes.subarray(0, received));
          bytes = grown;
        }
        bytes.set(chunk, received);
        received = required;
      }
      return new TextDecoder().decode(bytes.subarray(0, received));
    } finally {
      reader.releaseLock?.();
    }
  }

  async function cancelResponseBody(response) {
    try { await response.body?.cancel?.(); } catch (error) { /* preserve the boundary error */ }
  }

  async function fetchApi(message) {
    const url = normalizeApiUrl(message.url);
    const requestedLimit = Number(message.maxResponseBytes);
    const maxResponseBytes = Number.isSafeInteger(requestedLimit)
      && requestedLimit > 0
      && requestedLimit <= MAX_RESPONSE_BYTES
      ? requestedLimit
      : MAX_RESPONSE_BYTES;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: safeHeaders(message.headers),
        credentials: 'include',
        cache: 'no-store',
        // Do not let an API redirect turn this same-origin bridge into an
        // unintended cross-origin credentialed request.
        redirect: 'error',
        signal: controller.signal,
      });
      const declaredBytes = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
        await cancelResponseBody(response);
        throw new Error('Pawchive API response is too large for the extension bridge');
      }
      normalizeApiUrl(response.url);
      const body = await readLimitedText(response, maxResponseBytes);
      const headers = {};
      for (const name of RESPONSE_HEADER_NAMES) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      }
      return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        headers,
        body,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === 'pawchive.api.ping') {
      sendResponse({ ready: location.origin === PAW_ORIGIN });
      return false;
    }
    if (!message || message.action !== 'pawchive.api.fetch') return false;
    fetchApi(message).then(
      (response) => sendResponse({ success: true, response }),
      (error) => sendResponse({
        success: false,
        error: error && error.message ? error.message : String(error),
      })
    );
    return true;
  });
})();
