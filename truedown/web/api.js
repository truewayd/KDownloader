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
  if (!window.__TAURI__?.core?.invoke) throw new Error("请使用 TrueDown 桌面应用。");
  return nativeFetch(url, options);
}

let nativeDesktopState = null;
async function invokeNative(command, args) {
  try { return await window.__TAURI__.core.invoke(command, args); }
  catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
}
function apiRequestSignal(options, method) {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (method !== "GET") return signal;
  const deadline = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function nativeFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const signal = apiRequestSignal(options, method);
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
