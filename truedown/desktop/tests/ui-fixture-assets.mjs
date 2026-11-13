import { readFile } from "node:fs/promises";

// Browser layout fixtures supply their own transport; production UI uses IPC only.
export async function readUIFixtureAsset(name, assets) {
  const source = await readFile(new URL(name, assets));
  // Existing visual fixtures exercise the Chinese UI regardless of host locale.
  if (name === "i18n.js") return 'localStorage.setItem("truedown-language-v1", "zh-CN");\n' + source;
  if (name !== "api.js") return source;
  return source.toString("utf8") + `
if (!window.__TAURI__?.core?.invoke) {
  apiFetch = (url, options = {}) => fetch(url, {
    ...options,
    signal: apiRequestSignal(options, (options.method || "GET").toUpperCase()),
  });
}
`;
}
