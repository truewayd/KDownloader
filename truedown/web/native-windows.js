// One role per native window. Browsers retain ordinary in-page routes.
const nativeWindowRole = window.__TAURI__?.core?.invoke
  ? new URLSearchParams(location.search).get("window") || "main" : "browser";

if (nativeWindowRole !== "browser") {
  document.documentElement.dataset.nativeWindow = nativeWindowRole;
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-route], [data-native-window]");
    const kind = link?.dataset.nativeWindow || link?.dataset.route;
    if (!["settings", "logs", "about", "new-task", "batch-task"].includes(kind) || kind === nativeWindowRole) return;
    event.preventDefault();
    invokeNative("open_auxiliary", { kind }).catch((error) => showToast(error.message, "error"));
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === ",") {
      event.preventDefault();
      invokeNative("open_auxiliary", { kind: "settings" }).catch((error) => showToast(error.message, "error"));
    }
    const dialogVisible = [...document.querySelectorAll('[role="dialog"]')].some((element) => !element.closest('[inert], [hidden]') && element.checkVisibility());
    if (nativeWindowRole !== "main" && !dialogVisible && (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w"))) {
      event.preventDefault();
      invokeNative("close_auxiliary").catch((error) => showToast(error.message, "error"));
    }
    if (nativeWindowRole === "settings" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      const save = document.getElementById("settings-save-btn");
      if (save?.checkVisibility() && !save.disabled) document.getElementById("settings-form").requestSubmit();
    }
  });
}
