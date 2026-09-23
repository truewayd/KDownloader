let fileGroupsState = { revision: -1, groups: [] };
let fileGroupsDraft = null;
let fileGroupsEditorRevision = -1;
let fileGroupsReadVersion = 0;
let fileGroupsBase = null;
let fileGroupsNeedsSync = false;
let fileGroupsSaving = false, fileGroupsSaveQueued = false, fileGroupsMutationVersion = 0;

function scheduleFileGroupsSave() {
  fileGroupsSaveQueued = true;
  queueMicrotask(() => {
    if (fileGroupsSaving || !fileGroupsSaveQueued) return;
    fileGroupsSaveQueued = false;
    saveFileGroups();
  });
}

function taskCategoryMeta(id) {
  const group = fileGroupsState.groups.find((value) => value.id === id);
  const icons = { image: "image", video: "video", audio: "music", archive: "archive", application: "app-window", document: "logs", project: "settings", other: "file" };
  return { label: group?.name || "\u5176\u4ed6", icon: group?.icon || icons[id] || "folder" };
}

function applyFileGroups(state) {
  if (!Number.isSafeInteger(state?.revision) || !Array.isArray(state.groups)) throw new Error("\u5206\u7ec4\u54cd\u5e94\u65e0\u6548");
  if (state.revision < fileGroupsState.revision) return;
  const changed = JSON.stringify(state) !== JSON.stringify(fileGroupsState);
  fileGroupsState = state;
  if (changed) renderFileGroupNavigation();
}

function renderFileGroupNavigation() {
  const nav = document.getElementById("file-group-navigation");
  const focusedID = nav.contains(document.activeElement) ? document.activeElement.dataset.taskCategory : null;
  nav.replaceChildren(...fileGroupsState.groups.map((group) => {
    const link = document.createElement("a");
    link.href = "#tasks";
    link.dataset.taskCategory = group.id;
    link.title = group.name;
    link.innerHTML = iconMarkup(taskCategoryMeta(group.id).icon);
    const label = document.createElement("span");
    label.className = "nav-label";
    label.textContent = group.name;
    link.append(label);
    return link;
  }));
  if (focusedID) [...nav.children].find((link) => link.dataset.taskCategory === focusedID)?.focus({ preventScroll: true });
  updateTaskNavigation();
}

function initFileGroups() {
  initGroupIconPicker();
  document.getElementById("file-group-navigation").addEventListener("click", (event) => {
    const link = event.target.closest("[data-task-category]");
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    currentCategory = link.dataset.taskCategory;
    currentOffset = 0;
    lastTaskRenderSignature = "";
    updateTaskNavigation();
    if (currentPage !== "tasks") location.hash = "tasks";
    else refreshAndSchedule(true);
  });
  document.getElementById("file-group-add").addEventListener("click", () => {
    if (!fileGroupsDraft || fileGroupsDraft.length >= 32) return;
    captureFileGroupsDraft();
    const group = { id: `group-${crypto.randomUUID()}`, name: "", extensions: [] };
    fileGroupsDraft.splice(Math.max(0, fileGroupsDraft.findIndex((item) => item.id === "other")), 0, group);
    renderFileGroupsEditor();
    document.querySelector(`[data-group-id="${group.id}"] input`).focus();
    markFileGroupsDraft();
  });
  document.getElementById("file-groups-editor").addEventListener("input", () => { captureFileGroupsDraft(); markFileGroupsDraft(); });
  document.getElementById("file-groups-editor").addEventListener("change", scheduleFileGroupsSave);
  document.getElementById("file-groups-editor").addEventListener("click", (event) => {
    const iconButton = event.target.closest("[data-group-icon]");
    if (iconButton) { openGroupIconPicker(iconButton); return; }
    const button = event.target.closest("[data-remove-group]");
    if (!button || button.dataset.removeGroup === "other") return;
    captureFileGroupsDraft();
    fileGroupsDraft = fileGroupsDraft.filter((group) => group.id !== button.dataset.removeGroup);
    renderFileGroupsEditor();
    document.getElementById("file-group-add").focus();
    markFileGroupsDraft();
    scheduleFileGroupsSave();
  });
}

function markFileGroupsDraft() {
  fileGroupsMutationVersion++;
  fileGroupsReadVersion++;
  document.getElementById("file-groups-status").textContent = "\u6709\u672a\u4fdd\u5b58\u7684\u4fee\u6539\u3002";
}

function captureFileGroupsDraft() {
  if (!fileGroupsDraft) return;
  for (const row of document.querySelectorAll("[data-group-id]")) {
    const group = fileGroupsDraft.find((item) => item.id === row.dataset.groupId);
    group.name = row.querySelector("input").value;
    group.directory = row.querySelector("[data-group-directory]").value.trim();
    group.extensions = row.querySelector("textarea").value.split(/[\s,;\uff0c\uff1b]+/).filter(Boolean);
  }
}

function renderFileGroupsEditor() {
  const editor = document.getElementById("file-groups-editor");
  editor.replaceChildren(...fileGroupsDraft.map((group, i) => {
    const row = document.createElement("div");
    row.className = "file-group-editor-row";
    row.dataset.groupId = group.id;
    row.innerHTML = `<div class="field"><label for="group-name-${i}">\u5206\u7ec4\u540d\u79f0</label><input class="kd-input" id="group-name-${i}" maxlength="40" required></div><div class="field"><label for="group-ext-${i}">\u6587\u4ef6\u540e\u7f00</label><textarea class="kd-input" id="group-ext-${i}" rows="2" placeholder=".zip .7z .tar.gz"></textarea></div><button class="kd-icon-button" type="button" aria-label="\u5220\u9664\u5206\u7ec4" title="\u5220\u9664\u5206\u7ec4">${iconMarkup("trash")}</button>`;
    row.querySelector("input").value = group.name;
    row.querySelector("input").closest(".field").classList.add("group-name-field");
    row.querySelector("textarea").closest(".field").classList.add("group-suffix-field");
    row.querySelector("textarea").value = group.extensions.join(" ");
    const directoryField = document.createElement("div");
    directoryField.className = "field group-directory-field";
    directoryField.innerHTML = `<label for="group-dir-${i}">保存子目录</label><input class="kd-input" id="group-dir-${i}" data-group-directory maxlength="80" placeholder="留空使用分组名称">`;
    directoryField.querySelector("input").value = group.directory || "";
    row.insertBefore(directoryField, row.querySelector(".group-suffix-field"));
    row.querySelector("button").dataset.removeGroup = group.id;
    if (group.id === "other") {
      row.querySelector("textarea").disabled = true;
      row.querySelector("textarea").placeholder = "\u81ea\u52a8\u63a5\u6536\u672a\u5339\u914d\u7684\u6587\u4ef6";
      row.querySelector("button").disabled = true;
    }
    const iconButton = document.createElement("button");
    iconButton.type = "button";
    iconButton.className = "kd-icon-button group-icon-trigger";
    iconButton.dataset.groupIcon = group.id;
    iconButton.title = "\u9009\u62e9\u5206\u7ec4\u56fe\u6807";
    iconButton.setAttribute("aria-label", iconButton.title);
    iconButton.setAttribute("aria-haspopup", "dialog");
    iconButton.innerHTML = iconMarkup(group.icon || taskCategoryMeta(group.id).icon);
    row.prepend(iconButton);
    return row;
  }));
  document.getElementById("file-group-add").disabled = fileGroupsDraft.length >= 32;
}

let groupIconDialog, groupIconTarget;
function initGroupIconPicker() {
  groupIconDialog = document.createElement("dialog");
  groupIconDialog.className = "group-icon-dialog kd-panel";
  groupIconDialog.setAttribute("role", "dialog");
  groupIconDialog.setAttribute("aria-labelledby", "group-icon-title");
  groupIconDialog.innerHTML = `<header><h2 id="group-icon-title">\u9009\u62e9\u5206\u7ec4\u56fe\u6807</h2><button type="button" class="kd-icon-button" aria-label="\u5173\u95ed">${iconMarkup("close")}</button></header><div class="group-icon-grid"></div>`;
  groupIconDialog.querySelector("header button").addEventListener("click", () => groupIconDialog.close());
  groupIconDialog.addEventListener("click", event => {
    if (event.target === groupIconDialog) groupIconDialog.close();
    const button = event.target.closest("[data-icon-choice]");
    if (!button || !groupIconTarget) return;
    const group = fileGroupsDraft.find(group => group.id === groupIconTarget.dataset.groupIcon);
    if (group) {
      group.icon = button.dataset.iconChoice;
      groupIconTarget.innerHTML = iconMarkup(group.icon);
      markFileGroupsDraft();
      scheduleFileGroupsSave();
    }
    groupIconDialog.close();
  });
  groupIconDialog.addEventListener("close", () => { if (groupIconTarget?.isConnected) groupIconTarget.focus(); groupIconTarget = null; });
  document.body.append(groupIconDialog);
}
function openGroupIconPicker(button) {
  groupIconTarget = button;
  const selected = fileGroupsDraft.find(group => group.id === button.dataset.groupIcon)?.icon || taskCategoryMeta(button.dataset.groupIcon).icon;
  groupIconDialog.querySelector(".group-icon-grid").replaceChildren(...(fileGroupsState.icons || []).map(icon => {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "kd-icon-button";
    choice.dataset.iconChoice = icon.id;
    choice.title = icon.name;
    choice.setAttribute("aria-label", icon.name);
    choice.setAttribute("aria-pressed", String(selected === icon.id));
    choice.innerHTML = iconMarkup(icon.id);
    return choice;
  }));
  groupIconDialog.showModal();
  (groupIconDialog.querySelector('[aria-pressed="true"]') || groupIconDialog.querySelector("header button")).focus();
}

function reconcileFileGroups(base, draft, latest) {
  const previous = new Map(base.map(group => [group.id, { directory: "", ...group }]));
  const local = new Map(draft.map(group => [group.id, { directory: "", ...group }]));
  const merged = latest.filter(group => !previous.has(group.id) || local.has(group.id)).map(group =>
    local.has(group.id) ? reconcileReadDraft(previous.get(group.id) || {}, local.get(group.id), group) : group);
  for (const group of draft) {
    if (!latest.some(item => item.id === group.id) && JSON.stringify(previous.get(group.id)) !== JSON.stringify(local.get(group.id))) {
      merged.splice(Math.max(0, merged.findIndex(item => item.id === "other")), 0, group);
    }
  }
  return merged;
}

async function loadFileGroupsEditor() {
  if (fileGroupsDraft && !fileGroupsNeedsSync) return;
  const version = ++fileGroupsReadVersion;
  const state = await requestJSON("/settings/file-groups");
  if (version !== fileGroupsReadVersion) {
    if (fileGroupsNeedsSync) scheduleFileGroupsSync();
    return;
  }
  applyFileGroups(state);
  const merging = Boolean(fileGroupsDraft && fileGroupsNeedsSync);
  const focused = document.activeElement;
  const focusedGroup = focused?.closest("[data-group-id]")?.dataset.groupId;
  const focusedIndex = focusedGroup ? [...focused.closest("[data-group-id]").querySelectorAll("input, textarea, button")].indexOf(focused) : -1;
  const selection = focusedGroup && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null;
  if (merging) captureFileGroupsDraft();
  fileGroupsDraft = merging ? reconcileFileGroups(fileGroupsBase || [], fileGroupsDraft, state.groups) : structuredClone(state.groups);
  fileGroupsBase = structuredClone(state.groups);
  fileGroupsNeedsSync = false;
  cancelReadRetry("file-groups");
  fileGroupsEditorRevision = state.revision;
  renderFileGroupsEditor();
  if (focusedGroup) {
    const row = [...document.querySelectorAll("[data-group-id]")].find(item => item.dataset.groupId === focusedGroup);
    const field = row?.querySelectorAll("input, textarea, button")[focusedIndex];
    field?.focus({ preventScroll: true });
    if (selection) field?.setSelectionRange(...selection);
  }
  document.getElementById("file-groups-status").textContent = merging ? "已同步最新分组，草稿已保留，继续编辑后自动保存。" : "";
}

function scheduleFileGroupsSync() {
  scheduleReadRetry("file-groups", syncFileGroups, () => currentPage === "settings" && currentSettingsPage === "files" && fileGroupsNeedsSync);
}

async function syncFileGroups() {
  if (fileGroupsSaving) { scheduleFileGroupsSync(); return; }
  try { await loadFileGroupsEditor(); }
  catch (error) {
    document.getElementById("file-groups-status").textContent = `同步失败，正在自动重试，草稿已保留：${error.message}`;
    scheduleFileGroupsSync();
  }
}

async function saveFileGroups() {
  if (!fileGroupsDraft) return;
  if (fileGroupsSaving) return;
  const panel = document.getElementById("file-groups-editor").closest("[data-settings-page]");
  const invalid = [...panel.querySelectorAll("input")].find((input) => !input.checkValidity());
  if (invalid) { document.getElementById("file-groups-status").textContent = "请填写有效的分组名称，完成编辑后自动保存。"; return; }
  captureFileGroupsDraft();
  const mutationVersion = fileGroupsMutationVersion;
  const submitted = structuredClone(fileGroupsDraft);
  fileGroupsReadVersion++;
  fileGroupsSaving = true;
  try {
    const state = await requestJSON("/settings/file-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: fileGroupsEditorRevision, groups: submitted }) });
    fileGroupsReadVersion++;
    applyFileGroups(state);
    if (mutationVersion === fileGroupsMutationVersion) fileGroupsDraft = structuredClone(state.groups);
    fileGroupsBase = structuredClone(state.groups);
    fileGroupsNeedsSync = false;
    cancelReadRetry("file-groups");
    fileGroupsEditorRevision = state.revision;
    if (mutationVersion === fileGroupsMutationVersion) {
      const focusedID = document.activeElement?.id;
      renderFileGroupsEditor();
      if (currentPage === "settings" && currentSettingsPage === "files" && focusedID) document.getElementById(focusedID)?.focus({ preventScroll: true });
    }
    if (mutationVersion === fileGroupsMutationVersion) document.getElementById("file-groups-status").textContent = "\u5206\u7ec4\u5df2\u4fdd\u5b58\uff0c\u5df2\u6709\u4efb\u52a1\u4f1a\u81ea\u52a8\u91cd\u65b0\u5f52\u7c7b\u3002";
    renderedTaskPageURL = "";
  } catch (error) {
    document.getElementById("file-groups-status").textContent = error.status === 409 ? "分组已变更，正在自动同步，草稿已保留。" : `\u4fdd\u5b58\u5931\u8d25\uff1a${error.message}`;
    if (error.status === 409) {
      fileGroupsNeedsSync = true;
      scheduleFileGroupsSync();
    }
  } finally {
    fileGroupsSaving = false;
    if (fileGroupsSaveQueued) scheduleFileGroupsSave();
  }
}
