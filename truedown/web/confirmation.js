(() => {
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  const cancel = document.getElementById("cancel"), confirm = document.getElementById("confirm");
  let busy = false;
  async function answer(accepted) {
    if (busy) return;
    busy = true;
    cancel.disabled = confirm.disabled = true;
    try { await invoke("confirmation_answer", { accepted }); }
    catch (error) {
      const status = document.getElementById("error");
      console.error("confirmation_answer", error);
      status.textContent = "无法提交操作，请关闭窗口后重试。"; status.hidden = false;
      busy = false; cancel.disabled = confirm.disabled = false;
    }
  }
  cancel.addEventListener("click", () => answer(false));
  confirm.addEventListener("click", () => answer(true));
  document.addEventListener("contextmenu", event => event.preventDefault());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); answer(false); }
    if (event.key === "Tab") {
      event.preventDefault(); (document.activeElement === cancel ? confirm : cancel).focus();
    }
  });
  let initializing = false, initialized = false, refreshQueued = false;
  window.refreshConfirmation = async () => {
    if (initialized) return;
    if (initializing) { refreshQueued = true; return; }
    initializing = true;
    try {
    const options = await invoke("confirmation_init");
    if (!options) return;
    document.title = options.title;
    document.getElementById("title").textContent = options.title;
    document.getElementById("message").textContent = options.message;
    document.querySelector(".confirmation").dataset.kind = options.kind;
    document.querySelector(".confirmation-content .icon").toggleAttribute("hidden", options.kind === "info" || window.__TRUEDOWN_PLATFORM__ === "linux");
    document.getElementById("kind-icon").setAttribute("href", `/icons.svg#icon-${options.kind === "info" ? "info" : "circle-alert"}`);
    cancel.textContent = options.cancelLabel; confirm.textContent = options.confirmLabel;
    confirm.className = `kd-button ${options.kind === "info" ? "primary" : "danger"}`;
    (options.kind === "info" ? confirm : cancel).focus();
    const content = document.getElementById("message");
    const height = Math.max(144, Math.min(420, Math.ceil(content.scrollHeight + 40 + 16 + document.querySelector("footer").offsetHeight)));
    await invoke("confirmation_ready", { height });
    initialized = true; window.__popupActive = true;
    } catch (error) { console.error("confirmation_init", error); document.getElementById("message").textContent = "无法打开确认窗口，请关闭后重试。"; }
    finally { initializing = false; if (refreshQueued) { refreshQueued = false; window.refreshConfirmation(); } }
  };
  window.__popupLoaded = true;
  window.refreshConfirmation();
})();
