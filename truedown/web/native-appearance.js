if (window.__TRUEDOWN_PLATFORM__) {
  document.documentElement.dataset.platform = window.__TRUEDOWN_PLATFORM__;
  const transparency = matchMedia("(prefers-reduced-transparency: reduce)");
  const contrast = matchMedia("(forced-colors: active)");
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");
  let updating = false, dirty = false;
  const updateMaterial = async () => {
    dirty = true;
    if (transparency.matches || contrast.matches) document.documentElement.dataset.material = "solid";
    if (updating) return;
    updating = true;
    try {
      while (dirty) {
        dirty = false;
        let applied = false;
        try {
          applied = await window.__TAURI__.core.invoke("apply_material", {
            enabled: !transparency.matches && !contrast.matches,
            dark: colorScheme.matches,
          });
        } catch { /* Keep the working surface opaque when the material is unavailable. */ }
        if (!dirty) document.documentElement.dataset.material = applied ? "native" : "solid";
      }
    } finally { updating = false; }
  };
  transparency.addEventListener("change", updateMaterial);
  contrast.addEventListener("change", updateMaterial);
  colorScheme.addEventListener("change", updateMaterial);
  window.addEventListener("focus", updateMaterial);
  updateMaterial();
}
