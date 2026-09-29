// System caption buttons remain owned and drawn by the OS.
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  const platform = window.__TRUEDOWN_PLATFORM__;
  if (!invoke || !platform) return;
  const root = document.documentElement;
  root.dataset.nativeFrame = platform === "macos" ? "overlay" : platform === "windows" ? "custom" : "native";
  let disposed = false, timer, updating = false, dirty = false;
  const report = error => {
    if (typeof showToast === "function") showToast(String(error?.message || error), "error");
    else console.error("Window operation failed:", error);
  };
  // Keep the shared DOM tooltip; expose only its rounded footprint through the
  // native caption exclusion. Coalesce layouts and serialize show/hide IPC.
  let tooltipSession = 0, tooltipRevision = 0, tooltipPending, tooltipSending = false;
  const flushTooltip = async () => {
    if (!tooltipSession || tooltipSending) return;
    tooltipSending = true;
    try {
      while (tooltipPending !== undefined) {
        const bounds = tooltipPending;
        tooltipPending = undefined;
        await invoke("frame_tooltip", { session: tooltipSession, revision: ++tooltipRevision, bounds });
      }
    } catch (error) {
      delete root.dataset.nativeTooltip;
      document.removeEventListener("kd-tooltip-layout", tooltipLayout);
      KDComponents.installTooltips().hide();
      // A failed reveal must not leave caption pixels exposed.
      tooltipPending = undefined;
      await invoke("frame_tooltip", { session: tooltipSession, revision: ++tooltipRevision, bounds: null }).catch(console.error);
      console.error("Native tooltip layout failed:", error);
    } finally { tooltipSending = false; }
  };
  const tooltipLayout = event => {
    tooltipPending = disposed ? null : event.detail;
    void flushTooltip();
  };
  if (platform === "windows") {
    document.addEventListener("kd-tooltip-layout", tooltipLayout);
    invoke("frame_tooltip", { session: 0, revision: 0, bounds: null }).then(session => {
      if (!Number.isInteger(session) || session <= 0) throw new Error("Invalid native tooltip session");
      tooltipSession = session;
      if (!disposed) root.dataset.nativeTooltip = "true";
      void flushTooltip();
    }).catch(error => {
      document.removeEventListener("kd-tooltip-layout", tooltipLayout);
      console.error("Native tooltip initialization failed:", error);
    });
  }
  const refresh = async () => {
    dirty = true;
    if (updating || disposed) return;
    updating = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        const state = await invoke("frame_state");
        if (!disposed && !dirty) root.dataset.maximized = String(state.maximized);
      }
    } catch (error) { report(error); }
    finally { updating = false; }
  };
  const title = document.createElement("span");
  title.className = "native-window-title";
  const syncTitle = () => {
    title.textContent = document.title;
    invoke("frame_title", { title: [...title.textContent].slice(0, 160).join("").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ") }).catch(report);
  };
  const observer = new MutationObserver(syncTitle);
  const source = document.querySelector("title");
  if (source) observer.observe(source, { childList: true, characterData: true, subtree: true });
  // The Windows WebView is natively clipped around the DWM caption buttons.
  if (platform === "macos" || platform === "windows") {
    const frame = document.createElement("header"), drag = document.createElement("div");
    frame.className = "native-titlebar";
    drag.className = "native-titlebar-drag";
    drag.dataset.nativeDrag = "";
    const iconName = { "new-task": "download", "task-details": "info" }[root.dataset.nativeWindow];
    if (iconName) {
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      icon.setAttribute("class", "icon native-window-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("focusable", "false");
      use.setAttribute("href", `/icons.svg#icon-${iconName}`);
      icon.append(use);
      drag.append(icon);
    }
    if (root.dataset.nativeWindow !== "settings") drag.append(title);
    frame.append(drag);
    drag.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      invoke("frame_action", { action: event.detail === 2 ? "maximize" : "drag" }).then(refresh).catch(report);
    });
    drag.addEventListener("contextmenu", event => {
      if (platform !== "windows") return;
      event.preventDefault();
      invoke("frame_action", { action: "system-menu" }).catch(report);
    });
    document.body.prepend(frame);
  }
  const resized = () => { clearTimeout(timer); timer = setTimeout(refresh, 100); };
  window.addEventListener("resize", resized);
  window.addEventListener("focus", refresh);
  window.addEventListener("pagehide", () => {
    disposed = true; clearTimeout(timer); observer.disconnect();
    document.removeEventListener("kd-tooltip-layout", tooltipLayout);
    tooltipPending = null;
    void flushTooltip();
    window.removeEventListener("resize", resized);
    window.removeEventListener("focus", refresh);
  }, { once: true });
  syncTitle();
  refresh();
})();
