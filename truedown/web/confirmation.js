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
      status.textContent = String(error); status.hidden = false;
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
  (async () => {
    const options = await invoke("confirmation_init");
    document.title = options.title;
    document.getElementById("title").textContent = options.title;
    document.getElementById("message").textContent = options.message;
    document.querySelector(".confirmation").dataset.kind = options.kind;
    document.getElementById("kind-icon").setAttribute("href", `/icons.svg#icon-${options.kind === "info" ? "info" : "circle-alert"}`);
    cancel.textContent = options.cancelLabel; confirm.textContent = options.confirmLabel;
    confirm.className = `kd-button ${options.kind === "info" ? "primary" : "danger"}`;
    (options.kind === "info" ? confirm : cancel).focus();
    await invoke("confirmation_ready");
  })().catch(error => { document.getElementById("message").textContent = String(error); });
})();
