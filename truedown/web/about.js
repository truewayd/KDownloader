const aboutInvoke = (command, args) => window.__TAURI__.core.invoke(command, args);
async function loadAbout() {
  const read = async (path) => {
    const response = await aboutInvoke("core_request", { request: { method: "GET", path } });
    if (response.status !== 200) throw new Error("无法读取服务状态");
    return JSON.parse(response.body);
  };
  try {
    const [info, update, state] = await Promise.all([read("/system/info"), read("/system/update"), aboutInvoke("desktop_state")]);
    document.getElementById("version").textContent = `${info.version} · build ${info.buildNumber} · ${info.commit}`;
    document.getElementById("engine").textContent = update.engine?.active === "next" ? `Aria2 Next ${update.engine.activeVersion || ""}` : "aria2 稳定版";
    document.getElementById("connection").textContent = state.owned ? "由桌面管理的本地内核" : "已连接独立运行的本地服务";
  } catch (error) { document.getElementById("about-status").textContent = `读取失败：${error.message || error}`; }
}
const closeAbout = () => aboutInvoke("close_auxiliary").catch((error) => { document.getElementById("about-status").textContent = String(error); });
document.getElementById("close-about").addEventListener("click", closeAbout);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w")) {event.preventDefault(); closeAbout();}
});
loadAbout();
