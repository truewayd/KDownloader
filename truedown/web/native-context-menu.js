// OS-owned popup surfaces; no menu DOM, extra WebView, or clipboard reads.
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  let pending, disposed = false, ready = false;
  const report = error => { if (!disposed) showToast(String(error?.message || error), "error"); };
  const taskActions = row => [...row.querySelectorAll("button[data-action]")]
    .filter(button => !button.disabled && button.getAttribute("aria-disabled") !== "true")
    .map(button => button.dataset.action);
  const invalidate = () => { pending = undefined; };
  listenNativeEvent("truedown:context-action", ({ payload }) => {
    const context = pending;
    if (!context || payload.token !== context.token || context.route !== location.hash) return;
    pending = undefined;
    if (context.row) {
      // Polling may have replaced controls or removed the task while the menu was open.
      if (!context.row.isConnected || !taskActions(context.row).includes(payload.action)) return;
      const button = [...context.row.querySelectorAll("button[data-action]")]
        .find(button => button.dataset.action === payload.action);
      button?.click();
    } else if (["new-task", "settings"].includes(payload.action)) {
      invoke("open_auxiliary", { kind: payload.action }).catch(report);
    }
  }).then(() => { ready = !disposed; }).catch(report);

  function open(event, keyboard = false) {
    if (event.defaultPrevented || disposed) return;
    const target = keyboard ? document.activeElement : event.target;
    if (!(target instanceof Element) || target.closest("[data-native-drag]")) return;
    event.preventDefault();
    invalidate();
    if (!ready || target.closest("[inert], [hidden]")) return;
    const input = target.closest("input, textarea");
    const editable = input && !input.disabled && (input.tagName === "TEXTAREA" || ["text", "search", "url", "tel", "email", "password", "number"].includes(input.type));
    const selected = input ? input.selectionEnd > input.selectionStart : Boolean(window.getSelection()?.toString());
    const unknownSelection = input && ["email", "number"].includes(input.type);
    let kind, row, actions = [];
    if (editable) {
      input.focus({ preventScroll: true });
      kind = input.readOnly ? "read-only" : input.type === "password" ? "password" : selected || unknownSelection ? "edit-selection" : "edit";
      // Password selections are never exposed through a copy menu.
      if (input.type === "password" && input.readOnly) return;
    } else if (target.isContentEditable) {
      kind = selected ? "edit-selection" : "edit";
    } else if (selected) {
      kind = "selection";
    } else if ((row = target.closest("tr[data-task-id]")) && nativeWindowRole === "main") {
      kind = "task";
      actions = taskActions(row);
    } else if (nativeWindowRole === "main" && !target.closest('[role="dialog"], input, textarea, select')) {
      kind = "workspace";
      actions = ["new-task", "settings"];
    } else return;
    const rect = target.getBoundingClientRect();
    const x = keyboard ? rect.left + Math.min(rect.width, 20) : event.clientX;
    const y = keyboard ? rect.bottom : event.clientY;
    const token = crypto.randomUUID();
    pending = { token, row, route: location.hash };
    invoke("show_context_menu", { request: { kind, token, actions,
      x: Math.max(0, Math.min(innerWidth - 1, x)), y: Math.max(0, Math.min(innerHeight - 1, y)) } }).catch(error => {
      if (pending?.token === token) invalidate();
      report(error);
    });
  }
  const contextmenu = event => open(event, event.button === 0 && event.clientX === 0 && event.clientY === 0);
  const keydown = event => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) open(event, true);
  };
  document.addEventListener("contextmenu", contextmenu);
  document.addEventListener("keydown", keydown);
  window.addEventListener("hashchange", invalidate);
  window.addEventListener("pagehide", () => {
    disposed = true; invalidate();
    document.removeEventListener("contextmenu", contextmenu);
    document.removeEventListener("keydown", keydown);
    window.removeEventListener("hashchange", invalidate);
  }, { once: true });
})();
