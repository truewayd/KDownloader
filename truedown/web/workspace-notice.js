// One compact status surface; update work stays owned by the core.
let workspaceNoticeTarget = "about";
let workspaceUpdateReadFailed = false;

function renderWorkspaceNotice() {
  const host = document.getElementById("workspace-notice");
  if (!host) return;
  const state = systemUpdateState;
  let title = "", detail = "", tooltip = "", icon = "info", progress = null, running = false;
  workspaceNoticeTarget = "about";
  if (workspaceUpdateReadFailed) {
    title = "\u8fde\u63a5\u91cd\u8bd5\u4e2d";
    tooltip = "\u66f4\u65b0\u72b6\u6001\u6682\u4e0d\u53ef\u7528\uff0c\u6b63\u5728\u81ea\u52a8\u91cd\u8bd5";
  } else if (state) {
    const { trueDown = {}, engine = {}, busy, error, download } = state;
    if (busy) {
      const next = busy === "next-engine";
      workspaceNoticeTarget = ["truedown", "program-update"].includes(busy) ? "about" : "engine";
      icon = "download";
      title = busy === "truedown" ? "\u68c0\u67e5\u66f4\u65b0" : next ? "\u68c0\u67e5\u5185\u6838" : "\u5207\u6362\u5185\u6838";
      if (busy === "engine-recovery") title = "\u6062\u590d\u5185\u6838";
      if (busy === "engine-reload") title = "\u91cd\u8f7d\u4e2d";
      if (busy === "program-update") title = "\u91cd\u542f\u66f4\u65b0\u4e2d";
      tooltip = title + " \u00b7 \u67e5\u770b\u8be6\u60c5";
      if (download && ["truedown", "next-engine"].includes(busy)) {
        const product = next ? "NEXT" : "TrueDown";
        title = ({ queued: "\u7b49\u5f85\u4e0b\u8f7d", paused: "\u66f4\u65b0\u5df2\u6682\u505c", done: "\u6821\u9a8c\u66f4\u65b0", error: "\u4e0b\u8f7d\u5931\u8d25" })[download.status] || "\u4e0b\u8f7d\u66f4\u65b0";
        tooltip = product + " \u00b7 " + title;
        if (download.status !== "done") {
          progress = download.totalLength > 0 ? Math.min(100, download.completedLength / download.totalLength * 100) : -1;
          running = download.status === "downloading";
          detail = progress >= 0 ? Math.floor(progress) + "%" : "";
          const completed = download.completedLength ? taskBytes(download.completedLength) : "0 B";
          tooltip += " \u00b7 " + (detail ? detail + " \u00b7 " : "") + completed;
          if (download.totalLength > 0) tooltip += " / " + taskBytes(download.totalLength);
          if (running && download.downloadSpeed > 0) tooltip += " \u00b7 " + taskBytes(download.downloadSpeed) + "/s";
        }
      }
    } else if (trueDown.restartRequired) {
      title = "\u91cd\u542f\u66f4\u65b0";
      tooltip = (trueDown.pendingVersion || "build " + trueDown.pendingBuild) + " \u5df2\u5c31\u7eea" + (trueDown.autoUpdate ? " \u00b7 \u7a7a\u95f2\u65f6\u81ea\u52a8\u91cd\u542f" : "");
      icon = "refresh";
      workspaceNoticeTarget = "restart";
    } else if (error) {
      title = "\u66f4\u65b0\u5931\u8d25";
      tooltip = error;
    } else if (engine.restartRequired) {
      title = "\u5185\u6838\u5df2\u5c31\u7eea";
      tooltip = engine.autoUpdate ? "\u961f\u5217\u7a7a\u95f2\u540e\u81ea\u52a8\u5207\u6362" : "\u524d\u5f80\u8bbe\u7f6e\u5e94\u7528\u66f4\u65b0";
      workspaceNoticeTarget = "engine";
    } else if (trueDown.updateAvailable) {
      title = "\u53d1\u73b0\u65b0\u7248\u672c";
      tooltip = trueDown.availableVersion || "\u524d\u5f80\u8bbe\u7f6e\u66f4\u65b0";
    }
  }
  const traffic = !title;
  if (traffic) {
    workspaceNoticeTarget = "tasks";
    icon = "download";
    title = "下载概览";
    detail = "";
    tooltip = `${currentSummary.downloading} 个下载中，${currentSummary.error} 个出错，${taskDownloadedBytes(currentSummary.downloadSpeed)}/s，查看全部任务`;
  }
  host.hidden = false;
  document.getElementById("workspace-traffic").hidden = !traffic;
  host.querySelector(".notice-copy").hidden = traffic;
  document.getElementById("workspace-speed").textContent = `${taskDownloadedBytes(currentSummary.downloadSpeed)}/s`;
  const button = document.getElementById("workspace-notice-action");
  document.getElementById("workspace-notice-title").textContent = title;
  document.getElementById("workspace-notice-detail").textContent = detail;
  button.title = tooltip || title;
  KDComponents.setBusyState(button, restartingForUpdate);
  button.setAttribute("aria-label", restartingForUpdate ? "\u6b63\u5728\u91cd\u542f\u66f4\u65b0" : title + (tooltip ? "\uff0c" + tooltip : ""));
  const statusIcon = button.querySelector(".icon");
  statusIcon.toggleAttribute("hidden", progress !== null);
  statusIcon.querySelector("use").setAttribute("href", "/icons.svg#icon-" + icon);
  const ring = document.getElementById("workspace-notice-progress");
  ring.hidden = progress === null;
  ring.dataset.indeterminate = String(progress === -1);
  ring.dataset.running = String(running);
  if (progress === null || progress < 0) ring.removeAttribute("aria-valuenow");
  else ring.setAttribute("aria-valuenow", String(Math.floor(progress)));
  ring.querySelector(".notice-progress-value").setAttribute("stroke-dasharray", (progress === null || progress < 0 ? 25 : progress) + " 100");
  // Announce phase changes without reading each progress tick aloud.
  const announcement = document.getElementById("workspace-notice-announcement");
  if (announcement.textContent !== title) announcement.textContent = title;
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("workspace-notice-action")?.addEventListener("click", () => {
    if (workspaceNoticeTarget === "tasks") {
      currentCategory = "";
      currentFilter = "all";
      currentSearch = "";
      els.taskSearch.value = "";
      document.getElementById("task-filter").value = "all";
      resetTaskViewport();
      if (currentPage !== "tasks") location.hash = "tasks";
      else { updateTaskNavigation(); refreshAndSchedule(true); }
      return;
    }
    if (workspaceNoticeTarget === "restart") { restartForTrueDownUpdate(); return; }
    if (nativeWindowRole === "main") {
      invokeNative("open_auxiliary", { kind: workspaceNoticeTarget }).catch(error => showToast(error.message, "error"));
    } else location.hash = `settings/${workspaceNoticeTarget}`;
  });
});
