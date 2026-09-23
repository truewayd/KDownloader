// Index authored labels before settings reads can insert private profile values.
document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("settings-search");
  const clear = document.getElementById("settings-search-clear");
  const results = document.getElementById("settings-search-results");
  const navigation = document.querySelector(".settings-navigation-links");
  const status = document.getElementById("settings-search-status");
  const entries = [], targets = new Set();
  for (const label of document.querySelectorAll('.settings-section label[for], .settings-section legend, .settings-section-heading, .update-card-heading, #file-groups-title, #settings-about-title')) {
    const panel = label.closest("[data-settings-page]");
    const target = label.matches("legend") ? label.closest("fieldset") : label.closest(".setting-toggle, .field, .settings-section-heading") || label;
    if (!panel || targets.has(target)) continue;
    const copy = label.cloneNode(true);
    copy.querySelectorAll("input, select, textarea, button").forEach(node => node.remove());
    const title = copy.textContent.replace(/\s+/g, " ").trim();
    if (!title) continue;
    targets.add(target);
    const page = panel.dataset.settingsPage;
    const category = document.querySelector(`[data-settings-link="${page}"] span`).textContent;
    entries.push({ target, page, category, title, text: `${category} ${title} ${target.querySelector(".hint")?.textContent || ""}`.toLocaleLowerCase() });
  }
  let highlighted, highlightTimer, selection = 0;
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
        highlighted.tabIndex = -1;
        highlighted.focus({ preventScroll: true });
        highlightTimer = setTimeout(clearHighlight, 3500);
      });
      results.append(button);
    }
  }
  input.addEventListener("input", search);
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.value = ""; search(); }
    if (event.key === "ArrowDown") { event.preventDefault(); results.querySelector("button")?.focus(); }
    if (event.key === "Enter") { event.preventDefault(); results.querySelector("button")?.click(); }
  });
  clear.addEventListener("click", () => { input.value = ""; search(); input.focus(); });
  results.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.value = ""; search(); input.focus(); }
  });
  window.addEventListener("pagehide", clearHighlight, { once: true });
});
