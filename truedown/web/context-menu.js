// Resolve the clicked surface before collecting its currently available actions.
(() => {
  let current = null, disposed = false;
  let requestID = Date.now() % 0x80000000;
  const role = () => typeof nativeWindowRole === "undefined" ? "browser" : nativeWindowRole;
  const report = error => { if (!disposed) showToast(String(error?.message || error), "error"); };
  const enabled = button => !button.disabled && button.getAttribute("aria-disabled") !== "true";
  const taskButtons = row => [...row.querySelectorAll("button[data-action]")].filter(enabled);
  const available = element => element?.isConnected && !element.closest("[inert], [hidden]") && element.checkVisibility();
  const controls = {
    "pause-queue": "pause-queue-btn", "resume-queue": "resume-queue-btn", "retry-all": "retry-all-btn",
    "clear-done": "clear-done-btn", "open-downloads": "open-downloads-btn",
  };
  const control = action => document.getElementById(controls[action]);
  const controlEnabled = action => available(control(action)) && enabled(control(action));
  const labels = {
    details: "\u4efb\u52a1\u8be6\u60c5", pause: "\u6682\u505c", resume: "\u7ee7\u7eed", requeue: "\u91cd\u8bd5",
    "open-file": "\u6253\u5f00\u6587\u4ef6", "open-folder": "\u6253\u5f00\u4e0b\u8f7d\u76ee\u5f55", remove: "\u79fb\u9664\u4efb\u52a1",
    "new-task": "\u65b0\u5efa\u4e0b\u8f7d", settings: "\u8bbe\u7f6e",
    "group-edit": "调整此分组", "group-add": "新增分组", "group-manage": "管理分组",
    "pause-queue": "暂停整个队列", "resume-queue": "恢复整个队列", "retry-all": "重试所有失败任务",
    "clear-done": "清理所有已完成记录", "open-downloads": "打开默认下载目录",
    undo: "\u64a4\u9500", redo: "\u91cd\u505a", cut: "\u526a\u5207", copy: "\u590d\u5236", paste: "\u7c98\u8d34", "select-all": "\u5168\u9009",
  };
  const shortcuts = { undo: "Z", redo: "Y", cut: "X", copy: "C", paste: "V", "select-all": "A" };
  const modifier = window.__TRUEDOWN_PLATFORM__ === "macos" ? "\u2318" : "Ctrl+";

  function close(restore = true) {
    const context = current;
    if (!context) return;
    current = null;
    context.observer?.disconnect();
    if (context.native) invokeNative("context_menu_cancel", { requestId: context.requestId }).catch(() => {});
    context.menu.remove();
    if (restore && available(context.focus)) context.focus.focus({ preventScroll: true });
  }

  function restoreSelection(context) {
    if (context.input) {
      context.input.focus({ preventScroll: true });
      if (context.selection) context.input.setSelectionRange(...context.selection);
    } else if (context.ranges.length) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      context.ranges.forEach(range => selection.addRange(range));
    }
  }

  async function activate(context, action) {
    if (current !== context) return;
    close();
    if (context.route !== location.hash || !available(context.target)) return;
    if (context.row) {
      // Polling may remove the task or change which actions are allowed.
      if (context.row.dataset.taskId !== context.taskID) return;
      taskButtons(context.row).find(button => button.dataset.action === action)?.click();
    } else if (["group-edit", "group-add", "group-manage"].includes(action)) {
      if (action === "group-edit" && context.group?.dataset.taskCategory !== context.groupID) return;
      const groupId = action === "group-edit" ? context.groupID : null;
      const add = action === "group-add";
      if (role() === "browser") {
        const hash = `#settings/files${groupId ? `/group/${encodeURIComponent(groupId)}` : add ? "/add-group" : ""}`;
        if (location.hash === hash) focusFileGroupRoute();
        else location.hash = hash;
      } else await invokeNative("open_group_settings", { groupId, add });
    } else if (Object.hasOwn(controls, action)) {
      if (controlEnabled(action)) control(action).click();
    } else if (action === "new-task") {
      await openModal();
    } else if (action === "settings") {
      if (role() === "browser") location.hash = "settings/general";
      else await invokeNative("open_auxiliary", { kind: "settings" });
    } else {
      if (context.input?.disabled || (context.input?.readOnly && !["copy", "select-all"].includes(action))) return;
      if (context.input?.type === "password" && ["copy", "cut"].includes(action)) return;
      restoreSelection(context);
      if (action === "select-all" && context.input?.select) context.input.select();
      else if (window.__TAURI__?.core?.invoke) await invokeNative("edit_action", { action });
      else if (!document.execCommand(action === "select-all" ? "selectAll" : action)) {
        throw new Error("\u8bf7\u4f7f\u7528\u952e\u76d8\u5feb\u6377\u952e\u5b8c\u6210\u6b64\u7f16\u8f91\u64cd\u4f5c");
      }
    }
  }

  function open(event, keyboard = false) {
    if (event.defaultPrevented || disposed) return;
    const target = keyboard ? document.activeElement : event.target;
    if (!(target instanceof Element) || target.closest("[data-native-drag]")) return;
    event.preventDefault();
    close(false);
    if (!available(target)) return;
    const input = target.closest("input, textarea");
    const editable = input && !input.disabled && (input.tagName === "TEXTAREA" || ["text", "search", "url", "tel", "email", "password", "number"].includes(input.type));
    const selection = window.getSelection();
    const selected = input ? input.selectionEnd > input.selectionStart
      : Boolean(selection?.toString() && selection.containsNode(target, true));
    let row, group, actions = [];
    if (editable || target.isContentEditable) {
      if (input?.readOnly) actions = input.type === "password" ? ["select-all"] : ["copy", "select-all"];
      else {
        actions = ["undo", "redo"];
        if ((selected || ["email", "number"].includes(input?.type)) && input?.type !== "password") actions.push("cut", "copy");
        actions.push("paste", "select-all");
      }
    } else if (selected && !input) actions = ["copy", "select-all"];
    else if (["main", "browser"].includes(role()) && (row = target.closest("tr[data-task-id]"))) {
      actions = taskButtons(row).map(button => button.dataset.action).filter(action => labels[action]);
    } else if (["main", "browser"].includes(role()) && !target.closest('[role="dialog"], dialog, input, textarea, select')) {
      if ((group = target.closest("#file-group-navigation [data-task-category]"))) {
        selectFileGroup(group);
        group.focus({ preventScroll: true });
        actions = ["group-edit", "group-add", "group-manage"];
      } else if (target.closest('button, a, [role="button"]')) {
        actions = [];
      } else if (target.closest(".primary-nav")) {
        actions = ["new-task", "group-add", "group-manage"];
      } else if (target.closest('#tasks-page')) {
        // Queue actions are global, even when the list is filtered to one group.
        actions = ["new-task", ...Object.keys(controls).filter(controlEnabled)];
      } else if (target.closest("#workspace-sidebar")) actions = ["new-task", "group-manage", "settings"];
    }
    if (!actions.length) return;
    const menu = document.createElement("div");
    menu.className = "kd-context-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "\u64cd\u4f5c\u83dc\u5355");
    const topLayer = typeof menu.showPopover === "function";
    if (topLayer) menu.setAttribute("popover", "manual");
    const context = { menu, target, input, row, taskID: row?.dataset.taskId, group, groupID: group?.dataset.taskCategory, route: location.hash, focus: input || group || (target.isContentEditable ? target : document.activeElement),
      selection: input && typeof input.selectionStart === "number" ? [input.selectionStart, input.selectionEnd, input.selectionDirection] : null,
      ranges: selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [] };
    if (window.__TAURI__?.core?.invoke) {
      const rect = target.getBoundingClientRect();
      context.native = true;
      context.keyboard = keyboard;
      context.requestId = ++requestID % 0xffffffff;
      current = context;
      context.observer = new MutationObserver(() => { if (!available(target)) close(false); });
      context.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "hidden"] });
      invokeNative("show_context_menu", {
        requestId: context.requestId, actions, keyboard,
        x: keyboard || !Number.isFinite(event.clientX) ? rect.left : event.clientX,
        y: keyboard || !Number.isFinite(event.clientY) ? rect.bottom : event.clientY,
      }).then(action => {
        if (current !== context) return;
        // Activation closes the menu before running the chosen operation.
        if (actions.includes(action)) return activate(context, action).catch(report);
        close();
      }).catch(error => { if (current === context) { close(false); report(error); } });
      return;
    }
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "kd-context-item";
      button.dataset.menuAction = action;
      button.setAttribute("role", "menuitem");
      button.tabIndex = -1;
      if (["remove", "clear-done"].includes(action)) button.classList.add("danger");
      const label = document.createElement("span");
      label.textContent = labels[action];
      button.append(label);
      if (shortcuts[action]) {
        const hint = document.createElement("span");
        hint.className = "kd-context-shortcut";
        hint.setAttribute("aria-hidden", "true");
        hint.textContent = modifier + (action === "redo" && modifier === "\u2318" ? "\u21e7Z" : shortcuts[action]);
        button.append(hint);
      }
      button.addEventListener("click", () => { activate(context, action).catch(report); });
      menu.append(button);
    }
    // Keep menus in the active modal's focus scope, including native <dialog>.
    (target.closest(topLayer ? 'dialog, [role="dialog"]' : "dialog, .overlay") || document.body).append(menu);
    if (topLayer) menu.showPopover();
    const rect = target.getBoundingClientRect();
    const x = keyboard || !Number.isFinite(event.clientX) ? rect.left : event.clientX;
    const y = keyboard || !Number.isFinite(event.clientY) ? rect.bottom : event.clientY;
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
    current = context;
    context.observer = new MutationObserver(() => {
      if (!available(target) || !available(menu)) close(false);
    });
    context.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "hidden", "open"] });
    menu.querySelector("button").focus({ preventScroll: true });
  }

  const contextmenu = event => open(event, event.button === 0 && event.clientX === 0 && event.clientY === 0);
  const keydown = event => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { open(event, true); return; }
    if (!current) return;
    if (event.key === "Escape" || event.key === "Tab") {
      close();
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    if (current.native) {
      if (!current.keyboard && ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const context = current;
        invokeNative("context_menu_key", { requestId: context.requestId, key: event.key })
          .catch(error => { if (current === context) report(error); });
      } else if (!current.keyboard && (event.key.length === 1 || ["Backspace", "Delete"].includes(event.key))) {
        close(false);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const items = [...current.menu.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };
  const pointerdown = event => { if (current && !current.menu.contains(event.target)) close(false); };
  const invalidate = () => close(false);
  const visibility = () => { if (document.hidden) invalidate(); };
  // Restoring an editor selection can scroll that editor after the popup opens.
  const scroll = event => { if (current && event.target !== current.input && !current.menu.contains(event.target)) invalidate(); };
  document.addEventListener("contextmenu", contextmenu);
  document.addEventListener("keydown", keydown, true);
  document.addEventListener("pointerdown", pointerdown, true);
  document.addEventListener("scroll", scroll, true);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("hashchange", invalidate);
  window.addEventListener("resize", invalidate);
  // Native menus own OS activation checks. WebView focus can move into a
  // non-activating popup while its caller remains the foreground window.
  const blur = () => { if (!current?.native) invalidate(); };
  window.addEventListener("blur", blur);
  window.addEventListener("pagehide", () => {
    disposed = true; invalidate();
    document.removeEventListener("contextmenu", contextmenu);
    document.removeEventListener("keydown", keydown, true);
    document.removeEventListener("pointerdown", pointerdown, true);
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("hashchange", invalidate);
    window.removeEventListener("resize", invalidate);
    window.removeEventListener("blur", blur);
  }, { once: true });
})();
