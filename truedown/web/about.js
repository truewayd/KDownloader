async function loadAbout(initial = false) {
  const epoch = routeEpoch;
  try {
    const [info, state] = await Promise.all([
      requestJSON("/system/info"),
      window.__TAURI__?.core?.invoke ? invokeNative("desktop_state") : Promise.resolve(null),
      loadAboutNotices(), loadSystemUpdateState(),
    ]);
    if (initial !== true && (currentPage !== "settings" || currentSettingsPage !== "about" || routeEpoch !== epoch)) return;
    document.getElementById("about-version").textContent = info.productVersion || info.version;
    document.getElementById("about-build").textContent = `${info.buildNumber} / ${String(info.commit || "").slice(0, 12)}`;
    document.getElementById("about-connection").setAttribute("data-i18n-text", state ? state.owned ? "桌面托管" : "独立本地服务" : "HTTP 控制台");
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

let aboutNoticesLoad;
function loadAboutNotices() {
  return aboutNoticesLoad ||= loadNoticeAsset("/open-source.js", "TrueDownOpenSource").then(renderOpenSourceNotices).catch(error => {
    aboutNoticesLoad = null;
    throw error;
  });
}

function loadNoticeAsset(src, key) {
  if (window[key] !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    const fail = () => { script.remove(); reject(new Error(src)); };
    script.onload = () => window[key] !== undefined ? resolve() : fail();
    script.onerror = fail;
    document.head.append(script);
  });
}

function renderOpenSourceNotices() {
  const host = document.getElementById("open-source-projects");
  if (!host || host.childElementCount || !window.TrueDownOpenSource) return;
  for (const project of window.TrueDownOpenSource.projects) {
    const entry = document.createElement("li");
    entry.className = "open-source-project";
    const link = document.createElement("a");
    link.href = project.url;
    link.textContent = project.name;
    link.className = "open-source-project-link kd-selectable";
    link.append(KDComponents.createSpriteIcon("/icons.svg#icon-external-link"));
    const license = document.createElement("span");
    license.className = "open-source-project-license kd-selectable";
    license.setAttribute("data-i18n-text", project.license);
    license.textContent = project.license;
    const usage = document.createElement("p");
    usage.className = "hint";
    usage.textContent = project.usage;
    entry.append(link, license, usage);
    host.append(entry);
  }
  const details = document.getElementById("open-source-licenses");
  const notices = document.getElementById("license-notices");
  let loading = false;
  async function showLicenses() {
    if (!details.open || loading) return;
    loading = true;
    notices.textContent = TrueDownI18n.t("正在读取…");
    try {
      await loadNoticeAsset("/native-license-notices.js", "TrueDownNativeLicenseNotices");
      if (!details.open) return;
      notices.textContent = window.TrueDownOpenSource.notices + "\n\n" + window.TrueDownNativeLicenseNotices;
      details.removeEventListener("toggle", showLicenses);
    } catch {
      notices.textContent = TrueDownI18n.t("读取许可证失败，请收起后重新展开。");
    } finally {
      loading = false;
    }
  }
  details.addEventListener("toggle", showLicenses);
  showLicenses();
}
