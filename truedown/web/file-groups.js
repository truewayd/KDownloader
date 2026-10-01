let fileGroupsState = { revision: -1, groups: [] };
let fileGroupsDraft = null;
let fileGroupsEditorRevision = -1;
let fileGroupsReadVersion = 0;
let fileGroupsBase = null;
let fileGroupsNeedsSync = false;
let fileGroupsSaving = false, fileGroupsSaveQueued = false, fileGroupsMutationVersion = 0;
let fileGroupDrag = null, fileGroupOrderSaving = false;

function focusFileGroupRoute() {
  if (currentPage !== "settings" || currentSettingsPage !== "files" || !settingsReady.has("files")) return;
  const [, , action, id] = location.hash.slice(1).split("/");
  if (!["group", "add-group"].includes(action)) return;
  // Consume the navigation intent once; later reads must preserve focus and drafts.
  history.replaceState(null, "", "#settings/files");
  if (action === "add-group") {
    const button = document.getElementById("file-group-add");
    if (button.disabled) showToast("最多创建 32 个分组。", "error");
    else button.click();
    return;
  }
  const row = [...document.querySelectorAll("[data-group-id]")].find(row => row.dataset.groupId === id);
  if (!row) { showToast("此分组已不存在，请选择其他分组。", "error"); return; }
  row.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  row.querySelector("input").focus({ preventScroll: true });
}

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
  return { label: group?.name || "\u5176\u4ed6", icon: group?.icon || "file" };
}

function applyFileGroups(state) {
  if (!Number.isSafeInteger(state?.revision) || !Array.isArray(state.groups)) throw new Error("\u5206\u7ec4\u54cd\u5e94\u65e0\u6548");
  if (state.revision < fileGroupsState.revision) return;
  const changed = JSON.stringify(state) !== JSON.stringify(fileGroupsState);
  fileGroupsState = state;
  if (changed) renderDropboxProjectFilter();
  if (fileGroupsDraft && !fileGroupsSaving && state.revision > fileGroupsEditorRevision) {
    fileGroupsNeedsSync = true;
    scheduleFileGroupsSync();
  }
  if (changed && !fileGroupDrag) renderFileGroupNavigation();
}

function renderFileGroupNavigation() {
  const nav = document.getElementById("file-group-navigation");
  const focusedID = nav.contains(document.activeElement) ? document.activeElement.dataset.taskCategory : null;
  nav.replaceChildren(...fileGroupsState.groups.map((group) => {
    const link = document.createElement("a");
    link.href = "#tasks";
    link.draggable = false;
    link.dataset.taskCategory = group.id;
    link.dataset.tooltip = group.name;
    link.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    link.innerHTML = iconMarkup(taskCategoryMeta(group.id).icon);
    const label = document.createElement("span");
    label.className = "nav-label";
    label.textContent = group.name;
    link.append(label);
    const count = document.createElement("span");
    count.className = "nav-count";
    count.textContent = safeCount(currentSummary.groupCounts?.[group.id]);
    link.append(count);
    return link;
  }));
  if (focusedID) [...nav.children].find((link) => link.dataset.taskCategory === focusedID)?.focus({ preventScroll: true });
  updateTaskNavigation();
}

function updateFileGroupCounts() {
  document.querySelectorAll("[data-task-category]").forEach(link => {
    const value = String(safeCount(currentSummary.groupCounts?.[link.dataset.taskCategory]));
    const count = link.querySelector(".nav-count");
    if (count && count.textContent !== value) count.textContent = value;
  });
}

function initFileGroups() {
  initGroupIconPicker();
  bindFileGroupSorting();
  document.getElementById("file-group-navigation").addEventListener("click", (event) => {
    const link = event.target.closest("[data-task-category]");
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    selectFileGroup(link);
  });
  document.getElementById("file-group-add").addEventListener("click", () => {
    if (!fileGroupsDraft || fileGroupsDraft.length >= 32) return;
    captureFileGroupsDraft();
    const group = { id: `group-${crypto.randomUUID()}`, name: "", icon: "folder", directory: "", extensions: [] };
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

function selectFileGroup(link) {
  const id = link.dataset.taskCategory;
  if (!fileGroupsState.groups.some(group => group.id === id)) return;
  currentCategory = id;
  resetTaskViewport();
  lastTaskRenderSignature = "";
  if (currentPage !== "tasks") {
    history.pushState(null, "", "#tasks");
    applyWorkspaceRoute(false);
  } else {
    updateTaskNavigation();
    refreshAndSchedule(true);
  }
}

async function saveFileGroupOrder(ids, revision = fileGroupsState.revision) {
  if (fileGroupOrderSaving || ids.join() === fileGroupsState.groups.map(group => group.id).join()) {
    renderFileGroupNavigation();
    return;
  }
  fileGroupOrderSaving = true;
  const nav = document.getElementById("file-group-navigation");
  KDComponents.setBusyState(nav, true, { manageDisabled: false });
  try {
    const state = await requestJSON("/settings/file-groups/order", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, ids }),
    });
    applyFileGroups(state);
  } catch (error) {
    if (error.status === 409) {
      try { applyFileGroups(await requestJSON("/settings/file-groups")); } catch { /* Keep the last confirmed order. */ }
    }
    showToast(error.status === 409 ? "分组已变更，请按最新列表重新排序。" : `排序保存失败：${error.message}`, "error");
  } finally {
    fileGroupOrderSaving = false;
    KDComponents.setBusyState(nav, false, { manageDisabled: false });
    renderFileGroupNavigation();
  }
}

function bindFileGroupSorting() {
  const nav = document.getElementById("file-group-navigation");
  let suppressClick = false;
  const finish = (commit = false) => {
    const drag = fileGroupDrag;
    if (!drag) return;
    fileGroupDrag = null;
    cancelAnimationFrame(drag.frame);
    drag.preview?.remove();
    if (nav.hasPointerCapture(drag.pointer)) nav.releasePointerCapture(drag.pointer);
    nav.classList.remove("group-sorting");
    drag.link.classList.remove("group-dragging");
    if (drag.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    if (commit && drag.moved) saveFileGroupOrder([...nav.children].map(link => link.dataset.taskCategory), drag.revision);
    else if (drag.moved) renderFileGroupNavigation();
    else if (drag.revision !== fileGroupsState.revision) setTimeout(() => { if (!fileGroupDrag) renderFileGroupNavigation(); }, 0);
  };
  nav.addEventListener("click", event => {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  nav.addEventListener("pointerdown", event => {
    const link = event.target.closest("[data-task-category]");
    if (!link || event.button !== 0 || !event.isPrimary || fileGroupOrderSaving || fileGroupDrag
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    fileGroupDrag = { link, pointer: event.pointerId, x: event.clientX, y: event.clientY, revision: fileGroupsState.revision, moved: false };
  });
  nav.addEventListener("pointermove", event => {
    const drag = fileGroupDrag;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      nav.setPointerCapture(event.pointerId);
      nav.classList.add("group-sorting");
      drag.link.classList.add("group-dragging");
      drag.link.focus({ preventScroll: true });
      const rect = drag.link.getBoundingClientRect();
      drag.preview = drag.link.cloneNode(true);
      drag.preview.className = "group-drag-preview";
      drag.preview.removeAttribute("href");
      drag.preview.removeAttribute("data-task-category");
      drag.preview.removeAttribute("data-tooltip");
      drag.preview.setAttribute("aria-hidden", "true");
      drag.preview.inert = true;
      drag.preview.style.width = `${rect.width}px`;
      drag.preview.style.left = `${rect.left}px`;
      drag.offsetY = drag.y - rect.top;
      document.body.append(drag.preview);
      const scroll = () => {
        if (fileGroupDrag !== drag) return;
        const scroller = nav.closest(".primary-nav"), bounds = scroller.getBoundingClientRect();
        const delta = drag.currentY < bounds.top + 28 ? -8 : drag.currentY > bounds.bottom - 28 ? 8 : 0;
        if (delta) { scroller.scrollTop += delta; place(drag); }
        drag.frame = requestAnimationFrame(scroll);
      };
      drag.frame = requestAnimationFrame(scroll);
    }
    event.preventDefault();
    drag.currentY = event.clientY;
    drag.preview.style.top = `${event.clientY - drag.offsetY}px`;
    place(drag);
  });
  function place(drag) {
    const next = [...nav.children].find(link => link !== drag.link && drag.currentY < link.getBoundingClientRect().top + link.offsetHeight / 2);
    if (drag.link.nextElementSibling !== (next || null)) nav.insertBefore(drag.link, next || null);
  }
  window.addEventListener("pointerup", event => {
    if (fileGroupDrag?.pointer !== event.pointerId) return;
    const bounds = nav.closest(".primary-nav").getBoundingClientRect();
    finish(event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom);
  });
  nav.addEventListener("lostpointercapture", () => finish());
  window.addEventListener("pointercancel", () => finish());
  window.addEventListener("blur", () => finish());
  window.addEventListener("pagehide", () => finish());
  window.addEventListener("hashchange", () => finish());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && fileGroupDrag) { event.preventDefault(); finish(); }
  }, true);
  nav.addEventListener("keydown", event => {
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key) || fileGroupOrderSaving || fileGroupDrag) return;
    const link = event.target.closest("[data-task-category]");
    if (!link) return;
    event.preventDefault();
    const ids = fileGroupsState.groups.map(group => group.id), index = ids.indexOf(link.dataset.taskCategory);
    const next = index + (event.key === "ArrowUp" ? -1 : 1);
    if (index < 0 || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    saveFileGroupOrder(ids);
  });
}

function markFileGroupsDraft() {
  fileGroupsMutationVersion++;
  fileGroupsReadVersion++;
  document.getElementById("file-groups-status").textContent = "\u6709\u672a\u4fdd\u5b58\u7684\u4fee\u6539\u3002";
}

function fileGroupSuffixValues(value) {
  return value.split(/[\s,;\uff0c\uff1b]+/).filter(Boolean);
}

function captureFileGroupsDraft() {
  if (!fileGroupsDraft) return;
  const groups = new Map(fileGroupsDraft.map(group => [group.id, group]));
  for (const row of document.querySelectorAll("[data-group-id]")) {
    const group = groups.get(row.dataset.groupId);
    if (!group) continue;
    group.name = row.querySelector("input").value;
    group.directory = row.querySelector("[data-group-directory]").value.trim();
    group.extensions = [...row.querySelectorAll("[data-group-suffix]")].flatMap(input => fileGroupSuffixValues(input.value));
  }
}

function createGroupSuffixEditor(group, i) {
  return createSuffixEditor(group.extensions, `group-${i}`, {
    labelID: `group-ext-label-${i}`, fallback: group.id === "other",
    onRemove: () => { captureFileGroupsDraft(); markFileGroupsDraft(); scheduleFileGroupsSave(); },
  });
}

function createSuffixEditor(extensions, identity, { labelID, fallback = false, readOnly = false, onRemove = () => {} } = {}) {
  const suffixes = document.createElement("div");
  suffixes.className = "group-suffixes";
  suffixes.id = `${identity}-suffixes`;
  suffixes.setAttribute("role", "group");
  suffixes.setAttribute("aria-labelledby", labelID);
  if (fallback) {
    suffixes.textContent = "自动接收未匹配的文件";
    suffixes.classList.add("hint");
    return suffixes;
  }
  const addSuffix = document.createElement("button");
  addSuffix.type = "button";
  addSuffix.className = "kd-button secondary suffix-add";
  addSuffix.id = `${identity}-suffix-add`;
  addSuffix.hidden = readOnly;
  addSuffix.textContent = "+ 后缀";
  let suffixSequence = 0;
  const appendSuffix = (value = "") => {
    const chip = document.createElement("div");
    chip.className = "group-suffix-chip";
    const input = document.createElement("input");
    input.className = "kd-input";
    if (identity.startsWith("group-")) input.dataset.groupSuffix = "";
    else input.dataset.downloadExtension = "";
    input.id = `${identity}-suffix-${suffixSequence++}`;
    input.readOnly = readOnly;
    input.setAttribute("aria-label", "文件后缀");
    input.placeholder = ".ext";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = value;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "kd-icon-button";
    remove.setAttribute("aria-label", "删除后缀");
    remove.innerHTML = iconMarkup("close");
    remove.hidden = readOnly;
    // Avoid a blur-triggered save replacing the chip before its click arrives.
    remove.addEventListener("pointerdown", event => event.preventDefault());
    remove.addEventListener("click", () => {
      const next = chip.nextElementSibling?.querySelector("input") || addSuffix;
      chip.remove();
      next.focus();
      onRemove();
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); if (!readOnly) addSuffix.click(); }
    });
    input.addEventListener("change", () => {
      const values = fileGroupSuffixValues(input.value);
      if (values.length > 1) {
        input.value = values[0];
        for (const value of values.slice(1)) appendSuffix(value);
      }
    });
    chip.append(input, remove);
    suffixes.insertBefore(chip, addSuffix);
    return input;
  };
  suffixes.append(addSuffix);
  for (const suffix of extensions) appendSuffix(suffix);
  addSuffix.addEventListener("pointerdown", event => event.preventDefault());
  addSuffix.addEventListener("click", () => appendSuffix().focus());
  return suffixes;
}

function renderFileGroupsEditor() {
  const editor = document.getElementById("file-groups-editor");
  editor.replaceChildren(...fileGroupsDraft.map((group, i) => {
    const row = document.createElement("div");
    row.className = "file-group-editor-row";
    row.dataset.groupId = group.id;
    row.innerHTML = `<div class="field"><label for="group-name-${i}">\u5206\u7ec4\u540d\u79f0</label><input class="kd-input" id="group-name-${i}" maxlength="40" required></div><div class="field group-suffix-field"><span class="field-label" id="group-ext-label-${i}">\u6587\u4ef6\u540e\u7f00</span></div><button class="kd-icon-button" type="button" aria-label="\u5220\u9664\u5206\u7ec4" data-tooltip="\u5220\u9664\u5206\u7ec4">${iconMarkup("trash")}</button>`;
    row.querySelector("input").value = group.name;
    row.querySelector("input").closest(".field").classList.add("group-name-field");
    row.querySelector(".group-suffix-field").append(createGroupSuffixEditor(group, i));
    const directoryField = document.createElement("div");
    directoryField.className = "field group-directory-field";
    directoryField.innerHTML = `<label for="group-dir-${i}">保存子目录</label><input class="kd-input" id="group-dir-${i}" data-group-directory maxlength="80" placeholder="留空使用分组名称">`;
    directoryField.querySelector("input").value = group.directory || "";
    row.insertBefore(directoryField, row.querySelector(".group-suffix-field"));
    row.querySelector(":scope > button").dataset.removeGroup = group.id;
    if (group.id === "other") {
      row.querySelector("[data-remove-group]").disabled = true;
    }
    const iconButton = document.createElement("button");
    iconButton.type = "button";
    iconButton.className = "kd-icon-button group-icon-trigger";
    iconButton.dataset.groupIcon = group.id;
    iconButton.dataset.tooltip = "\u9009\u62e9\u5206\u7ec4\u56fe\u6807";
    iconButton.setAttribute("aria-label", iconButton.dataset.tooltip);
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
    choice.dataset.tooltip = icon.name;
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
  const focusSelector = focusedGroup && [".group-name-field input", "[data-group-directory]", "[data-group-icon]", "[data-remove-group]", ".suffix-add", "[data-group-suffix]", ".group-suffix-chip button"].find(selector => focused.matches(selector));
  const focusedSuffix = focused?.closest(".group-suffix-chip")?.querySelector("input").value;
  const focusedIndex = focusSelector ? [...focused.closest("[data-group-id]").querySelectorAll(focusSelector)].indexOf(focused) : -1;
  const selection = focusedGroup && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null;
  if (merging) captureFileGroupsDraft();
  fileGroupsDraft = merging ? reconcileFileGroups(fileGroupsBase || [], fileGroupsDraft, state.groups) : structuredClone(state.groups);
  fileGroupsBase = structuredClone(state.groups);
  fileGroupsNeedsSync = false;
  cancelReadRetry("file-groups");
  fileGroupsEditorRevision = state.revision;
  renderFileGroupsEditor();
  if (focusedGroup && focusSelector) {
    const row = [...document.querySelectorAll("[data-group-id]")].find(item => item.dataset.groupId === focusedGroup);
    if (focusedSuffix === "") row?.querySelector(".suffix-add")?.click();
    const fields = [...(row?.querySelectorAll(focusSelector) || [])];
    const field = fields.find(field => focusedSuffix !== undefined && field.closest(".group-suffix-chip")?.querySelector("input").value === focusedSuffix) || fields[focusedIndex] || row?.querySelector(".suffix-add");
    field?.focus({ preventScroll: true });
    if (selection) field?.setSelectionRange?.(...selection);
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
  if (fileGroupsNeedsSync) {
    await syncFileGroups();
    if (fileGroupsNeedsSync || fileGroupsSaving) return;
  }
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
    const unchanged = mutationVersion === fileGroupsMutationVersion;
    if (unchanged) fileGroupsDraft = structuredClone(state.groups);
    fileGroupsBase = structuredClone(state.groups);
    fileGroupsNeedsSync = false;
    cancelReadRetry("file-groups");
    fileGroupsEditorRevision = state.revision;
    if (unchanged) {
      const editor = document.getElementById("file-groups-editor");
      if (!editor.contains(document.activeElement)) renderFileGroupsEditor();
      else {
        // Keep the active chip and any new empty input across autosave.
        for (const row of editor.children) {
          const group = state.groups.find(group => group.id === row.dataset.groupId);
          if (!group) continue;
          for (const [field, value] of [[row.querySelector("input"), group.name], [row.querySelector("[data-group-directory]"), group.directory || ""]]) {
            if (field.value !== value) field.value = value;
          }
          const normalized = new Map();
          for (const input of row.querySelectorAll("[data-group-suffix]")) {
            const raw = input.value.trim().toLowerCase();
            const value = raw.startsWith(".") ? raw : `.${raw}`;
            if (!group.extensions.includes(value)) continue;
            if (input.value !== value) input.value = value;
            const previous = normalized.get(value);
            if (previous) {
              const remove = input === document.activeElement ? previous : input;
              remove.closest(".group-suffix-chip").remove();
              if (remove === input) continue;
            }
            normalized.set(value, input);
          }
        }
      }
      document.getElementById("file-groups-status").textContent = "\u5206\u7ec4\u5df2\u4fdd\u5b58\uff0c\u5df2\u6709\u4efb\u52a1\u4f1a\u81ea\u52a8\u91cd\u65b0\u5f52\u7c7b\u3002";
    }
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
