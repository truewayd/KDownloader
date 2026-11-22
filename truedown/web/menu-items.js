const taskMenuActions = {
  "copy-link": ["复制下载地址", "copy"],
  details: ["任务详情", "info"], preview: ["预览文件", "search"], pause: ["暂停", "pause"], resume: ["继续", "play"], requeue: ["重试", "retry"],
  "open-file": ["打开文件", "file"], "open-folder": ["打开下载目录", "folder-open"], remove: ["移除任务", "trash"],
  "new-task": ["新建下载", "download"], settings: ["设置", "settings"],
  "group-edit": ["调整此分组", "folder-pen"],
  "group-add": ["新增分组", "folder-plus"], "group-manage": ["管理分组", "folders"],
  "pause-queue": ["暂停整个队列", "pause"], "resume-queue": ["恢复整个队列", "play"],
  "retry-all": ["重试所有失败任务", "retry"], "clear-done": ["清理所有已完成记录", "trash"],
  "open-downloads": ["打开下载目录", "folder-open"],
  undo: ["撤销", "undo", "Z"], redo: ["重做", "redo", "Y"], cut: ["剪切", "cut", "X"], copy: ["复制", "copy", "C"],
  paste: ["粘贴", "paste", "V"], "select-all": ["全选", "select-all", "A"],
};

function createTaskMenuItem(action, actions, popup) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = popup ? "popup-menu-item" : "kd-context-item";
  button.dataset[popup ? "action" : "menuAction"] = action;
  button.tabIndex = -1;
  button.setAttribute("role", "menuitem");
  const standard = Object.hasOwn(taskMenuActions, action);
  const item = standard ? taskMenuActions[action] : taskColumnMenuItem(action, button, actions);
  if (!item) return null;
  const [label, icon, shortcut] = item;
  if (action === "remove" || action === "clear-done") button.classList.add("danger");
  if (popup || !standard) {
    button.append(KDComponents.createSpriteIcon(`/icons.svg#icon-${icon}`));
  }
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
  if (shortcut) {
    const mac = window.__TRUEDOWN_PLATFORM__ === "macos";
    const hint = document.createElement("span");
    hint.className = popup ? "popup-menu-shortcut" : "kd-context-shortcut";
    hint.setAttribute("aria-hidden", "true");
    hint.textContent = (mac ? "⌘" : "Ctrl+") + (mac && action === "redo" ? "⇧Z" : shortcut);
    button.append(hint);
  }
  return button;
}

function navigateTaskMenu(menu, key) {
  const items = [...menu.querySelectorAll("button:enabled")];
  if (!items.length) return;
  const index = items.indexOf(menu.ownerDocument.activeElement);
  let next;
  switch (key) {
    case "ArrowDown": next = (index + 1) % items.length; break;
    case "ArrowUp": next = (index < 0 ? items.length : index) - 1; break;
    case "Home": next = 0; break;
    case "End": next = items.length - 1; break;
    case "Enter": case " ": items[index]?.click(); return;
    default: return;
  }
  items.at(next).focus();
}
