const taskSortColumns = {
  file: "文件", status: "状态", progress: "进度", size: "大小",
  speed: "速度", remaining: "剩余", created: "添加时间",
};

function taskColumnMenuDisabled(action, actions) {
  return action === "column-actions" || (action.startsWith("column-hide-")
    && !actions.some(other => other !== action && other.startsWith("column-hide-")));
}

function taskColumnMenuItem(action, button, actions) {
  if (action === "columns-auto") return ["恢复自动列宽", "retry"];
  const field = action.split("-")[2];
  const fixed = action === "column-actions";
  if (!fixed && !Object.hasOwn(taskSortColumns, field)) return null;
  button.setAttribute("role", "menuitemcheckbox");
  button.setAttribute("aria-checked", String(fixed || action.startsWith("column-hide-")));
  button.disabled = taskColumnMenuDisabled(action, actions);
  return [fixed ? "操作" : taskSortColumns[field], "check"];
}

const taskColumnLayoutKey = "truedown-task-column-layout-v1";
// Minimum readable automatic width, then preferred width, in CSS pixels.
const taskColumnSizes = {
  file: [144, 240], status: [124, 136], progress: [84, 104], size: [76, 84],
  speed: [88, 96], remaining: [72, 80], created: [94, 106],
};
const minTaskColumnWidth = 48;
const maxTaskColumnWidth = 4096;
let taskColumnWidths = {};
let hiddenTaskColumns = new Set();

function readTaskColumnLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(taskColumnLayoutKey));
    for (const field of taskColumnOrder) {
      const width = saved?.widths?.[field];
      if (Number.isInteger(width) && width >= minTaskColumnWidth && width <= maxTaskColumnWidth) taskColumnWidths[field] = width;
    }
    if (Array.isArray(saved?.hidden)) {
      hiddenTaskColumns = new Set(taskColumnOrder.filter(field => saved.hidden.includes(field)));
      if (hiddenTaskColumns.size === taskColumnOrder.length) hiddenTaskColumns.delete("file");
    }
  } catch { /* Use automatic widths and visible columns until customized. */ }
}

function saveTaskColumnLayout() {
  try {
    localStorage.setItem(taskColumnLayoutKey, JSON.stringify({ widths: taskColumnWidths, hidden: [...hiddenTaskColumns] }));
  } catch { /* Keep the active layout when profile storage is unavailable. */ }
}

function updateTaskScrollShadows(scroller, overflow = scroller.scrollWidth - scroller.clientWidth) {
  const left = Math.max(0, Math.min(scroller.scrollLeft, overflow));
  scroller.toggleAttribute("data-overflow-left", left > 0.5);
  scroller.toggleAttribute("data-overflow-right", overflow - left > 0.5);
}

function applyTaskColumnLayout(table) {
  table.dataset.hiddenColumns = [...hiddenTaskColumns].join(" ");
  const visible = taskColumnOrder.filter(field => !hiddenTaskColumns.has(field));
  const automatic = visible.filter(field => !Object.hasOwn(taskColumnWidths, field));
  const widths = Object.fromEntries(visible.map(field => [field, taskColumnWidths[field] ?? taskColumnSizes[field][0]]));
  // Measure the localized, uppercase label and its sort icon at their rendered size.
  const range = document.createRange();
  for (const field of automatic) {
    const heading = table.querySelector(`.task-heading-${field}`);
    const button = heading.querySelector(".sort-button");
    range.selectNodeContents(button.firstChild);
    const padding = getComputedStyle(heading);
    const contentWidth = range.getBoundingClientRect().width + button.querySelector(".sort-indicator").offsetWidth
      + parseFloat(getComputedStyle(button).columnGap) + parseFloat(padding.paddingLeft) + parseFloat(padding.paddingRight);
    widths[field] = Math.max(widths[field], Math.ceil(contentWidth));
  }
  const viewport = els.tasksWrap.clientWidth;
  const focused = document.activeElement;
  const actionGroup = focused?.closest(".row-actions");
  const condensed = viewport < 600;
  els.tasksWrap.toggleAttribute("data-condensed-actions", condensed);
  if (actionGroup && table.contains(actionGroup) && !focused.checkVisibility()) {
    const next = condensed ? actionGroup.querySelector("[data-task-menu]") : actionGroup.querySelector("button[data-action]:enabled");
    (next || els.tasksWrap).focus({ preventScroll: true });
  }
  const select = 32, actions = parseFloat(getComputedStyle(table).getPropertyValue("--task-actions-width"));
  const minimum = select + actions + Object.values(widths).reduce((sum, width) => sum + width, 0);
  updateTaskScrollShadows(els.tasksWrap, minimum - viewport);
  let spare = Math.max(0, viewport - minimum);
  const capacity = automatic.reduce((sum, field) => sum + Math.max(0, taskColumnSizes[field][1] - widths[field]), 0);
  const fraction = capacity ? Math.min(1, spare / capacity) : 0;
  for (const field of automatic) {
    const growth = Math.floor(Math.max(0, taskColumnSizes[field][1] - widths[field]) * fraction);
    widths[field] += growth;
    spare -= growth;
  }
  if (automatic.length) {
    widths[automatic.includes("file") ? "file" : automatic[0]] += spare;
    spare = 0;
  }
  table.style.width = `${Math.max(minimum, viewport)}px`;
  table.style.setProperty("--task-table-width", table.style.width);
  table.toggleAttribute("data-fill", spare > 0);
  table.querySelector("col.col-fill").style.width = `${spare}px`;
  for (const field of visible) {
    table.querySelector(`col.col-${field}`).style.width = `${widths[field]}px`;
    const separator = table.querySelector(`.task-heading-${field} .task-resizer`);
    separator.setAttribute("aria-valuemin", minTaskColumnWidth);
    separator.setAttribute("aria-valuemax", Math.max(maxTaskColumnWidth, widths[field]));
    separator.setAttribute("aria-valuenow", widths[field]);
  }
  for (const cell of table.querySelectorAll(".task-spacer .spacer-data")) cell.colSpan = visible.length + Number(spare > 0);
  table.taskPlaceholderLayout = "";
}

function taskColumnMenuActions() {
  const actions = taskColumnOrder.map(field => `column-${hiddenTaskColumns.has(field) ? "show" : "hide"}-${field}`);
  actions.push("column-actions");
  if (Object.keys(taskColumnWidths).length) actions.push("columns-auto");
  return actions;
}

function runTaskColumnMenuAction(table, action) {
  const offered = taskColumnMenuActions();
  if (!offered.includes(action) || taskColumnMenuDisabled(action, offered)) return;
  if (action === "columns-auto") taskColumnWidths = {};
  else {
    const [, operation, field] = action.split("-");
    if (operation === "show") hiddenTaskColumns.delete(field);
    else hiddenTaskColumns.add(field);
  }
  const focused = document.activeElement;
  applyTaskColumnLayout(table);
  updateTaskPlaceholders(table);
  saveTaskColumnLayout();
  if (table.contains(focused) && !focused.checkVisibility()) table.querySelector(".select-cell input").focus({ preventScroll: true });
}

function beginTaskColumnResize(source) {
  const table = source.closest("table");
  const previous = taskColumnWidths;
  const widths = { ...previous };
  // Keep the left edge under the pointer while remaining automatic columns flex.
  for (const header of table.querySelectorAll("th[data-task-column]")) {
    const field = header.dataset.taskColumn;
    if (!hiddenTaskColumns.has(field)) widths[field] = Math.round(header.getBoundingClientRect().width);
    if (header === source) break;
  }
  const field = source.dataset.taskColumn;
  const start = widths[field];
  return {
    update(delta) {
      const width = Math.max(minTaskColumnWidth, Math.min(maxTaskColumnWidth, Math.round(start + delta)));
      if (width === widths[field]) return;
      widths[field] = width;
      taskColumnWidths = width === start ? previous : widths;
      applyTaskColumnLayout(table);
    },
    finish(commit) {
      if (!commit) taskColumnWidths = previous;
      if (taskColumnWidths !== previous) saveTaskColumnLayout();
      if (table.isConnected) { applyTaskColumnLayout(table); updateTaskPlaceholders(table); }
    },
  };
}
