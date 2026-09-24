(() => {
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  const definitions = {
    details: ["任务详情", "info"], pause: ["暂停", "pause"], resume: ["继续", "play"], requeue: ["重试", "retry"],
    "open-file": ["打开文件", "file"], "open-folder": ["打开下载目录", "folder-open"], remove: ["移除任务", "trash"],
    "new-task": ["新建下载", "plus"], settings: ["设置", "settings"],
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
  document.addEventListener("keydown", event => {
    const items = [...menu.querySelectorAll("button")];
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); answer(null); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });
  (async () => {
    const actions = await invoke("context_menu_init");
    const mac = window.__TRUEDOWN_PLATFORM__ === "macos";
    for (const action of actions) {
      const [label, icon, shortcut] = definitions[action];
      const button = document.createElement("button");
      button.type = "button"; button.className = "popup-menu-item"; button.dataset.action = action;
      button.setAttribute("role", "menuitem"); button.tabIndex = -1;
      if (action === "remove") button.classList.add("danger");
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
  })().catch(() => answer(null));
})();
