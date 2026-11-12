let applicationLogRequest = 0;
let applicationLogAbort = null;
let applicationLogTimer = 0;
let applicationLogContent = "";
let applicationLogCopying = false;

function syncApplicationLogCopyState() {
  els.copyApplicationLogBtn.disabled = applicationLogCopying || !applicationLogContent;
  els.clearApplicationLogBtn.disabled = !els.applicationLogEnabled.checked;
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
    els.applicationLogEnabled.checked = response.enabled === true;
    const content = els.applicationLogEnabled.checked ? stringValue(response.content).slice(-(256 * 1024)) : "";
    const output = els.applicationLogOutput;
    const follow = document.getElementById("application-log-follow").checked;
    if (output.textContent !== content) output.textContent = content || "当前还没有应用日志。";
    const updated = stringValue(response.updatedAt);
    els.applicationLogStatus.textContent = !els.applicationLogEnabled.checked
      ? "应用日志默认关闭；开启后才会保存和展示。"
      : response.truncated === true
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

async function updateApplicationLogEnabled() {
  const enabled = els.applicationLogEnabled.checked;
  try { await requestJSON("/system/logs", { method: "POST", body: JSON.stringify({ enabled }) }); showToast(enabled ? "应用日志已开启。" : "应用日志已关闭。"); applicationLogContent = ""; await loadApplicationLog(); }
  catch (error) { els.applicationLogEnabled.checked = !enabled; showToast(`更新应用日志失败：${error.message}`, "error"); }
}

async function clearApplicationLog() {
  if (!els.applicationLogEnabled.checked) return;
  try { await requestJSON("/system/logs", { method: "POST", body: JSON.stringify({ clear: true }) }); applicationLogContent = ""; await loadApplicationLog(); showToast("应用日志已清理。"); }
  catch (error) { showToast(`清理应用日志失败：${error.message}`, "error"); }
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
