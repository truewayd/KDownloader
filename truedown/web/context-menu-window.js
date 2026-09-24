(() => {
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  const definitions = {
    details: ["任务详情", "info"], pause: ["暂停", "pause"], resume: ["继续", "play"], requeue: ["重试", "retry"],
    "open-file": ["打开文件", "file"], "open-folder": ["打开下载目录", "folder-open"], remove: ["移除任务", "trash"],
    "new-task": ["新建下载", "plus"], settings: ["设置", "settings"],
    "group-show": ["查看此分组", "folder-open"], "group-edit": ["调整此分组", "settings"],
    "group-add": ["新增分组", "plus"], "group-manage": ["管理分组", "folder"],
    "pause-queue": ["暂停整个队列", "pause"], "resume-queue": ["恢复整个队列", "play"],
    "retry-all": ["重试所有失败任务", "retry"], "clear-done": ["清理所有已完成记录", "trash"],
    "open-downloads": ["打开默认下载目录", "folder-open"],
    undo: ["撤销", "undo", "Z"], redo: ["重做", "redo", "Y"], cut: ["剪切", "cut", "X"], copy: ["复制", "copy", "C"],
    paste: ["粘贴", "paste", "V"], "select-all": ["全选", "select-all", "A"],
  };
  const menu = document.getElementById("menu");
  let busy = false;
  async function answer(action) {
    if (busy) return;
    busy = true;
    try { await invoke("context_menu_answer", { action }); }
    catch { busy = false; }
  }
  document.addEventListener("contextmenu", event => event.preventDefault());
  window.navigateContextMenu = key => {
    const items = [...menu.querySelectorAll("button")];
    if (["Enter", " "].includes(key)) {
      if (items.includes(document.activeElement)) document.activeElement.click();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key) || !items.length) return;
    const index = items.indexOf(document.activeElement);
    const next = key === "Home" ? 0 : key === "End" ? items.length - 1 : (index + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); answer(null); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
      event.preventDefault(); window.navigateContextMenu(event.key);
    }
  });
  let initializing = false, initialized = false, refreshQueued = false;
  window.refreshContextMenu = async () => {
    if (initialized) return;
    if (initializing) { refreshQueued = true; return; }
    initializing = true;
    try {
    const actions = await invoke("context_menu_init");
    if (!actions) return;
    const mac = window.__TRUEDOWN_PLATFORM__ === "macos";
    for (const action of actions) {
      const [label, icon, shortcut] = definitions[action];
      const button = document.createElement("button");
      button.type = "button"; button.className = "popup-menu-item"; button.dataset.action = action;
      button.setAttribute("role", "menuitem"); button.tabIndex = -1;
      if (["remove", "clear-done"].includes(action)) button.classList.add("danger");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("icon"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      const use = document.createElementNS(svg.namespaceURI, "use"); use.setAttribute("href", `/icons.svg#icon-${icon}`); svg.append(use);
      const text = document.createElement("span"); text.textContent = label;
      const hint = document.createElement("span"); hint.className = "popup-menu-shortcut"; hint.setAttribute("aria-hidden", "true");
      hint.textContent = shortcut ? (mac ? "⌘" : "Ctrl+") + (mac && action === "redo" ? "⇧Z" : shortcut) : "";
      button.append(svg, text, hint); button.addEventListener("click", () => answer(action));
      button.addEventListener("pointermove", () => button.focus({ preventScroll: true }));
      menu.append(button);
    }
    menu.querySelector("button")?.focus();
    await invoke("context_menu_ready");
    initialized = true; window.__popupActive = true;
    } catch { answer(null); }
    finally { initializing = false; if (refreshQueued) { refreshQueued = false; window.refreshContextMenu(); } }
  };
  window.__popupLoaded = true;
  window.refreshContextMenu();
})();
