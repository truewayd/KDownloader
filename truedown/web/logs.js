let applicationLogRequest = 0;
let applicationLogAbort = null;
let applicationLogTimer = 0;

function isApplicationLogPage() { return currentPage === "settings" && currentSettingsPage === "logs"; }
function stopApplicationLog() {
  clearTimeout(applicationLogTimer);
  applicationLogRequest++;
  applicationLogAbort?.abort();
  applicationLogAbort = null;
  if (els.refreshApplicationLogBtn) KDComponents.setBusyState(els.refreshApplicationLogBtn, false);
}
document.addEventListener("visibilitychange", () => {
  stopApplicationLog();
  if (!document.hidden && isApplicationLogPage()) loadApplicationLog();
});
window.addEventListener("pagehide", stopApplicationLog, { once: true });

async function loadApplicationLog(announce = false) {
  if (!isApplicationLogPage() || document.hidden) return;
  clearTimeout(applicationLogTimer);
  const request = ++applicationLogRequest;
  const epoch = routeEpoch;
  applicationLogAbort?.abort();
  applicationLogAbort = new AbortController();
  KDComponents.setBusyState(els.refreshApplicationLogBtn, true);
  try {
    const response = await requestJSON("/system/logs", { signal: AbortSignal.any([applicationLogAbort.signal, AbortSignal.timeout(15_000)]) });
    if (request !== applicationLogRequest || epoch !== routeEpoch || !isApplicationLogPage()) return;
    const content = stringValue(response.content).slice(-(256 * 1024));
    const output = els.applicationLogOutput;
    const follow = document.getElementById("application-log-follow").checked;
    if (output.textContent !== content) output.textContent = content || "当前还没有应用日志。";
    const updated = stringValue(response.updatedAt);
    els.applicationLogStatus.textContent = response.truncated === true
      ? `仅显示最新 256 KiB${updated ? `；更新时间：${formatUpdateTime(updated)}` : ""}。`
      : `显示当前日志${updated ? `；更新时间：${formatUpdateTime(updated)}` : ""}。`;
    els.copyApplicationLogBtn.disabled = !content;
    if (follow) output.scrollTop = output.scrollHeight;
    if (announce) showToast("应用日志已刷新。");
  } catch (error) {
    if (request !== applicationLogRequest || epoch !== routeEpoch || !isApplicationLogPage() || error.name === "AbortError") return;
    els.applicationLogStatus.textContent = `读取应用日志失败：${error.message}`;
    if (announce) showToast(els.applicationLogStatus.textContent, "error");
  } finally {
    if (request === applicationLogRequest) {
      KDComponents.setBusyState(els.refreshApplicationLogBtn, false);
      if (isApplicationLogPage() && !document.hidden) applicationLogTimer = setTimeout(loadApplicationLog, 3000);
    }
  }
}

async function copyApplicationLog() {
	KDComponents.setBusyState(els.copyApplicationLogBtn, true);
	try {
		const content = els.applicationLogOutput.textContent || "";
		if (!content || content === "当前还没有应用日志。") throw new Error("当前没有可复制的日志");
		await writeClipboard(content);
		showToast("应用日志已复制。");
	} catch (error) {
		showToast(`复制应用日志失败：${error.message}`, "error");
	} finally {
		KDComponents.setBusyState(els.copyApplicationLogBtn, false);
	}
}
