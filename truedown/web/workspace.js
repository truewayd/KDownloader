let currentPage = "tasks";
let currentSettingsPage = "overview";
let routeEpoch = 0;

function initWorkspace() {
  window.addEventListener("hashchange", applyWorkspaceRoute);
  applyWorkspaceRoute(false);
}

function applyWorkspaceRoute(focus = true) {
  const [page, category] = window.location.hash.slice(1).split("/");
  currentPage = ["tasks", "logs", "settings"].includes(page) ? page : "tasks";
  currentSettingsPage = SETTINGS_PAGES.includes(category) ? category : "overview";
  routeEpoch++;
  applicationLogAbort?.abort();
  window.clearTimeout(pollTimer);
  document.querySelectorAll("[data-page]").forEach((element) => {
    element.hidden = element.dataset.page !== currentPage;
  });
  document.querySelectorAll("[data-route]").forEach((link) => {
    if (link.dataset.route === currentPage) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const titles = { tasks: "下载任务", logs: "应用日志", settings: "设置" };
  document.title = `${titles[currentPage]} · TrueDown`;
  if (currentPage === "tasks") refreshAndSchedule();
  if (currentPage === "logs") loadApplicationLog();
  if (currentPage === "settings") loadSettingsPage();
  if (focus) {
    const heading = document.querySelector(`[data-page="${currentPage}"] h1`);
    heading?.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
  }
}
