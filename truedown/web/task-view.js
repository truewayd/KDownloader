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
