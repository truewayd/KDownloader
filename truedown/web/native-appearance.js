if (window.__TRUEDOWN_PLATFORM__) {
  document.documentElement.dataset.platform = window.__TRUEDOWN_PLATFORM__;
  const transparency = matchMedia("(prefers-reduced-transparency: reduce)");
  const contrast = matchMedia("(forced-colors: active)");
  const updateMaterial = async () => {
    try {
      const enabled = await window.__TAURI__.core.invoke("apply_material", { enabled: !transparency.matches && !contrast.matches });
      document.documentElement.dataset.material = enabled ? "native" : "solid";
    } catch { document.documentElement.dataset.material = "solid"; }
  };
  transparency.addEventListener("change", updateMaterial);
  contrast.addEventListener("change", updateMaterial);
  updateMaterial();
}
