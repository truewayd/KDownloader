let applicationLogRequest = 0;
let applicationLogAbort = null;
let applicationLogTimer = 0;
let applicationLogContent = "";
let applicationLogCopying = false;

function syncApplicationLogCopyState() {
  els.copyApplicationLogBtn.disabled = applicationLogCopying || !applicationLogContent;
  KDComponents.setBusyState(els.copyApplicationLogBtn, applicationLogCopying, { manageDisabled: false });
}

function isApplicationLogPage() { return currentPage === "settings" && currentSettingsPage === "logs"; }
function stopApplicationLog() {
  clearTimeout(applicationLogTimer);
  applicationLogRequest++;
  applicationLogAbort?.abort();
  applicationLogAbort = null;
}
document.addEventListener("visibilitychange", () => {
  stopApplicationLog();
  if (!document.hidden && isApplicationLogPage()) loadApplicationLog();
});
window.addEventListener("pagehide", stopApplicationLog, { once: true });

async function loadApplicationLog() {
  if (!isApplicationLogPage() || document.hidden) return;
  clearTimeout(applicationLogTimer);
  const request = ++applicationLogRequest;
  const epoch = routeEpoch;
  applicationLogAbort?.abort();
  applicationLogAbort = new AbortController();
  try {
    const response = await requestJSON("/system/logs", { signal: applicationLogAbort.signal });
    if (request !== applicationLogRequest || epoch !== routeEpoch || !isApplicationLogPage()) return;
    const content = stringValue(response.content).slice(-(256 * 1024));
    const output = els.applicationLogOutput;
    const follow = document.getElementById("application-log-follow").checked;
    if (output.textContent !== content) output.textContent = content || "当前还没有应用日志。";
    const updated = stringValue(response.updatedAt);
    els.applicationLogStatus.textContent = response.truncated === true
      ? `仅显示最新 256 KiB${updated ? `；更新时间：${formatUpdateTime(updated)}` : ""}。`
      : `显示当前日志${updated ? `；更新时间：${formatUpdateTime(updated)}` : ""}。`;
    applicationLogContent = content;
    syncApplicationLogCopyState();
    if (follow) output.scrollTop = output.scrollHeight;
  } catch (error) {
    if (request !== applicationLogRequest || epoch !== routeEpoch || !isApplicationLogPage() || error.name === "AbortError") return;
    els.applicationLogStatus.textContent = `读取应用日志失败，正在自动重试：${error.message}`;
  } finally {
    if (request === applicationLogRequest) {
      if (isApplicationLogPage() && !document.hidden) applicationLogTimer = setTimeout(loadApplicationLog, 3000);
    }
  }
}

async function copyApplicationLog() {
	if (applicationLogCopying || !applicationLogContent) return;
	applicationLogCopying = true;
	syncApplicationLogCopyState();
	try {
		const content = applicationLogContent;
		await writeClipboard(content);
		showToast("应用日志已复制。");
	} catch (error) {
		showToast(`复制应用日志失败：${error.message}`, "error");
	} finally {
		applicationLogCopying = false;
		syncApplicationLogCopyState();
	}
}
