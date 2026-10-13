// Explicit, metadata-only native probing. Form fields remain user-owned.
let linkProbeRevision = 0;
let linkProbeController = null;

function updateProbeAvailability() {
  const button = document.getElementById("probe-link-btn");
  if (!button) return;
  if (!mediaCapabilities.probe && linkProbeController) cancelLinkProbe();
  button.disabled = !mediaCapabilities.probe || !!linkProbeController;
  button.setAttribute("aria-disabled", String(button.disabled));
  document.getElementById("probe-link-hint").textContent = mediaCapabilities.probe
    ? "探测单个 HTTP(S) 链接，不创建任务。媒体清单的大小不代表最终视频大小。"
    : "探测需要 NEXT 3；每次支持一个 HTTP(S) 链接。";
}

function cancelLinkProbe() {
  linkProbeRevision++;
  linkProbeController?.abort();
  linkProbeController = null;
  const button = document.getElementById("probe-link-btn");
  if (button) {
    button.disabled = !mediaCapabilities.probe;
    KDComponents.setBusyState(button, false, { manageDisabled: false });
  }
  const result = document.getElementById("probe-link-result");
  if (result) { result.textContent = ""; result.hidden = true; }
}

function buildLinkProbeRequest() {
  const links = parseLinks(els.mLink.value);
  if (links.length !== 1 || !/^https?:\/\//i.test(links[0]) || els.mTorrentFile.files?.length) {
    throw new Error("请填写一个 HTTP(S) 链接，并移除已选种子文件");
  }
  return { link: links[0], ...buildTaskTransport() };
}

function linkProbeMessage(result) {
  if (result.errorCode) return result.status >= 400 ? `服务器返回 HTTP ${result.status}，未取得可用文件信息。` : "未能取得文件信息，请稍后重试。";
  const parts = [`HTTP ${result.status}`];
  if (result.filename) parts.push(`建议文件名：${result.filename}`);
  parts.push(Number.isSafeInteger(result.totalLength) && result.totalLength >= 0 ? `大小：${taskDownloadedBytes(result.totalLength)}` : "大小未知");
  parts.push(result.resumable ? "服务器支持续传" : "服务器未确认续传支持");
  if (result.contentType) parts.push(`类型：${result.contentType}`);
  return parts.join(" · ");
}

async function probeDownloadLink() {
  cancelLinkProbe();
  if (!mediaCapabilities.probe) return;
  const revision = linkProbeRevision;
  const controller = new AbortController();
  linkProbeController = controller;
  const button = document.getElementById("probe-link-btn");
  const result = document.getElementById("probe-link-result");
  KDComponents.setBusyState(button, true, { busyLabel: "正在探测链接" });
  try {
    if (isNativeTaskWindow()) await refreshNativeTaskPreferences();
    if (revision !== linkProbeRevision) return;
    const body = JSON.stringify(buildLinkProbeRequest());
    const response = await requestJSON("/tasks/probe", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    if (revision !== linkProbeRevision || document.hidden || body !== JSON.stringify(buildLinkProbeRequest())) return;
    result.textContent = linkProbeMessage(response);
    result.hidden = false;
  } catch (error) {
    if (revision === linkProbeRevision && !controller.signal.aborted && !document.hidden) {
      result.textContent = `探测失败：${error.message}`;
      result.hidden = false;
    }
  } finally {
    if (revision === linkProbeRevision) {
      linkProbeController = null;
      KDComponents.setBusyState(button, false, { manageDisabled: false });
      updateProbeAvailability();
    }
  }
}

document.getElementById("probe-link-btn")?.addEventListener("click", probeDownloadLink);
for (const event of ["input", "change"]) document.getElementById("download-form")?.addEventListener(event, cancelLinkProbe);
document.addEventListener("visibilitychange", () => { if (document.hidden) cancelLinkProbe(); });
window.addEventListener("pagehide", cancelLinkProbe);
