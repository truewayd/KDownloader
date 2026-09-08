// System caption buttons remain owned and drawn by the OS.
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  const platform = window.__TRUEDOWN_PLATFORM__;
  if (!invoke || !platform) return;
  const root = document.documentElement;
  root.dataset.nativeFrame = platform === "macos" ? "overlay" : "native";
  let disposed = false, timer, updating = false, dirty = false;
  const report = error => {
    if (typeof showToast === "function") showToast(String(error?.message || error), "error");
    else console.error("Window operation failed:", error);
  };
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
    title.textContent = root.dataset.nativeWindow === "settings" ? "" : document.title;
    invoke("frame_title", { title: [...title.textContent].slice(0, 160).join("").replace(/[\u0000-\u001f\u007f]/g, " ") }).catch(report);
  };
  const observer = new MutationObserver(syncTitle);
  const source = document.querySelector("title");
  if (source) observer.observe(source, { childList: true, characterData: true, subtree: true });
  // macOS keeps an overlay drag strip beside its native traffic lights.
  if (platform === "macos") {
    const frame = document.createElement("header"), drag = document.createElement("div");
    frame.className = "native-titlebar";
    drag.className = "native-titlebar-drag";
    drag.dataset.nativeDrag = "";
    drag.append(title);
    frame.append(drag);
    drag.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      invoke("frame_action", { action: event.detail === 2 ? "maximize" : "drag" }).then(refresh).catch(report);
    });
    document.body.prepend(frame);
  }
  const resized = () => { clearTimeout(timer); timer = setTimeout(refresh, 100); };
  window.addEventListener("resize", resized);
  window.addEventListener("focus", refresh);
  window.addEventListener("pagehide", () => {
    disposed = true; clearTimeout(timer); observer.disconnect();
    window.removeEventListener("resize", resized);
    window.removeEventListener("focus", refresh);
  }, { once: true });
  syncTitle();
  refresh();
})();
