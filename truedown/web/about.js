async function loadAbout(initial = false) {
  if (currentPage === "settings" && currentSettingsPage === "about") renderOpenSourceNotices();
  const epoch = routeEpoch;
  try {
    const [info, update, state] = await Promise.all([
      requestJSON("/system/info"), requestJSON("/system/update"),
      window.__TAURI__?.core?.invoke ? invokeNative("desktop_state") : Promise.resolve(null),
    ]);
    if (initial !== true && (currentPage !== "settings" || currentSettingsPage !== "about" || routeEpoch !== epoch)) return;
    document.getElementById("about-version").textContent = info.productVersion || info.version;
    document.getElementById("about-build").textContent = `${info.buildNumber} / ${String(info.commit || "").slice(0, 12)}`;
    document.getElementById("about-engine").textContent = `${update.engine?.active === "next" ? "Aria2 Next" : "aria2"} ${update.engine?.activeVersion || ""}`;
    document.getElementById("about-connection").textContent = state ? state.owned ? "\u684c\u9762\u6258\u7ba1" : "\u72ec\u7acb\u672c\u5730\u670d\u52a1" : "HTTP \u63a7\u5236\u53f0";
    document.getElementById("about-status").textContent = "";
    cancelReadRetry("about");
  } catch (error) {
    if (initial === true) throw error;
    if (currentPage === "settings" && currentSettingsPage === "about" && routeEpoch === epoch) {
      document.getElementById("about-status").textContent = `读取失败，正在自动重试：${error.message}`;
      scheduleReadRetry("about", loadAbout, () => currentPage === "settings" && currentSettingsPage === "about" && routeEpoch === epoch);
    }
  }
}

function renderOpenSourceNotices() {
  const host = document.getElementById("open-source-projects");
  if (!host || host.childElementCount || !window.TrueDownOpenSource) return;
  for (const project of window.TrueDownOpenSource.projects) {
    const entry = document.createElement("div");
    const link = document.createElement("a");
    link.href = project.url;
    link.textContent = project.name;
    link.className = "kd-selectable";
    const license = document.createElement("span");
    license.textContent = project.license;
    const usage = document.createElement("p");
    usage.className = "hint";
    usage.textContent = project.usage;
    entry.append(link, license, usage);
    host.append(entry);
  }
  const details = document.getElementById("open-source-licenses");
  details.addEventListener("toggle", () => {
    if (details.open) document.getElementById("license-notices").textContent = window.TrueDownOpenSource.notices + "\n\n" + window.TrueDownNativeLicenseNotices;
  });
}
