const TASK_ROW_HEIGHT = 64;
let taskViewportFrame = 0;
let taskViewportOffset = 0;

function resetTaskViewport() {
  cancelAnimationFrame(taskViewportFrame);
  taskViewportFrame = 0;
  currentOffset = taskViewportOffset = 0;
  els.tasksWrap?.scrollTo({ top: 0 });
}

function initTaskViewport() {
  const schedule = () => {
    if (taskViewportFrame) return;
    taskViewportFrame = requestAnimationFrame(() => {
      taskViewportFrame = 0;
      readTaskViewport();
    });
  };
  els.tasksWrap.addEventListener("scroll", schedule, { passive: true });
  const update = () => {
    const table = els.tasksContainer.querySelector(".tasks-table");
    if (table) updateTaskPlaceholders(table);
    schedule();
  };
  const observer = new ResizeObserver(update);
  observer.observe(els.tasksWrap);
  const theme = matchMedia("(prefers-color-scheme: dark)");
  theme.addEventListener("change", update);
  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(taskViewportFrame);
    observer.disconnect();
    theme.removeEventListener("change", update);
  }, { once: true });
}

function readTaskViewport() {
  if (currentPage !== "tasks" || document.hidden || currentTotal <= PAGE_SIZE) return;
  const header = els.tasksContainer.querySelector("thead")?.offsetHeight || 40;
  const first = Math.max(0, Math.floor((els.tasksWrap.scrollTop - header) / TASK_ROW_HEIGHT));
  const visible = Math.ceil(els.tasksWrap.clientHeight / TASK_ROW_HEIGHT);
  // Keep generous overscan; ordinary small wheel movements need no network read.
  const withinLoadedWindow = first >= taskViewportOffset + (taskViewportOffset ? 10 : 0)
    && first + visible <= Math.min(taskViewportOffset + PAGE_SIZE - 10, currentTotal);
  // Returning to the loaded window must also invalidate an in-flight jump.
  const next = withinLoadedWindow ? taskViewportOffset
    : Math.min(Math.max(0, currentTotal - PAGE_SIZE), Math.max(0, Math.floor((first - 20) / 40) * 40));
  if (next === currentOffset) return;
  currentOffset = next;
  refreshAndSchedule(true);
}

function updateTaskViewport(table) {
  taskViewportOffset = currentOffset;
  const spacers = table.querySelectorAll(".task-spacer td");
  spacers[0].style.height = `${currentOffset * TASK_ROW_HEIGHT}px`;
  spacers[1].style.height = `${Math.max(0, currentTotal - currentOffset - currentTasks.length) * TASK_ROW_HEIGHT}px`;
  table.setAttribute("aria-rowcount", String(currentTotal + 1));
  table.querySelectorAll(".task-rows tr").forEach((row, index) => row.setAttribute("aria-rowindex", String(currentOffset + index + 2)));
  updateTaskPlaceholders(table);
}

function updateTaskPlaceholders(table) {
  const row = table.querySelector(".task-rows tr");
  if (!row) return;
  const bounds = row.getBoundingClientRect();
  if (!bounds.width) return;
  const shapes = [];
  // Measure the real row so column widths, responsive hiding and icon surfaces
  // stay identical. Only one 64px tile is rasterized, regardless of list length.
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
      shapes.push(`<rect x="${number(box.left - bounds.left + (lineHeight ? left : 0))}" y="${number(box.top - bounds.top + (box.height - height) / 2)}" width="${number(width)}" height="${number(height)}" rx="${radius}"/>`);
    }
  }
  const width = number(bounds.width);
  const color = getComputedStyle(table).getPropertyValue("--kd-text").trim();
  const border = getComputedStyle(row.cells[0]).borderBottomColor;
  const signature = JSON.stringify([width, color, border, shapes]);
  if (table.taskPlaceholderSignature === signature) return;
  table.taskPlaceholderSignature = signature;
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="64" viewBox="0 0 ${width} 64">`;
  const paint = esc(color);
  const base = `<g fill="${paint}" opacity=".08">${shapes.join("")}</g><path d="M0 63.5H${width}" stroke="${esc(border)}"/>`;
  const shimmer = [
    `<defs><mask id="rows"><g fill="white">${shapes.join("")}</g></mask>`,
    `<linearGradient id="light" gradientUnits="userSpaceOnUse" x1="-${width}" x2="0">`,
    `<stop stop-color="${paint}" stop-opacity="0"/><stop offset=".5" stop-color="${paint}" stop-opacity=".1"/><stop offset="1" stop-color="${paint}" stop-opacity="0"/>`,
    `<animate attributeName="x1" values="-${width};${width}" dur="1.6s" repeatCount="indefinite"/>`,
    `<animate attributeName="x2" values="0;${width * 2}" dur="1.6s" repeatCount="indefinite"/>`,
    `</linearGradient></defs><rect width="${width}" height="64" fill="url(#light)" mask="url(#rows)"/>`,
  ].join("");
  const image = content => `url("data:image/svg+xml,${encodeURIComponent(open + base + content + "</svg>")}")`;
  table.style.setProperty("--task-placeholder-static", image(""));
  table.style.setProperty("--task-placeholder-animated", image(shimmer));
}

function reconcileTaskRows(body, tasks) {
  const rows = new Map(Array.from(body.children, (row) => [Number(row.dataset.taskId), row]));
  const keep = new Set(tasks.map((task) => task.id));
  for (const [id, row] of rows) if (!keep.has(id)) row.remove();
  tasks.forEach((task, index) => {
    const shape = JSON.stringify([task.status, task.outputName, task.name, task.folder, task.link, task.error, task.category, taskCategoryMeta(task.category).label, taskCategoryMeta(task.category).icon, task.updateDownload]);
    let row = rows.get(task.id);
    if (!row || row.taskShape !== shape) {
      const template = document.createElement("template");
      template.innerHTML = `<table><tbody>${taskRow(task)}</tbody></table>`;
      const next = template.content.querySelector("tr");
      if (!row) row = next;
      else Array.from(next.children).forEach((cell, i) => {
        if (row.children[i].innerHTML !== cell.innerHTML) row.children[i].replaceWith(cell);
      });
      row.taskShape = shape;
    }
    row.dataset.updateDownload = String(task.updateDownload === true);
    row.dataset.status = task.status;
    const progress = taskProgressLabel(task);
    const label = row.querySelector(".progress-line");
    if (label.textContent !== progress) {
      label.textContent = progress;
    }
    label.dataset.tooltip = task.error ? formatTaskError(task) : task.progress || progress;
    if (task.error) label.dataset.tooltipKind = "card";
    else delete label.dataset.tooltipKind;
    row.querySelector(".task-progress").value = taskProgressPercent(task);
    for (const [selector, value] of [[".task-size", taskBytes(task.totalLength)], [".task-speed", taskSpeed(task)], [".task-remaining", taskRemaining(task)], [".task-created", taskDate(task.createdAt)]]) {
      const node = row.querySelector(selector);
      if (node.textContent !== value) node.textContent = value;
    }
    const checkbox = row.querySelector("[data-select-task]");
    checkbox.checked = selectedTaskIDs.has(task.id);
    if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null);
  });
}
