let currentPage = "tasks";
let currentSettingsPage = "overview";
let routeEpoch = 0;

function initWorkspace() {
  window.addEventListener("hashchange", applyWorkspaceRoute);
  const filter = document.getElementById("task-filter");
  filter?.addEventListener("change", updateTaskNavigation);
  document.querySelectorAll("[data-task-filter]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (currentPage === "tasks") event.preventDefault();
      if (filter && filter.value !== link.dataset.taskFilter) {
        filter.value = link.dataset.taskFilter;
        filter.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  });
  document.querySelectorAll(".sidebar-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const collapsed = document.documentElement.classList.toggle("sidebar-collapsed");
      button.setAttribute("aria-expanded", String(!collapsed));
      const label = collapsed ? "展开侧栏" : "收起侧栏";
      button.setAttribute("aria-label", label);
      button.title = label;
    });
  });
  applyWorkspaceRoute(false);
}

function updateTaskNavigation() {
  const filter = document.getElementById("task-filter")?.value || "all";
  document.querySelectorAll("[data-task-filter]").forEach((link) => {
    if (currentPage === "tasks" && link.dataset.taskFilter === filter) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const title = document.getElementById("tasks-title");
  if (title) title.textContent = { all: "全部下载", downloading: "正在下载", queued: "排队中", paused: "已暂停", done: "已完成", error: "下载失败" }[filter] || "下载任务";
}

function applyWorkspaceRoute(focus = true) {
  const [page, category] = window.location.hash.slice(1).split("/");
  currentPage = ["tasks", "logs", "settings"].includes(page) ? page : "tasks";
  if (typeof nativeWindowRole !== "undefined" && ["settings", "logs"].includes(nativeWindowRole)) currentPage = nativeWindowRole;
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
  updateTaskNavigation();
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
