// One compact status surface; update work stays owned by the core.
let workspaceNoticeTarget = "about";
let workspaceUpdateReadFailed = false;

function renderWorkspaceNotice() {
  const host = document.getElementById("workspace-notice");
  if (!host) return;
  const state = systemUpdateState;
  let title = "", detail = "", icon = "info", progress = null;
  workspaceNoticeTarget = "about";
  if (workspaceUpdateReadFailed) {
    title = "\u66f4\u65b0\u72b6\u6001\u6682\u4e0d\u53ef\u7528";
    detail = "\u6b63\u5728\u81ea\u52a8\u91cd\u8bd5";
  } else if (state) {
    const { trueDown, engine, busy, error, download } = state;
    if (busy) {
      const next = busy === "next-engine";
      workspaceNoticeTarget = ["truedown", "program-update"].includes(busy) ? "about" : "engine";
      icon = "download";
      title = busy === "truedown" ? "\u6b63\u5728\u68c0\u67e5 TrueDown \u66f4\u65b0" : next ? "\u6b63\u5728\u68c0\u67e5 NEXT \u66f4\u65b0" : "\u6b63\u5728\u5207\u6362\u4e0b\u8f7d\u5185\u6838";
      if (busy === "engine-recovery") title = "\u6b63\u5728\u6062\u590d\u4e0b\u8f7d\u5185\u6838";
      if (busy === "engine-reload") title = "\u6b63\u5728\u91cd\u8f7d TrueDown";
      if (busy === "program-update") title = "TrueDown \u6b63\u5728\u91cd\u542f\u66f4\u65b0";
      detail = "\u67e5\u770b\u8be6\u60c5";
      if (download && ["truedown", "next-engine"].includes(busy)) {
        const product = next ? "NEXT" : "TrueDown";
        title = `${product} \u66f4\u65b0${({ queued: "\u7b49\u5f85\u4e0b\u8f7d", paused: "\u5df2\u6682\u505c", done: "\u6b63\u5728\u6821\u9a8c", error: "\u4e0b\u8f7d\u5931\u8d25" })[download.status] || "\u6b63\u5728\u4e0b\u8f7d"}`;
        if (download.status !== "done") {
          progress = download.totalLength > 0 ? Math.min(100, download.completedLength / download.totalLength * 100) : -1;
          const completed = download.completedLength ? taskBytes(download.completedLength) : "0 B";
          detail = progress >= 0 ? `${Math.floor(progress)}% \u00b7 ${completed} / ${taskBytes(download.totalLength)}` : completed;
          if (download.status === "downloading" && download.downloadSpeed > 0) detail += ` \u00b7 ${taskBytes(download.downloadSpeed)}/s`;
        } else detail = "\u6821\u9a8c\u5b8c\u6210\u540e\u51c6\u5907\u5b89\u88c5";
      }
    } else if (trueDown.restartRequired) {
      title = "\u91cd\u542f\u5e76\u66f4\u65b0";
      detail = `${trueDown.pendingVersion || `build ${trueDown.pendingBuild}`} \u5df2\u5c31\u7eea${trueDown.autoUpdate ? " \u00b7 \u7a7a\u95f2\u65f6\u81ea\u52a8\u91cd\u542f" : ""}`;
      icon = "refresh";
      workspaceNoticeTarget = "restart";
    } else if (error) {
      title = "\u66f4\u65b0\u9700\u8981\u5904\u7406";
      detail = error;
    } else if (engine.restartRequired) {
      title = "\u5185\u6838\u66f4\u65b0\u5df2\u5c31\u7eea";
      detail = engine.autoUpdate ? "\u961f\u5217\u7a7a\u95f2\u540e\u81ea\u52a8\u5207\u6362" : "\u524d\u5f80\u8bbe\u7f6e\u5e94\u7528\u66f4\u65b0";
      workspaceNoticeTarget = "engine";
    } else if (trueDown.updateAvailable) {
      title = "\u53d1\u73b0 TrueDown \u65b0\u7248\u672c";
      detail = trueDown.availableVersion || "\u524d\u5f80\u8bbe\u7f6e\u66f4\u65b0";
    }
  }
  host.hidden = !title;
  const button = document.getElementById("workspace-notice-action");
  document.getElementById("workspace-notice-title").textContent = title;
  document.getElementById("workspace-notice-detail").textContent = detail;
  button.title = `${title}${detail ? `\n${detail}` : ""}`;
  button.setAttribute("aria-label", `${title}\uff0c${detail}`);
  button.querySelector("use").setAttribute("href", `/icons.svg#icon-${icon}`);
  KDComponents.setBusyState(button, restartingForUpdate, { busyLabel: "\u6b63\u5728\u91cd\u542f\u66f4\u65b0\u2026" });
  const bar = document.getElementById("workspace-notice-progress");
  bar.hidden = progress === null;
  if (progress === null || progress < 0) bar.removeAttribute("value");
  else bar.value = progress;
  // Announce phase changes without reading each progress tick aloud.
  const announcement = document.getElementById("workspace-notice-announcement");
  if (announcement.textContent !== title) announcement.textContent = title;
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("workspace-notice-action")?.addEventListener("click", () => {
    if (workspaceNoticeTarget === "restart") { restartForTrueDownUpdate(); return; }
    if (nativeWindowRole === "main") {
      invokeNative("open_auxiliary", { kind: workspaceNoticeTarget }).catch(error => showToast(error.message, "error"));
    } else location.hash = `settings/${workspaceNoticeTarget}`;
  });
});
