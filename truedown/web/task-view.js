const readTaskRowHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--task-row-height"));
let taskRowHeight = readTaskRowHeight();
const taskNameSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
let taskNameContext;
// ResizeObserver delivers the viewport's changed widths together after layout.
const taskNameObserver = new ResizeObserver(entries => {
  for (const { target, contentRect } of entries) target.fit(contentRect.width);
});

// Keep the original light-DOM name intact for tooltips, accessibility and row
// reconciliation; only the shadow text is fitted to the available column width.
customElements.define("td-file-name", class extends HTMLElement {
  connectedCallback() {
    this.output ||= this.attachShadow({ mode: "open" });
    taskNameObserver.observe(this);
  }

  disconnectedCallback() {
    taskNameObserver.unobserve(this);
  }

  fit(width) {
    if (!width) return;
    const name = this.textContent;
    const style = getComputedStyle(this);
    const context = taskNameContext ||= document.createElement("canvas").getContext("2d");
    // Computed font shorthand can be empty when the table uses tabular numbers.
    // Canvas would silently keep its default 10px font and undermeasure the name.
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
    const fits = text => Math.ceil(context.measureText(text).width) <= width;
    let result = name;
    if (!fits(name)) {
      const chars = Array.from(taskNameSegmenter.segment(name), part => part.segment);
      const dot = chars.lastIndexOf(".");
      const hasExtension = dot > 0 && dot < chars.length - 1;
      const stem = hasExtension ? chars.slice(0, dot) : chars;
      const extension = hasExtension ? chars.slice(dot).join("") : "";
      const keepExtension = fits("…" + extension);
      const candidate = count => {
        if (!keepExtension) return stem.slice(0, count).join("") + "…";
        const tail = Math.floor(count / 2);
        return stem.slice(0, count - tail).join("") + "…" + (tail ? stem.slice(-tail).join("") : "") + extension;
      };
      if (!keepExtension && fits(extension)) {
        result = extension;
      } else {
        result = "";
        let low = 0, high = keepExtension ? stem.length - 1 : stem.length;
        while (low <= high) {
          const count = Math.floor((low + high) / 2);
          const text = candidate(count);
          if (fits(text)) { result = text; low = count + 1; }
          else high = count - 1;
        }
      }
    }
    if (this.output.textContent !== result) this.output.textContent = result;
  }
});
let taskViewportFrame = 0;
let taskViewportOffset = 0;
let taskScrollDirection = 1;
let taskScrollTop = 0;

function resetTaskViewport() {
  syncSelectionControls();
  cancelAnimationFrame(taskViewportFrame);
  taskViewportFrame = 0;
  currentOffset = taskViewportOffset = 0;
  taskScrollTop = 0;
  taskScrollDirection = 1;
  els.tasksWrap?.scrollTo({ top: 0 });
}

function initTaskViewport() {
  const schedule = () => {
    if (taskViewportFrame) return;
    taskViewportFrame = requestAnimationFrame(() => {
      taskViewportFrame = 0;
      updateTaskScrollShadows(els.tasksWrap);
      readTaskViewport();
    });
  };
  els.tasksWrap.addEventListener("scroll", schedule, { passive: true });
  const update = () => {
    const table = els.tasksContainer.querySelector(".tasks-table");
    if (table) { applyTaskColumnLayout(table); updateTaskPlaceholders(table); }
    schedule();
  };
  const observer = new ResizeObserver(update);
  observer.observe(els.tasksWrap);
  const theme = matchMedia("(prefers-color-scheme: dark)");
  theme.addEventListener("change", update);
  const updateLanguage = () => {
    for (const row of els.tasksContainer.querySelectorAll(".task-rows tr")) {
      const button = row.querySelector(".task-name-button");
      const names = taskNameLabels(button.dataset.action === "preview", button.dataset.tooltip);
      button.setAttribute("aria-label", names.open);
      row.querySelector("[data-select-task]").setAttribute("aria-label", names.select);
    }
    update();
  };
  window.addEventListener("truedown:language-changed", updateLanguage);
  const updateDensity = () => {
    const previousHeight = taskRowHeight;
    const top = els.tasksWrap.scrollTop;
    taskRowHeight = readTaskRowHeight();
    const table = els.tasksContainer.querySelector(".tasks-table");
    if (table) {
      table.taskPlaceholderLayout = "";
      updateTaskSpacers(table);
      els.tasksWrap.scrollTop = top * taskRowHeight / previousHeight;
    }
    schedule();
  };
  window.addEventListener("truedown:layout-density-changed", updateDensity);
  window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    cancelAnimationFrame(taskViewportFrame);
    observer.disconnect();
    theme.removeEventListener("change", update);
    window.removeEventListener("truedown:language-changed", updateLanguage);
    window.removeEventListener("truedown:layout-density-changed", updateDensity);
  });
}

const TASK_COLUMN_ORDER_KEY = "truedown-task-column-order-v1";

function bindTaskColumnSorting(container, scroller) {
  readTaskColumnLayout();
  try {
    const saved = JSON.parse(localStorage.getItem(TASK_COLUMN_ORDER_KEY));
    if (Array.isArray(saved) && saved.length === taskColumnOrder.length
      && new Set(saved).size === saved.length && saved.every(field => taskColumnOrder.includes(field))) {
      taskColumnOrder = saved;
    }
  } catch { /* Use the default order when storage is unavailable. */ }

  const sorting = KDComponents.drag.bindReorder(container, {
    axis: "x", item: "th[data-task-column]", exclude: ".task-resizer",
    label: source => source.querySelector(".sort-button").textContent.trim(),
    scrollParent: () => scroller,
    scrollEdges(source) {
      const header = source.closest("thead");
      return [header.querySelector(".select-cell").getBoundingClientRect().right,
        header.querySelector(".task-actions-heading").getBoundingClientRect().left];
    },
    move(source, target, after) { moveTaskColumn(source.closest("table"), source, target, after); },
  });
  const resizing = KDComponents.drag.bindPointer(container, down => {
    const handle = down.target.closest(".task-resizer");
    if (!handle || down.altKey || down.ctrlKey || down.metaKey || down.shiftKey) return;
    const source = handle.closest("th"), label = source.querySelector(".sort-button").textContent.trim();
    const resize = beginTaskColumnResize(source);
    function showWidth(event, feedback) {
      const width = Math.round(source.getBoundingClientRect().width);
      feedback.move(`${label} · ${width} px`, event.clientX, event.clientY);
    }
    return {
      source, feedback: { kind: "resize" },
      start(event, feedback) {
        handle.focus({ preventScroll: true });
        container.classList.add("task-resizing");
        showWidth(event, feedback);
      },
      move(event, released, feedback) {
        resize.update(event.clientX - down.clientX);
        if (!released) showWidth(event, feedback);
      },
      end(reason) {
        container.classList.remove("task-resizing");
        resize.finish(reason === "release");
      },
    };
  });
  container.addEventListener("keydown", event => {
    if (sorting.active || resizing.active || !event.target.matches(".task-resizer") || event.altKey || event.ctrlKey
      || event.metaKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const resize = beginTaskColumnResize(event.target.closest("th"));
    resize.update(event.key === "ArrowRight" ? 8 : -8);
    resize.finish(true);
  });
}

function moveTaskColumn(table, source, target, after) {
  const from = source.cellIndex;
  const before = target.cellIndex + Number(after);
  const to = before - Number(from < before);
  if (from === to) return;
  const focused = document.activeElement;
  // Keep the mounted rows, their selection state, and their cached nodes.
  for (const row of table.querySelectorAll("colgroup, thead tr, .task-rows > tr")) {
    row.insertBefore(row.children[from], row.children[before] || null);
  }
  const [field] = taskColumnOrder.splice(from - 1, 1);
  taskColumnOrder.splice(to - 1, 0, field);
  try { localStorage.setItem(TASK_COLUMN_ORDER_KEY, JSON.stringify(taskColumnOrder)); }
  catch { /* Keep the order in this window even when storage is unavailable. */ }
  table.taskPlaceholderLayout = "";
  updateTaskPlaceholders(table);
  if (document.activeElement !== focused && table.contains(focused)) focused.focus({ preventScroll: true });
}

function readTaskViewport() {
  if (currentPage !== "tasks" || document.hidden || currentTotal <= PAGE_SIZE) return;
  const header = els.tasksContainer.querySelector("thead")?.offsetHeight || 40;
  const first = Math.max(0, Math.floor((els.tasksWrap.scrollTop - header) / taskRowHeight));
  const visible = Math.ceil(els.tasksWrap.clientHeight / taskRowHeight);
  const top = els.tasksWrap.scrollTop;
  if (top !== taskScrollTop) taskScrollDirection = top > taskScrollTop ? 1 : -1;
  taskScrollTop = top;
  // Keep generous overscan; ordinary small wheel movements need no network read.
  const withinLoadedWindow = first >= taskViewportOffset + (taskViewportOffset ? 10 : 0)
    && first + visible <= Math.min(taskViewportOffset + PAGE_SIZE - 10, currentTotal);
  // Returning to the loaded window must also invalidate an in-flight jump.
  const next = withinLoadedWindow ? taskViewportOffset
    : Math.min(Math.max(0, currentTotal - PAGE_SIZE), Math.max(0, Math.floor((first - 20) / 40) * 40));
  if (next === currentOffset) { prefetchTaskViewport(); return; }
  currentOffset = next;
  window.clearTimeout(pollTimer);
  loadTasks({ viewport: true }).finally(schedulePoll);
}

function prefetchTaskViewport() {
  if (currentPage !== "tasks" || document.hidden || currentTotal <= PAGE_SIZE || taskViewportOffset !== currentOffset) return;
  const offset = Math.min(Math.max(0, currentTotal - PAGE_SIZE), Math.max(0, currentOffset + taskScrollDirection * 40));
  if (offset === currentOffset) return;
  const url = taskPageURL(offset);
  if (taskPages.peek(url)) return;
  void taskPages.request(url, { prefetch: true }).catch(() => {});
}

function updateTaskViewport(table) {
  taskViewportOffset = currentOffset;
  updateTaskSpacers(table);
  const count = String(currentTotal + 1);
  if (table.getAttribute("aria-rowcount") !== count) table.setAttribute("aria-rowcount", count);
  table.querySelectorAll(".task-rows tr").forEach((row, index) => {
    const position = String(currentOffset + index + 2);
    if (row.getAttribute("aria-rowindex") !== position) row.setAttribute("aria-rowindex", position);
  });
}

function updateTaskSpacers(table) {
  const spacers = table.querySelectorAll(".task-spacer tr");
  spacers[0].style.height = `${taskViewportOffset * taskRowHeight}px`;
  spacers[1].style.height = `${Math.max(0, currentTotal - taskViewportOffset - currentTasks.length) * taskRowHeight}px`;
  updateTaskPlaceholders(table);
}

function updateTaskPlaceholders(table) {
  const row = table.querySelector(".task-rows tr");
  if (!row) return;
  // Progress and speed do not change fixed-row geometry. Resize/theme observers
  // invalidate this key explicitly, before any layout reads on the hot path.
  const layout = row.taskShape;
  if (layout && table.taskPlaceholderLayout === layout) return;
  const bounds = row.getBoundingClientRect();
  if (!bounds.width) return;
  const selectOffset = row.cells[0].getBoundingClientRect().left - bounds.left;
  const actionsOffset = row.cells[row.cells.length - 1].getBoundingClientRect().right - bounds.right;
  table.taskPlaceholderLayout = layout;
  const shapes = [];
  // Measure the real row so column widths, responsive hiding and icon surfaces
  // stay identical. Only one row tile is rasterized, regardless of list length.
  const parts = [
    [".select-cell input", 16, 4],
    [".task-file-cell > .icon", 0, 10], [".task-name", 12, 6],
    [".task-file-cell .task-folder", 8, 4], [".status-badge", 0, 10],
    [".progress-line", 10, 5], [".task-progress", 0, 3],
    [".task-size", 10, 5], [".task-speed", 10, 5],
    [".task-remaining", 8, 4], [".task-created", 10, 5],
    [".row-actions .text-button", 0, 8],
  ];
  const number = value => Math.round(value * 10) / 10;
  for (const [selector, lineHeight, radius] of parts) {
    for (const node of row.querySelectorAll(selector)) {
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const style = getComputedStyle(node);
      const left = parseFloat(style.paddingLeft) || 0;
      const right = parseFloat(style.paddingRight) || 0;
      const height = lineHeight || box.height;
      const width = lineHeight ? Math.max(0, box.width - left - right) : box.width;
      const stickyOffset = node.closest(".select-cell") ? selectOffset : node.closest(".row-actions") ? actionsOffset : 0;
      shapes.push(`<rect x="${number(box.left - bounds.left - stickyOffset + (lineHeight ? left : 0))}" y="${number(box.top - bounds.top + (box.height - height) / 2)}" width="${number(width)}" height="${number(height)}" rx="${radius}"/>`);
    }
  }
  const width = number(bounds.width);
  const color = getComputedStyle(table).getPropertyValue("--kd-text").trim();
  const border = getComputedStyle(row.cells[0]).borderBottomColor;
  const signature = JSON.stringify([width, taskRowHeight, color, border, shapes]);
  if (table.taskPlaceholderSignature === signature) return;
  table.taskPlaceholderSignature = signature;
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${taskRowHeight}" viewBox="0 0 ${width} ${taskRowHeight}">`;
  // Isolated SVG images use the same loop curve as the CSS progress indicators.
  const loopTiming = 'calcMode="spline" keyTimes="0;1" keySplines=".42 .26 .58 .74"';
  const paint = esc(color);
  const base = `<g fill="${paint}" opacity=".08">${shapes.join("")}</g><path d="M0 ${taskRowHeight - .5}H${width}" stroke="${esc(border)}"/>`;
  const shimmer = [
    `<defs><mask id="rows"><g fill="white">${shapes.join("")}</g></mask>`,
    `<linearGradient id="light" gradientUnits="userSpaceOnUse" x1="-${width}" x2="0">`,
    `<stop stop-color="${paint}" stop-opacity="0"/><stop offset=".5" stop-color="${paint}" stop-opacity=".1"/><stop offset="1" stop-color="${paint}" stop-opacity="0"/>`,
    `<animate attributeName="x1" values="-${width};${width}" dur="1.6s" ${loopTiming} repeatCount="indefinite"/>`,
    `<animate attributeName="x2" values="0;${width * 2}" dur="1.6s" ${loopTiming} repeatCount="indefinite"/>`,
    `</linearGradient></defs><rect width="${width}" height="${taskRowHeight}" fill="url(#light)" mask="url(#rows)"/>`,
  ].join("");
  const image = content => `url("data:image/svg+xml,${encodeURIComponent(open + base + content + "</svg>")}")`;
  table.style.setProperty("--task-placeholder-static", image(""));
  table.style.setProperty("--task-placeholder-animated", image(shimmer));
}

function reconcileTaskRows(body, tasks, epoch = "", groupsRevision = 0) {
  const rows = new Map(Array.from(body.children, (row) => [Number(row.dataset.taskId), row]));
  const keep = new Set(tasks.map((task) => task.id));
  for (const [id, row] of rows) if (!keep.has(id)) row.remove();
  tasks.forEach((task, index) => {
    let row = rows.get(task.id);
    if (row && Number.isSafeInteger(task.revision) && row.taskEpoch === epoch && row.taskRevision === task.revision
      && row.groupsRevision === groupsRevision && row.media === task.media && row.requiresMediaEngine === task.requiresMediaEngine) {
      if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null);
      return;
    }
    const category = taskCategoryMeta(task.category);
    const shape = JSON.stringify([task.status, task.outputName, task.name, task.folder, task.link, task.error, task.category, category.label, category.icon, task.updateDownload]);
    if (!row || row.taskShape !== shape) {
      const template = document.createElement("template");
      template.innerHTML = `<table><tbody>${taskRow(task)}</tbody></table>`;
      const next = template.content.querySelector("tr");
      if (!row) row = next;
      else Array.from(next.children).forEach((cell, i) => {
        if (row.children[i].innerHTML !== cell.innerHTML) row.children[i].replaceWith(cell);
      });
      row.taskShape = shape;
      row.taskNodes = null;
    }
    const nodes = row.taskNodes ||= {
      label: row.querySelector(".progress-line"), progress: row.querySelector(".task-progress"),
      checkbox: row.querySelector("[data-select-task]"),
      values: [".task-size", ".task-speed", ".task-remaining", ".task-created"].map(selector => row.querySelector(selector)),
    };
    if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null);
    nodes.checkbox.checked = selectedTaskIDs.has(task.id);
    row.taskEpoch = epoch;
    row.taskRevision = task.revision;
    row.groupsRevision = groupsRevision;
    row.media = task.media;
    row.requiresMediaEngine = task.requiresMediaEngine;
    row.dataset.updateDownload = String(task.updateDownload === true);
    row.dataset.status = task.status;
    const progress = taskProgressLabel(task);
    const label = nodes.label;
    if (label.textContent !== progress) {
      label.textContent = progress;
    }
    label.dataset.tooltip = task.error ? formatTaskError(task) : task.progress || progress;
    if (task.error) label.dataset.tooltipKind = "card";
    else delete label.dataset.tooltipKind;
    renderTaskProgress(nodes.progress, task);
    [taskBytes(task.totalLength || task.sizeHint), taskSpeed(task), taskRemaining(task), taskDate(task.createdAt)].forEach((value, index) => {
      const node = nodes.values[index];
      if (node.textContent !== value) node.textContent = value;
    });
  });
}
