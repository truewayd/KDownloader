(() => {
  "use strict";

  const key = "truedown-layout-density-v1";
  const root = document.documentElement;
  const normalize = value => value === "compact" ? value : "comfortable";
  const apply = value => {
    const density = normalize(value);
    if (root.dataset.layoutDensity !== density) {
      root.dataset.layoutDensity = density;
      window.dispatchEvent(new Event("truedown:layout-density-changed"));
    }
    const select = document.getElementById("layout-density");
    if (select) select.value = density;
  };
  const restore = () => {
    try { apply(localStorage.getItem(key)); }
    catch { apply("comfortable"); }
  };

  restore();
  window.addEventListener("pageshow", event => { if (event.persisted) restore(); });
  window.addEventListener("storage", event => {
    if (event.storageArea === localStorage && (event.key === key || event.key === null)) apply(event.newValue);
  });
  document.addEventListener("DOMContentLoaded", () => {
    const select = document.getElementById("layout-density");
    if (!select) return;
    select.value = root.dataset.layoutDensity;
    select.addEventListener("change", () => {
      const density = normalize(select.value);
      try { localStorage.setItem(key, density); } catch { /* Apply in this window if storage is unavailable. */ }
      apply(density);
    });
  });
})();
