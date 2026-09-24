// Warm only likely interactions; each warm native window is consumed once.
(() => {
  if (!window.__TAURI__?.core?.invoke) return;
  const pending = new Set();
  function prepare(kind) {
    if (pending.has(kind)) return;
    pending.add(kind);
    invokeNative("prepare_popup", { kind }).catch(() => {}).finally(() => pending.delete(kind));
  }
  document.addEventListener("pointerdown", event => {
    if (event.button === 2 && !event.target.closest("[data-native-drag]")) prepare("menu");
  }, { passive: true });
  document.addEventListener("pointerover", event => {
    const target = event.target.closest('#settings-reset-btn, [data-action="remove"], .kd-button.danger');
    if (target && !target.contains(event.relatedTarget)) prepare("confirmation");
  }, { passive: true });
})();
