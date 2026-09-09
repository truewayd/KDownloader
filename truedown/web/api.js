async function requestText(url, options) {
  const response = await apiFetch(url, options);
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(text.trim() || response.statusText), { status: response.status });
  return text;
}

async function requestJSON(url, options) {
  const response = await apiFetch(url, options);
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(text.trim() || response.statusText), { status: response.status });
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("服务端返回了无效 JSON");
  }
}

async function apiFetch(url, options = {}) {
  if (window.__TAURI__?.core?.invoke) return nativeFetch(url, options);
  let response = await fetchWithAPIToken(url, options);
  if (response.status !== 401 || apiTokenPromptDismissed) return response;

  clearSessionToken();
  if (!apiTokenRequestPromise) {
    apiTokenRequestPromise = showDialog({
      title: "连接 TrueDown",
      eyebrow: "Authentication required",
      message: "此 TrueDown 正在远程接口上运行，请输入 API Key 以继续。Key 只保存在当前标签页会话中。",
      confirmLabel: "连接",
      inputLabel: "API Key",
      inputType: "password",
      validate: (value) => {
        const normalized = value.trim();
        return normalized.length < 32 || normalized.length > 256 || !/^[\x20-\x7e]+$/.test(normalized)
          ? "API Key 应为 32–256 个可打印 ASCII 字符。"
          : "";
      },
    }).finally(() => { apiTokenRequestPromise = null; });
  }
  const supplied = await apiTokenRequestPromise;
  if (supplied === null) {
    apiTokenPromptDismissed = true;
    return response;
  }
  const normalized = supplied.trim();
  rememberSessionToken(normalized);

  response = await fetchWithAPIToken(url, options);
  if (response.status === 401) {
    clearSessionToken();
    apiTokenPromptDismissed = true;
  }
  return response;
}

let nativeDesktopState = null;
async function invokeNative(command, args) {
  try { return await window.__TAURI__.core.invoke(command, args); }
  catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
}
async function nativeFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const signal = options.signal || (method === "GET" ? AbortSignal.timeout(15_000) : undefined);
  signal?.throwIfAborted();
  const headers = Object.fromEntries(new Headers(options.headers || {}));
  const operation = invokeNative("core_request", {
    request: { method, path, body: options.body || "", headers },
  });
  let abort;
  const canceled = signal && new Promise((_, reject) => {
    abort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await (canceled ? Promise.race([operation, canceled]) : operation);
    nativeDesktopState = { owned: result.owned, protocolVersion: 1 };
    return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
      status: result.status, headers: result.headers,
    });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function rememberSessionToken(token) {
  apiToken = token;
  try {
    window.sessionStorage.setItem(API_TOKEN_SESSION_KEY, apiToken);
  } catch {
    // The token still remains in memory for this page when session storage is unavailable.
  }
}

function fetchWithAPIToken(url, options) {
  const headers = new Headers(options.headers || {});
  if (apiToken) headers.set("X-Api-Key", apiToken);
  const signal = options.signal || ((options.method || "GET") === "GET" ? AbortSignal.timeout(15_000) : undefined);
  return fetch(url, { ...options, headers, signal });
}

function readSessionToken() {
  try {
    const token = window.sessionStorage.getItem(API_TOKEN_SESSION_KEY) || "";
    if (token.length >= 32 && token.length <= 256 && token.trim() === token && /^[\x20-\x7e]+$/.test(token)) {
      return token;
    }
    window.sessionStorage.removeItem(API_TOKEN_SESSION_KEY);
    return "";
  } catch {
    return "";
  }
}

function clearSessionToken() {
  apiToken = "";
  try {
    window.sessionStorage.removeItem(API_TOKEN_SESSION_KEY);
  } catch {
    // Ignore storage restrictions; the in-memory token has already been cleared.
  }
}
