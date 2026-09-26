const TASK_ROW_HEIGHT = 64;
let taskViewportTimer = 0;
let taskViewportOffset = 0;

function resetTaskViewport() {
  clearTimeout(taskViewportTimer);
  currentOffset = taskViewportOffset = 0;
  els.tasksWrap?.scrollTo({ top: 0 });
}

function initTaskViewport() {
  const schedule = () => {
    clearTimeout(taskViewportTimer);
    taskViewportTimer = setTimeout(readTaskViewport, 80);
  };
  els.tasksWrap.addEventListener("scroll", schedule, { passive: true });
  const observer = new ResizeObserver(schedule);
  observer.observe(els.tasksWrap);
  window.addEventListener("pagehide", () => { clearTimeout(taskViewportTimer); observer.disconnect(); }, { once: true });
}

function readTaskViewport() {
  if (currentPage !== "tasks" || document.hidden || currentTotal <= PAGE_SIZE) return;
  const header = els.tasksContainer.querySelector("thead")?.offsetHeight || 40;
  const first = Math.max(0, Math.floor((els.tasksWrap.scrollTop - header) / TASK_ROW_HEIGHT));
  const visible = Math.ceil(els.tasksWrap.clientHeight / TASK_ROW_HEIGHT);
  // Keep generous overscan; ordinary small wheel movements need no network read.
  if (first >= taskViewportOffset + (taskViewportOffset ? 10 : 0)
      && first + visible <= Math.min(taskViewportOffset + PAGE_SIZE - 10, currentTotal)) return;
  const next = Math.min(Math.max(0, currentTotal - PAGE_SIZE), Math.max(0, Math.floor((first - 20) / 40) * 40));
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
}

function reconcileTaskRows(body, tasks) {
  const rows = new Map(Array.from(body.children, (row) => [Number(row.dataset.taskId), row]));
  const keep = new Set(tasks.map((task) => task.id));
  for (const [id, row] of rows) if (!keep.has(id)) row.remove();
  tasks.forEach((task, index) => {
    const shape = JSON.stringify([task.status, task.outputName, task.name, task.folder, task.link, task.error, task.category, taskCategoryMeta(task.category).label, taskCategoryMeta(task.category).icon]);
    let row = rows.get(task.id);
    if (!row || row.taskShape !== shape) {
      const template = document.createElement("template");
      template.innerHTML = `<table><tbody>${taskRow(task, index)}</tbody></table>`;
      const next = template.content.querySelector("tr");
      if (!row) row = next;
      else Array.from(next.children).forEach((cell, i) => {
        if (row.children[i].innerHTML !== cell.innerHTML) row.children[i].replaceWith(cell);
      });
      row.taskShape = shape;
    }
    const progress = taskProgressLabel(task);
    const label = row.querySelector(".progress-line");
    if (label.textContent !== progress) {
      label.textContent = progress;
    }
    label.title = task.error ? formatTaskError(task) : task.progress || progress;
    row.querySelector(".task-progress").value = taskProgressPercent(task);
    for (const [selector, value] of [[".task-size", taskBytes(task.totalLength)], [".task-speed", taskSpeed(task)], [".task-remaining", taskRemaining(task)], [".task-created", taskDate(task.createdAt)]]) {
      const node = row.querySelector(selector);
      if (node.textContent !== value) node.textContent = value;
    }
    const ordinal = row.querySelector(".task-index");
    const number = String(currentOffset + index + 1);
    if (ordinal.textContent !== number) ordinal.textContent = number;
    const checkbox = row.querySelector("[data-select-task]");
    checkbox.checked = selectedTaskIDs.has(task.id);
    if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null);
  });
}
