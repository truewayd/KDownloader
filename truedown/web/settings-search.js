// This deferred script captures authored text before localization or profile reads.
(() => {
  if (!["browser", "settings"].includes(nativeWindowRole)) return;
  const input = document.getElementById("settings-search");
  const clear = document.getElementById("settings-search-clear");
  const results = document.getElementById("settings-search-results");
  const navigation = document.querySelector(".settings-navigation-links");
  const status = document.getElementById("settings-search-status");
  const entries = [], targets = new Set();
  for (const label of document.querySelectorAll('.settings-section label[for], .settings-section .log-follow, .settings-section .field-label, .settings-section legend, .settings-section-heading, .update-card-heading, #file-groups-title, #settings-about-title')) {
    const panel = label.closest("[data-settings-page]");
    const target = label.matches("legend") ? label.closest("fieldset") : label.closest(".setting-toggle, .field, .settings-section-heading") || label;
    if (!panel || targets.has(target)) continue;
    const copy = (label.matches(".update-card-heading") ? label.querySelector("strong") || label : label).cloneNode(true);
    copy.querySelectorAll("input, select, textarea, button, .hint, p").forEach(node => node.remove());
    const title = copy.textContent.replace(/\s+/g, " ").trim();
    if (!title) continue;
    targets.add(target);
    const page = panel.dataset.settingsPage;
    const category = document.querySelector(`[data-settings-link="${page}"] span`).textContent;
    const help = [...target.querySelectorAll(".hint, p, small")];
    for (const control of target.querySelectorAll("[aria-describedby]")) {
      for (const id of control.getAttribute("aria-describedby").split(/\s+/)) {
        const description = document.getElementById(id);
        if (description && !help.includes(description)) help.push(description);
      }
    }
    if (target.matches(".settings-section-heading")) help.push(...panel.querySelectorAll(":scope > .hint, :scope > p"));
    const authoredHelp = help.filter(node => !node.closest('[role="status"], [aria-live]')).map(node => node.textContent);
    entries.push({ target, control: label.control, page, category, title, terms: [category, title, ...authoredHelp] });
  }
  let highlighted, highlightTimer, selection = 0;
  function indexLanguage() {
    for (const entry of entries) {
      entry.text = entry.terms.map(term => TrueDownI18n.t(term, true)).join(" ").toLocaleLowerCase();
    }
    if (input.value) search();
  }
  indexLanguage();
  window.addEventListener("truedown:language-changed", indexLanguage);
  function clearHighlight() {
    clearTimeout(highlightTimer);
    highlighted?.classList.remove("settings-search-highlight");
    highlighted = null;
  }
  function search() {
    selection++;
    const words = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const active = words.length > 0;
    document.documentElement.dataset.settingsSearch = String(active);
    navigation.hidden = active;
    results.hidden = !active;
    clear.hidden = !input.value;
    results.replaceChildren();
    if (!active) { status.textContent = ""; return; }
    const matches = entries.filter(entry => words.every(word => entry.text.includes(word)));
    status.textContent = matches.length ? `找到 ${matches.length} 项设置` : "没有匹配的设置";
    if (!matches.length) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "没有匹配的设置"; results.append(empty); }
    for (const entry of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "settings-search-result";
      const category = document.createElement("small"), title = document.createElement("span");
      category.textContent = entry.category;
      title.textContent = entry.title;
      button.append(category, title);
      button.addEventListener("click", async () => {
        input.value = ""; search(); clearHighlight();
        const version = selection;
        history.pushState(null, "", `#settings/${entry.page}`);
        applyWorkspaceRoute(false);
        const epoch = routeEpoch;
        await loadSettingsPage();
        if (version !== selection || epoch !== routeEpoch || !entry.target.isConnected) return;
        // Conditional controls may be hidden (for example, a custom proxy
        // address). Highlight their visible group without changing preferences.
        let target = entry.target;
        while (target && !target.checkVisibility()) target = target.parentElement;
        if (!target?.closest(`[data-settings-page="${entry.page}"]`)) return;
        highlighted = target;
        highlighted.classList.add("settings-search-highlight");
        highlighted.scrollIntoView({ block: "center" });
        const control = entry.control;
        if (control?.checkVisibility() && !control.matches(":disabled") && !control.closest("[inert]")) {
          control.focus({ preventScroll: true });
        } else {
          highlighted.tabIndex = -1;
          highlighted.focus({ preventScroll: true });
        }
        highlightTimer = setTimeout(clearHighlight, 3500);
      });
      results.append(button);
    }
  }
  input.addEventListener("input", search);
  input.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.value = ""; search(); }
    if (event.key === "ArrowDown") { event.preventDefault(); results.querySelector("button")?.focus(); }
    if (event.key === "Enter") { event.preventDefault(); results.querySelector("button")?.click(); }
  });
  clear.addEventListener("click", () => { input.value = ""; search(); input.focus(); });
  results.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.value = ""; search(); input.focus(); }
    const button = event.target.closest("button");
    if (!button || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = { ArrowUp: button.previousElementSibling || input, ArrowDown: button.nextElementSibling || button,
      Home: results.firstElementChild, End: results.lastElementChild }[event.key];
    next.focus();
  });
  window.addEventListener("pagehide", clearHighlight, { once: true });
})();
