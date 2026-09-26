// Only bounded, sanitized engine snapshots reach this view.
function renderTaskTransfer(transfer, status) {
  const available = transfer?.available === true;
  const pieces = available && Array.isArray(transfer.pieces) ? transfer.pieces.slice(0, 96) : [];
  const map = document.getElementById("task-piece-map");
  const pieceStatus = document.getElementById("task-pieces-status");
  document.getElementById("task-transfer-summary").textContent = available ? `${transfer.connections} \u4e2a\u8fde\u63a5` : "";
  map.hidden = document.getElementById("task-piece-legend").hidden = !pieces.length;
  if (pieces.length) {
    pieceStatus.textContent = `\u5df2\u5b8c\u6210 ${transfer.completedPieces} / ${transfer.pieceCount} \u5757 \u00b7 \u6bcf\u5757 ${taskBytes(transfer.pieceLength)}`;
    map.setAttribute("aria-label", pieceStatus.textContent);
    pieces.forEach((part, index) => {
      let cell = map.children[index];
      if (!cell) { cell = document.createElement("span"); cell.setAttribute("aria-hidden", "true"); map.append(cell); }
      cell.dataset.pieceState = part.completed === part.count ? "complete" : part.completed > 0 ? "mixed" : "pending";
      cell.title = `\u7b2c ${part.first + 1}\u2013${part.first + part.count} \u5757\uff1a\u5df2\u5b8c\u6210 ${part.completed} / ${part.count}`;
    });
  } else {
    pieceStatus.textContent = status === "done" ? "\u4e0b\u8f7d\u5df2\u5b8c\u6210\u3002" : status === "error" ? "\u4e0b\u8f7d\u5df2\u505c\u6b62\u3002" : available ? "\u7b49\u5f85\u5f15\u64ce\u63d0\u4f9b\u5206\u5757\u4fe1\u606f\u2026" : "\u5206\u5757\u4fe1\u606f\u6682\u4e0d\u53ef\u7528\u3002";
    map.setAttribute("aria-label", pieceStatus.textContent);
  }
  while (map.children.length > pieces.length) map.lastChild.remove();
  const servers = available && transfer.serversAvailable && Array.isArray(transfer.servers) ? transfer.servers.slice(0, 64) : [];
  document.getElementById("task-connections").hidden = !servers.length;
  const body = document.getElementById("task-connections-body");
  servers.forEach((server, index) => {
    let row = body.children[index];
    if (!row) {
      row = document.createElement("tr");
      for (let i = 0; i < 4; i++) row.append(document.createElement("td"));
      body.append(row);
    }
    const values = [String(index + 1), server.host || "\u672a\u77e5\u6765\u6e90", server.downloadSpeed > 0 ? "\u63a5\u6536\u6570\u636e" : "\u5df2\u8fde\u63a5", `${taskDownloadedBytes(server.downloadSpeed)}/s`];
    values.forEach((value, i) => { if (row.children[i].textContent !== value) row.children[i].textContent = value; });
  });
  while (body.children.length > servers.length) body.lastChild.remove();
  document.getElementById("task-connections-status").textContent = !available ? "" : !transfer.serversAvailable ? "\u8fde\u63a5\u8be6\u60c5\u6682\u4e0d\u53ef\u7528\u3002" : transfer.serversTruncated ? "\u4ec5\u663e\u793a\u524d 64 \u4e2a\u8fde\u63a5\u3002" : !servers.length ? "\u5f53\u524d\u6ca1\u6709 HTTP / FTP \u8fde\u63a5\u3002" : "";
}
