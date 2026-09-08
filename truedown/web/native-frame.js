// The frame belongs to each local native window; HTTP dashboards keep the
// browser's frame. Resize events are coalesced, with no polling or retained
// request buffers while the user drags a window edge.
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  const platform = window.__TRUEDOWN_PLATFORM__;
  if (!invoke || !platform) return;
  const root = document.documentElement;
  root.dataset.nativeFrame = platform === "macos" ? "overlay" : "custom";
  const frame = document.createElement("header");
  frame.className = "native-titlebar";
  const drag = document.createElement("div");
  drag.className = "native-titlebar-drag";
  drag.dataset.nativeDrag = "";
  const title = document.createElement("span");
  title.className = "native-window-title";
  title.textContent = document.title;
  drag.append(title);
  frame.append(drag);
  const titleObserver = new MutationObserver(() => { title.textContent = document.title; });
  const titleElement = document.querySelector("title");
  if (titleElement) titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
  const report = (error) => {
    if (typeof showToast === "function") showToast(String(error?.message || error), "error");
    else console.error("Window operation failed:", error);
  };
  const act = (action) => invoke("frame_action", { action }).catch(report);
  let maximize, maximizeIcon, timer, updating = false, dirty = false, disposed = false;
  const refresh = async () => {
    dirty = true;
    if (updating || disposed) return;
    updating = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        const state = await invoke("frame_state");
        if (disposed || dirty) continue;
        root.dataset.maximized = String(state.maximized);
        if (maximize) {
          const label = state.maximized ? "向下还原" : "最大化";
          maximize.title = label;
          maximize.setAttribute("aria-label", label);
          maximizeIcon.setAttribute("href", `/icons.svg#icon-${state.maximized ? "restore" : "maximize"}`);
        }
      }
    } catch (error) { report(error); }
    finally { updating = false; }
  };
  if (platform !== "macos") {
    const controls = document.createElement("div");
    controls.className = "native-caption-controls";
    for (const [action, label] of [["minimize", "最小化"], ["maximize", "最大化"], ["close", "关闭窗口"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "native-caption-button";
      button.dataset.windowAction = action;
      button.title = label;
      button.setAttribute("aria-label", label);
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.classList.add("icon");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("focusable", "false");
      const use = document.createElementNS(icon.namespaceURI, "use");
      use.setAttribute("href", `/icons.svg#icon-${action}`);
      icon.append(use);
      button.append(icon);
      button.addEventListener("click", () => { act(action).then(refresh); });
      controls.append(button);
      if (action === "maximize") { maximize = button; maximizeIcon = use; }
    }
    frame.append(controls);
  }
  drag.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // The second press must not enter the OS drag loop before dblclick fires.
    if (event.detail === 2) act("maximize").then(refresh);
    else act("drag");
  });
  drag.addEventListener("contextmenu", (event) => {
    if (platform !== "windows") return;
    event.preventDefault();
    act("system-menu");
  });
  const keydown = (event) => {
    if (platform === "windows" && event.altKey && event.code === "Space") {
      event.preventDefault();
      act("system-menu");
    }
  };
  document.addEventListener("keydown", keydown);
  const resized = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 100);
  };
  window.addEventListener("resize", resized);
  window.addEventListener("focus", refresh);
  window.addEventListener("pagehide", () => {
    disposed = true;
    clearTimeout(timer);
    titleObserver.disconnect();
    document.removeEventListener("keydown", keydown);
    window.removeEventListener("resize", resized);
    window.removeEventListener("focus", refresh);
  }, { once: true });
  document.body.prepend(frame);
  refresh();
})();
