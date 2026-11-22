// Resolve the clicked surface before collecting its currently available actions.
(() => {
  let current = null, disposed = false;
  let nativePending = Promise.resolve();
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
  function close(restore = true) {
    const context = current;
    if (!context) return;
    current = null;
    context.trigger?.setAttribute("aria-expanded", "false");
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
    if (context.header) {
      runTaskColumnMenuAction(context.header.closest("table"), action);
    } else if (context.row) {
      // Polling may remove the task or change which actions are allowed.
      if (context.row.dataset.taskId !== context.taskID) return;
      if (action === "copy-link") {
        await copyTaskLink(taskLinkByID.get(Number(context.taskID)) || "");
        return;
      }
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

  function open(event, keyboard = false, trigger = null) {
    if (event.defaultPrevented || disposed) return;
    const target = trigger || (keyboard ? document.activeElement : event.target);
    if (!(target instanceof Element) || target.closest("[data-native-drag]")) return;
    event.preventDefault();
    close(false);
    if (!available(target)) return;
    const input = target.closest("input, textarea");
    const editable = input && !input.disabled && (input.tagName === "TEXTAREA" || ["text", "search", "url", "tel", "email", "password", "number"].includes(input.type));
    const selection = window.getSelection();
    const selected = input ? input.selectionEnd > input.selectionStart
      : Boolean(selection?.toString() && selection.containsNode(target, true));
    let row, group, header, actions = [];
    if (editable || target.isContentEditable) {
      if (input?.readOnly) actions = input.type === "password" ? ["select-all"] : ["copy", "select-all"];
      else {
        actions = ["undo", "redo"];
        if ((selected || ["email", "number"].includes(input?.type)) && input?.type !== "password") actions.push("cut", "copy");
        actions.push("paste", "select-all");
      }
    } else if (["main", "browser"].includes(role()) && (header = target.closest(".tasks-table thead"))) {
      actions = taskColumnMenuActions();
    } else if (selected && !input && !trigger) actions = ["copy", "select-all"];
    else if (["main", "browser"].includes(role()) && (row = target.closest("tr[data-task-id]"))) {
      actions = [...new Set(taskButtons(row).map(button => button.dataset.action).filter(action => Object.hasOwn(taskMenuActions, action)))];
      if (taskLinkByID.get(Number(row.dataset.taskId))) actions.push("copy-link");
    } else if (["main", "browser"].includes(role()) && !target.closest('[role="dialog"], dialog, input, textarea, select')) {
      if ((group = target.closest("#file-group-navigation [data-task-category]"))) {
        selectFileGroup(group);
        group.focus({ preventScroll: true });
        actions = ["group-edit", "group-add", "group-manage"];
      } else if ((group = target.closest('.primary-nav [data-task-filter="all"]'))) {
        group.click();
        group.focus({ preventScroll: true });
        actions = ["group-add", "group-manage"];
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
    trigger?.setAttribute("aria-expanded", "true");
    const menu = document.createElement("div");
    menu.className = "kd-context-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "\u64cd\u4f5c\u83dc\u5355");
    const topLayer = typeof menu.showPopover === "function";
    if (topLayer) menu.setAttribute("popover", "manual");
    const context = { menu, target, trigger, input, header, row, taskID: row?.dataset.taskId, group, groupID: group?.dataset.taskCategory, route: location.hash, focus: trigger || input || group || (target.isContentEditable ? target : document.activeElement),
      viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
      selection: input && typeof input.selectionStart === "number" ? [input.selectionStart, input.selectionEnd, input.selectionDirection] : null,
      ranges: selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [] };
    const rect = target.getBoundingClientRect();
    if (trigger) context.anchor = rect;
    const anchored = Boolean(trigger) || keyboard;
    const x = anchored || !Number.isFinite(event.clientX) ? rect.left : event.clientX;
    const y = anchored || !Number.isFinite(event.clientY) ? rect.bottom : event.clientY;
    if (window.__TAURI__?.core?.invoke) {
      context.native = true;
      context.keyboard = keyboard;
      context.requestId = ++requestID % 0xffffffff;
      current = context;
      context.observer = new MutationObserver(() => { if (!available(target)) close(false); });
      context.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "hidden", "data-condensed-actions"] });
      // Wait for the previous native loop to settle after cancellation. A rapid
      // right-click elsewhere must hide the old menu before opening this one.
      nativePending = nativePending.then(() => {
        if (current !== context || disposed) return null;
        return invokeNative("show_context_menu", {
          requestId: context.requestId, actions, keyboard, language: window.TrueDownI18n?.language || "en",
          x, y,
        });
      }).then(action => {
        if (current !== context) return;
        // Activation closes the menu before running the chosen operation.
        if (actions.includes(action)) return activate(context, action).catch(report);
        close();
      }).catch(error => { if (current === context) { close(false); report(error); } });
      return;
    }
    for (const action of actions) {
      const button = createTaskMenuItem(action, actions, false);
      if (!button) continue;
      button.addEventListener("click", () => { activate(context, action).catch(report); });
      menu.append(button);
    }
    // Keep menus in the active modal's focus scope, including native <dialog>.
    (target.closest(topLayer ? 'dialog, [role="dialog"]' : "dialog, .overlay") || document.body).append(menu);
    if (topLayer) menu.showPopover();
    const left = x + menu.offsetWidth > innerWidth - 4 ? x - menu.offsetWidth : x;
    const top = y + menu.offsetHeight > innerHeight - 4 ? y - menu.offsetHeight : y;
    menu.style.left = `${Math.max(4, Math.min(left, innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(top, innerHeight - menu.offsetHeight - 4))}px`;
    current = context;
    context.observer = new MutationObserver(() => {
      if (!available(target) || !available(menu)) close(false);
    });
    context.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "hidden", "open", "data-condensed-actions"] });
    menu.querySelector("button:enabled").focus({ preventScroll: true });
  }

  const contextmenu = event => open(event, event.button === 0 && event.clientX === 0 && event.clientY === 0);
  const taskMenuClick = event => {
    const trigger = event.target.closest?.("[data-task-menu]");
    if (!trigger) return;
    if (current?.trigger === trigger) close();
    else open(event, event.detail === 0, trigger);
  };
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
    navigateTaskMenu(current.menu, event.key);
  };
  const pointerdown = event => {
    if (current && !current.menu.contains(event.target) && !current.trigger?.contains(event.target)) close(false);
  };
  const invalidate = () => close(false);
  // WebKit may deliver a delayed resize after mapping without changing geometry.
  // It must not cancel a menu opened against the already-current viewport.
  const resize = () => {
    if (current && (current.viewport.width !== innerWidth || current.viewport.height !== innerHeight || current.viewport.scale !== devicePixelRatio)) invalidate();
  };
  const visibility = () => { if (document.hidden) invalidate(); };
  // Restoring an editor selection can scroll that editor after the popup opens.
  const scroll = event => {
    if (!current || event.target === current.input || current.menu.contains(event.target)) return;
    if (current.trigger) {
      // Focusing a pinned button can queue a scroll event before its click.
      const rect = current.trigger.getBoundingClientRect();
      if (rect.left === current.anchor.left && rect.bottom === current.anchor.bottom) return;
    }
    invalidate();
  };
  document.addEventListener("contextmenu", contextmenu);
  document.addEventListener("click", taskMenuClick);
  document.addEventListener("keydown", keydown, true);
  document.addEventListener("pointerdown", pointerdown, true);
  document.addEventListener("scroll", scroll, true);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("hashchange", invalidate);
  window.addEventListener("resize", resize);
  // Native menus own OS activation checks. WebView focus can move into a
  // non-activating popup while its caller remains the foreground window.
  const blur = () => { if (!current?.native) invalidate(); };
  window.addEventListener("blur", blur);
  window.addEventListener("pagehide", () => {
    disposed = true; invalidate();
    document.removeEventListener("contextmenu", contextmenu);
    document.removeEventListener("click", taskMenuClick);
    document.removeEventListener("keydown", keydown, true);
    document.removeEventListener("pointerdown", pointerdown, true);
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("hashchange", invalidate);
    window.removeEventListener("resize", resize);
    window.removeEventListener("blur", blur);
  }, { once: true });
})();
