// Keep native form values, labels and validation; replace only the option picker.
(() => {
  let current = null;
  let sequence = 0;
  const selectFor = (target) => target instanceof HTMLSelectElement && target.matches(".kd-select") && !target.multiple && target.size <= 1 ? target : null;
  const enabled = (option) => Boolean(option) && !option.disabled && !option.closest("optgroup[disabled]") && !option.hidden && !option.closest("optgroup[hidden]");

  function close() {
    if (!current) return;
    const { select, list, observer } = current;
    current = null;
    observer.disconnect();
    select.setAttribute("aria-expanded", "false");
    select.removeAttribute("aria-controls");
    select.removeAttribute("aria-activedescendant");
    list.remove();
  }

  function activate(index) {
    if (!current || !enabled(current.select.options[index])) return;
    current.active = index;
    for (const item of current.list.children) item.dataset.active = String(Number(item.dataset.index) === index);
    const item = current.list.querySelector(`[data-index="${index}"]`);
    current.select.setAttribute("aria-activedescendant", item.id);
    item.scrollIntoView({ block: "nearest" });
  }

  function commit(index) {
    if (!current) return;
    const { select } = current;
    const option = select.options[index];
    if (select.matches(":disabled") || !option || !enabled(option)) { close(); return; }
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    close();
    select.focus({ preventScroll: true });
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function open(select) {
    close();
    if (select.matches(":disabled")) return;
    const list = document.createElement("div");
    list.className = "kd-select-list";
    list.id = `kd-select-list-${++sequence}`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", select.getAttribute("aria-label") || Array.from(select.labels || [], label => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll("select").forEach(node => node.remove());
      return copy.textContent.trim();
    }).join(" "));
    if (typeof list.showPopover === "function") list.setAttribute("popover", "manual");
    for (const [index, option] of Array.from(select.options).entries()) {
      if (option.hidden || option.closest("optgroup[hidden]")) continue;
      const item = document.createElement("div");
      item.className = "kd-select-option";
      item.id = `${list.id}-${index}`;
      item.dataset.index = index;
      item.setAttribute("role", "option");
      item.setAttribute("aria-label", option.label);
      item.setAttribute("aria-selected", String(option.selected));
      item.setAttribute("aria-disabled", String(!enabled(option)));
      const label = document.createElement("span");
      label.textContent = option.label;
      const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      check.classList.add("icon");
      check.setAttribute("aria-hidden", "true");
      check.setAttribute("focusable", "false");
      const use = document.createElementNS(check.namespaceURI, "use");
      use.setAttribute("href", "/icons.svg#icon-check");
      check.append(use);
      item.append(label, check);
      list.append(item);
    }
    if (!list.childElementCount) return;
    const observer = new MutationObserver(close);
    observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "hidden", "selected", "label"] });
    current = { select, list, observer, active: -1, query: "", queryAt: 0 };
    select.setAttribute("aria-expanded", "true");
    select.setAttribute("aria-controls", list.id);
    document.body.append(list);
    list.showPopover?.();
    const rect = select.getBoundingClientRect();
    const margin = 8, gap = 4;
    const below = window.innerHeight - rect.bottom - margin - gap;
    const above = rect.top - margin - gap;
    list.style.maxWidth = `${window.innerWidth - margin * 2}px`;
    list.style.minWidth = `${Math.min(rect.width, window.innerWidth - margin * 2)}px`;
    const upwards = below < Math.min(list.scrollHeight + 2, 280) && above > below;
    list.style.maxHeight = `${Math.max(36, Math.min(280, upwards ? above : below))}px`;
    const box = list.getBoundingClientRect();
    list.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - box.width - margin))}px`;
    list.style.top = `${Math.max(margin, upwards ? rect.top - gap - box.height : rect.bottom + gap)}px`;
    const initial = enabled(select.options[select.selectedIndex]) ? select.selectedIndex : Array.from(select.options).findIndex(enabled);
    if (initial >= 0) activate(initial);
    list.addEventListener("pointerdown", (event) => event.preventDefault());
    list.addEventListener("pointermove", (event) => {
      const item = event.target.closest("[data-index]");
      if (item && enabled(select.options[item.dataset.index])) {
        current.active = Number(item.dataset.index);
        for (const row of list.children) row.dataset.active = String(row === item);
        select.setAttribute("aria-activedescendant", item.id);
      }
    });
    list.addEventListener("click", (event) => {
      const item = event.target.closest("[data-index]");
      if (item && enabled(select.options[item.dataset.index])) commit(Number(item.dataset.index));
    });
  }

  document.addEventListener("pointerdown", (event) => {
    const select = selectFor(event.target);
    if (select && event.button === 0 && !select.matches(":disabled")) {
      event.preventDefault();
      select.focus({ preventScroll: true });
      if (current?.select === select) close();
      else open(select);
    } else if (current && !current.list.contains(event.target)) close();
  });
  document.addEventListener("click", (event) => {
    const select = selectFor(event.target);
    if (!select) return;
    event.preventDefault();
    // Assistive technology may activate a control without pointer events.
    if (event.detail === 0) current?.select === select ? close() : open(select);
  });
  document.addEventListener("keydown", (event) => {
    const select = selectFor(event.target);
    if (!select || select.matches(":disabled") || event.ctrlKey || event.metaKey) return;
    if (event.key === "Tab") { close(); return; }
    if (event.key === "Escape") {
      if (current) { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      return;
    }
    const character = event.key.length === 1 && event.key !== " " && !event.altKey;
    if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", "Enter", "F4", " "].includes(event.key) && !character) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (current?.select !== select) {
      open(select);
      if (!character && !["Home", "End"].includes(event.key)) return;
    } else if (["Enter", "F4", " "].includes(event.key) || (event.altKey && event.key === "ArrowUp")) {
      commit(current.active);
      return;
    }
    if (!current) return;
    const indices = Array.from(select.options).flatMap((option, index) => enabled(option) ? [index] : []);
    if (!indices.length) return;
    if (character) {
      const now = Date.now();
      current.query = now - current.queryAt < 700 ? current.query + event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase();
      current.queryAt = now;
      const match = indices.find(index => select.options[index].label.toLocaleLowerCase().startsWith(current.query));
      if (match !== undefined) activate(match);
    } else {
      const position = indices.indexOf(current.active);
      const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[event.key] || 0;
      const next = event.key === "Home" ? 0 : event.key === "End" ? indices.length - 1 : Math.max(0, Math.min(indices.length - 1, position + step));
      activate(indices[next]);
    }
  }, true);
  document.addEventListener("focusin", (event) => { if (current && event.target !== current.select) close(); });
  document.addEventListener("scroll", (event) => { if (current && !current.list.contains(event.target)) close(); }, true);
  document.addEventListener("visibilitychange", close);
  document.addEventListener("change", (event) => { if (current?.select === event.target) close(); });
  document.addEventListener("reset", close);
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
  window.addEventListener("hashchange", close);
  window.addEventListener("pagehide", close);
})();
