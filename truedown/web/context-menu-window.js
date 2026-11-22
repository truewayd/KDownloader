(() => {
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  const menu = document.getElementById("menu");
  let busy = false;
  async function answer(action) {
    if (busy) return;
    busy = true;
    try { await invoke("context_menu_answer", { action }); }
    catch { busy = false; }
  }
  document.addEventListener("contextmenu", event => event.preventDefault());
  window.navigateContextMenu = key => navigateTaskMenu(menu, key);
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
    for (const action of actions) {
      const button = createTaskMenuItem(action, actions, true);
      if (!button) continue;
      button.addEventListener("click", () => answer(action));
      button.addEventListener("pointermove", () => button.focus({ preventScroll: true }));
      menu.append(button);
    }
    menu.querySelector("button:enabled")?.focus();
    await invoke("context_menu_ready");
    initialized = true; window.__popupActive = true;
    } catch { answer(null); }
    finally { initializing = false; if (refreshQueued) { refreshQueued = false; window.refreshContextMenu(); } }
  };
  window.__popupLoaded = true;
  window.refreshContextMenu();
})();
