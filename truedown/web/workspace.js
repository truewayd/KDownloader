let currentPage = "tasks";
let currentSettingsPage = "general";
let routeEpoch = 0;
const MODULE_NAV_ORDER_KEY = "truedown-module-navigation-order-v1";
let moduleNavSignature = "", moduleNavRevision = 0;
let moduleNavOrder = [], moduleNavItems = [];
let isModuleNavDragging = () => false;

function initWorkspace() {
  initFileGroups();
  window.addEventListener("hashchange", applyWorkspaceRoute);
  if (nativeWindowRole === "settings") {
    applyWorkspaceRoute(false);
    return;
  }
  initNavigationIndicator();
  if (["main", "browser"].includes(nativeWindowRole)) initModuleNavigation();
  const filter = document.getElementById("task-filter");
  filter?.addEventListener("change", updateTaskNavigation);
  document.querySelectorAll("[data-task-filter]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (currentPage === "tasks") event.preventDefault();
      if (link.dataset.taskFilter === "all") {
        currentCategory = "";
        currentModule = "";
        resetTaskViewport();
        updateTaskNavigation();
        if (currentPage === "tasks") refreshAndSchedule(true);
      }
      if (filter && filter.value !== link.dataset.taskFilter) {
        filter.value = link.dataset.taskFilter;
        filter.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  });
  const compactSidebar = window.matchMedia("(max-width: 720px)");
  let preferredCollapsed = false;
  const setSidebarCollapsed = (collapsed) => {
    document.documentElement.classList.toggle("sidebar-collapsed", collapsed);
    document.querySelectorAll(".sidebar-toggle").forEach((button) => {
      button.setAttribute("aria-expanded", String(!collapsed));
      const label = collapsed ? "展开侧栏" : "收起侧栏";
      button.setAttribute("aria-label", label);
      button.dataset.tooltip = label;
    });
  };
  setSidebarCollapsed(compactSidebar.matches);
  compactSidebar.addEventListener("change", () => setSidebarCollapsed(compactSidebar.matches || preferredCollapsed));
  document.querySelectorAll(".sidebar-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      preferredCollapsed = !document.documentElement.classList.contains("sidebar-collapsed");
      setSidebarCollapsed(preferredCollapsed);
    });
  });
  document.querySelector(".sidebar")?.addEventListener("click", (event) => {
    if (compactSidebar.matches && event.target.closest("a, #new-task-btn")) setSidebarCollapsed(true);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && compactSidebar.matches) setSidebarCollapsed(true);
  });
  applyWorkspaceRoute(false);
}

function initModuleNavigation() {
  const nav = document.getElementById("module-navigation");
  try {
    const order = JSON.parse(localStorage.getItem(MODULE_NAV_ORDER_KEY));
    if (Array.isArray(order)) moduleNavOrder = [...new Set(order.slice(0, 32).filter(id => typeof id === "string" && /^[a-z0-9-]{1,64}$/.test(id)))];
  } catch { /* Use the default module order when storage is unavailable. */ }
  isModuleNavDragging = bindNavigationSorting(nav, {
    key: "taskModule",
    ids: () => [...nav.children].map(link => link.dataset.taskModule),
    revision: () => moduleNavRevision,
    busy: () => false,
    save: ids => {
      // Keep disabled modules in their slots so re-enabling restores their order.
      const active = new Set(ids);
      const reordered = [...ids];
      moduleNavOrder = [...new Set([...moduleNavOrder, ...ids])].map(id => active.has(id) ? reordered.shift() : id);
      try { localStorage.setItem(MODULE_NAV_ORDER_KEY, JSON.stringify(moduleNavOrder)); }
      catch { /* The current window can still use the new order. */ }
      renderModuleNavigation(true);
    },
    render: () => renderModuleNavigation(true),
  });
  nav.addEventListener("click", event => {
    const link = event.target.closest("[data-task-module]");
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (moduleNavItems.some(module => module.id === link.dataset.taskModule)) selectTaskNavigation("", link.dataset.taskModule);
  });
  const refresh = () => {
    if (!document.hidden) Promise.allSettled([loadCollectionLayout(), loadResolverModules()]).then(() => renderModuleNavigation());
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  refresh();
}

function renderModuleNavigation(force = false) {
  if (!["main", "browser"].includes(nativeWindowRole)) return;
  const nav = document.getElementById("module-navigation");
  if (!nav || !settingSnapshotsKnown.has("collection-layout") && !force) return;
  const items = collectionLayout === "module"
    ? resolverModules.filter(module => module.installed) : [];
  const signature = JSON.stringify(items.map(({ id, name }) => [id, name]));
  if (!force && signature === moduleNavSignature) return;
  if (signature !== moduleNavSignature) {
    moduleNavItems = items;
    moduleNavSignature = signature;
    moduleNavRevision++;
  }
  if (isModuleNavDragging()) return;
  const selected = items.find(module => module.id === currentModule);
  const focused = nav.contains(document.activeElement) ? document.activeElement.dataset.taskModule : "";
  const modules = new Map(items.map(module => [module.id, module]));
  const ordered = [...new Set([...moduleNavOrder, ...modules.keys()])];
  const icons = { "google-drive": "google-drive", dropbox: "dropbox", mega: "mega", mediafire: "mediafire", telegraph: "telegraph" };
  nav.replaceChildren(...ordered.filter(id => modules.has(id)).map(id => {
    const { name } = modules.get(id);
    const link = document.createElement("a");
    link.href = "#tasks";
    link.draggable = false;
    link.dataset.taskModule = id;
    link.dataset.tooltip = name;
    link.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    link.innerHTML = iconMarkup(icons[id] || "cloud");
    const label = document.createElement("span");
    label.className = "nav-label";
    label.textContent = name;
    link.append(label);
    return link;
  }));
  document.getElementById("module-navigation-section").hidden = !items.length;
  if (focused) {
    const next = [...nav.children].find(link => link.dataset.taskModule === focused) || document.querySelector('[data-task-filter="all"]');
    next?.focus({ preventScroll: true });
  }
  if (currentModule && !selected) {
    currentModule = "";
    resetTaskViewport();
    if (currentPage === "tasks") refreshAndSchedule(true);
  }
  updateTaskNavigation();
}

function initNavigationIndicator() {
  const nav = document.querySelector(".primary-nav");
  const indicator = document.createElement("span");
  indicator.className = "navigation-indicator";
  indicator.setAttribute("aria-hidden", "true");
  nav.append(indicator);
  nav.classList.add("has-navigation-indicator");
  let frame = 0, initialized = false, followLayout = false;
  const update = () => {
    frame = 0;
    const animate = initialized && !followLayout;
    followLayout = false;
    const selected = nav.querySelector("a[aria-current]");
    if (!selected?.getClientRects().length || selected.closest("details:not([open])")) {
      indicator.hidden = true;
      initialized = false;
      return;
    }
    const bounds = nav.getBoundingClientRect(), target = selected.getBoundingClientRect();
    indicator.style.transition = animate ? "" : "none";
    indicator.style.transform = `translateY(${target.top - bounds.top + nav.scrollTop + (target.height - 18) / 2}px)`;
    indicator.hidden = false;
    // Commit the initial position without animating from the top of the sidebar.
    if (!initialized) indicator.getBoundingClientRect();
    initialized = true;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const mutations = new MutationObserver(schedule);
  mutations.observe(nav, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current", "open", "hidden"] });
  const resize = new ResizeObserver(entries => {
    // Keep the indicator attached to its row while a disclosure moves it.
    followLayout ||= entries.some(entry => entry.target !== nav);
    schedule();
  });
  resize.observe(nav);
  nav.querySelectorAll(".nav-section").forEach(section => resize.observe(section));
  window.addEventListener("resize", schedule);
  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    resize.disconnect();
    window.removeEventListener("resize", schedule);
  }, { once: true });
  schedule();
}

function updateTaskNavigation() {
  const filter = document.getElementById("task-filter")?.value || "all";
  document.querySelectorAll("[data-task-filter]").forEach((link) => {
    if (currentPage === "tasks" && link.dataset.taskFilter === filter && (filter !== "all" || !currentCategory && !currentModule)) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-task-category]").forEach((link) => {
    if (currentPage === "tasks" && link.dataset.taskCategory === currentCategory) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-task-module]").forEach(link => {
    if (currentPage === "tasks" && link.dataset.taskModule === currentModule) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const title = document.getElementById("tasks-title");
  if (title) title.textContent = { all: "全部下载", downloading: "正在下载", queued: "排队中", paused: "已暂停", done: "已完成", error: "下载失败" }[filter] || "下载任务";
  if (title && currentCategory) title.textContent = `${taskCategoryMeta(currentCategory).label} · ${title.textContent}`;
  if (title && currentModule) title.textContent = `${moduleNavItems.find(module => module.id === currentModule)?.name || currentModule} · ${title.textContent}`;
}

function applyWorkspaceRoute(focus = true) {
  let [page, category, tab] = window.location.hash.slice(1).split("/");
  if (page === "logs" || page === "about") { category = page; page = "settings"; }
  currentPage = ["tasks", "task", "settings"].includes(page) ? page : "tasks";
  if (currentPage === "task" && (!/^[1-9]\d*$/.test(category) || !Number.isSafeInteger(Number(category)))) currentPage = "tasks";
  if (currentPage === "task" && typeof nativeWindowRole !== "undefined" && nativeWindowRole === "main") {
    currentPage = "tasks";
    history.replaceState(null, "", "#tasks");
    openTaskDetails(Number(category));
  }
  if (typeof nativeWindowRole !== "undefined" && nativeWindowRole === "settings") currentPage = nativeWindowRole;
  const settingsCategory = Object.hasOwn(SETTINGS_PAGE_ALIASES, category) ? SETTINGS_PAGE_ALIASES[category] : category;
  currentSettingsPage = SETTINGS_PAGES.includes(settingsCategory) ? settingsCategory : "general";
  routeEpoch++;
  stopTaskReads();
  cancelReadRetries();
  stopTaskDetails();
  stopApplicationLog();
  stopSystemUpdateRefresh();
  window.clearTimeout(pollTimer);
  document.querySelectorAll("[data-page]").forEach((element) => {
    element.hidden = element.dataset.page !== currentPage;
  });
  document.querySelectorAll("[data-route]").forEach((link) => {
    if (link.dataset.route === currentPage) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  updateTaskNavigation();
  const titles = { tasks: "下载任务", task: "任务信息", logs: "应用日志", settings: "设置" };
  document.querySelector("title").removeAttribute("data-i18n-ignore");
  document.title = titles[currentPage];
  if (currentPage === "tasks") refreshAndSchedule();
  if (currentPage === "task") showTaskDetails(Number(category), tab);

  document.documentElement.dataset.workspacePage = currentPage;
  if (focus) {
    const heading = document.querySelector(`[data-page="${currentPage}"] h1`);
    heading?.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
  }
  if (currentPage === "settings") loadSettingsPage();
  scheduleSystemUpdateRefresh(true);
}
