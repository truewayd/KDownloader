// Controls select native engine behavior; no manifest or segment work runs here.
let mediaCapabilities = { media: false, probe: false };
let mediaCapabilityRequest = 0;
async function refreshMediaCapabilities() {
  const revision = ++mediaCapabilityRequest;
  let capabilities = {};
  try { capabilities = await requestJSON("/engine/capabilities"); } catch { /* Backend validates every admission too. */ }
  if (revision !== mediaCapabilityRequest) return;
  mediaCapabilities = capabilities;
  if (typeof updateProbeAvailability === "function") updateProbeAvailability();
  const control = document.getElementById("m-media");
  if (!control) return;
  for (const option of control.options) if (option.value) option.disabled = capabilities.media !== true;
  document.getElementById("media-capability-status").textContent = capabilities.media
    ? "自动选择最佳音视频轨道；文件名作为标题，扩展名随封装格式确定。"
    : "当前引擎不支持媒体下载，请在设置中启用 NEXT 3。";
}

function selectedMediaOptions() {
  const protocol = document.getElementById("m-media")?.value;
  if (!protocol) return null;
  if (!mediaCapabilities.media) throw new Error("当前引擎不支持 HLS/DASH 下载");
  const recordTime = Number(document.getElementById("m-media-time").value);
  if (!Number.isSafeInteger(recordTime) || recordTime < 0 || recordTime > 604800) throw new Error("录制上限必须为 0–604800 秒");
  return { protocol, format: document.getElementById("m-media-format").value, recordTime };
}

document.getElementById("m-media")?.addEventListener("change", (event) => {
  document.getElementById("media-options").hidden = !event.target.value;
});
