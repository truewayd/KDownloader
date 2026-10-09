if (window.__TRUEDOWN_PLATFORM__) {
  document.documentElement.dataset.platform = window.__TRUEDOWN_PLATFORM__;
  const transparency = matchMedia("(prefers-reduced-transparency: reduce)");
  const contrast = matchMedia("(forced-colors: active)");
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");
  let updating = false, dirty = false, disposed = false;
  const updateMaterial = async () => {
    if (disposed) return;
    dirty = true;
    if (transparency.matches || contrast.matches) document.documentElement.dataset.material = "solid";
    if (updating) return;
    updating = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        let applied = false;
        try {
          applied = await window.__TAURI__.core.invoke("apply_material", {
            enabled: !transparency.matches && !contrast.matches,
            dark: colorScheme.matches,
          });
        } catch { /* Keep the working surface opaque when the material is unavailable. */ }
        if (!dirty && !disposed) document.documentElement.dataset.material = applied ? "native" : "solid";
      }
    } finally { updating = false; }
  };
  transparency.addEventListener("change", updateMaterial);
  contrast.addEventListener("change", updateMaterial);
  colorScheme.addEventListener("change", updateMaterial);
  window.addEventListener("focus", updateMaterial);
  window.addEventListener("pagehide", () => {
    disposed = true;
    for (const media of [transparency, contrast, colorScheme]) media.removeEventListener("change", updateMaterial);
    window.removeEventListener("focus", updateMaterial);
  }, { once: true });
  window.__TRUEDOWN_MATERIAL_READY__ = updateMaterial();
  // Hidden WebViews may suspend animation frames. DOM readiness plus the
  // settled native material is the show barrier, independent of focus/paint.
  document.addEventListener("DOMContentLoaded", async () => {
    await window.__TRUEDOWN_MATERIAL_READY__;
    if (disposed || !["/", "/index.html", "/task-preview.html"].includes(location.pathname)) return;
    try { await window.__TAURI__.core.invoke("surface_ready"); }
    catch (error) { console.error("surface_ready", error); }
  }, { once: true });
}
