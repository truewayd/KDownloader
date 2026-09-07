function reconcileTaskRows(body, tasks) {
  const rows = new Map(Array.from(body.children, (row) => [Number(row.dataset.taskId), row]));
  const keep = new Set(tasks.map((task) => task.id));
  for (const [id, row] of rows) if (!keep.has(id)) row.remove();
  tasks.forEach((task, index) => {
    const shape = JSON.stringify([task.status, task.outputName, task.name, task.folder, task.link, task.error]);
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
    const progress = task.error ? `! ${formatTaskError(task)}` : task.progress || "-";
    const label = row.querySelector(".progress-line");
    if (label.textContent !== progress) {
      label.textContent = progress;
      label.title = progress;
    }
    const ordinal = row.querySelector(".task-index");
    const number = String(currentOffset + index + 1);
    if (ordinal.textContent !== number) ordinal.textContent = number;
    const checkbox = row.querySelector("[data-select-task]");
    checkbox.checked = selectedTaskIDs.has(task.id);
    if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null);
  });
}
