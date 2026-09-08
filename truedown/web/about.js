async function loadAbout() {
  const epoch = routeEpoch;
  try {
    const [info, update, state] = await Promise.all([
      requestJSON("/system/info"), requestJSON("/system/update"),
      window.__TAURI__?.core?.invoke ? invokeNative("desktop_state") : Promise.resolve(null),
    ]);
    if (currentPage !== "settings" || currentSettingsPage !== "about" || routeEpoch !== epoch) return;
    document.getElementById("about-version").textContent = info.productVersion || info.version;
    document.getElementById("about-build").textContent = `${info.buildNumber} / ${String(info.commit || "").slice(0, 12)}`;
    document.getElementById("about-engine").textContent = `${update.engine?.active === "next" ? "Aria2 Next" : "aria2"} ${update.engine?.activeVersion || ""}`;
    document.getElementById("about-connection").textContent = state ? state.owned ? "\u684c\u9762\u6258\u7ba1" : "\u72ec\u7acb\u672c\u5730\u670d\u52a1" : "HTTP \u63a7\u5236\u53f0";
    document.getElementById("about-status").textContent = "";
  } catch (error) {
    if (currentPage === "settings" && currentSettingsPage === "about" && routeEpoch === epoch) {
      document.getElementById("about-status").textContent = `\u8bfb\u53d6\u5931\u8d25\uff1a${error.message}`;
    }
  }
}
