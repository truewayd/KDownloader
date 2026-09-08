// File contents stay with the existing bounded task submission. The shell only
// returns directories explicitly selected in an OS-owned picker.
function updateTorrentSelection() {
  const input = document.getElementById("m-torrent-file");
  const name = document.getElementById("torrent-file-name");
  const clear = document.getElementById("clear-torrent-btn");
  const choose = document.getElementById("choose-torrent-btn");
  if (!input || !name || !clear || !choose) return;
  const file = input.files?.[0];
  name.textContent = file?.name || "未选择文件";
  name.title = file?.name || "";
  clear.hidden = !file;
  choose.disabled = input.disabled;
}

async function chooseDownloadDirectory(button) {
  if (button.getAttribute("aria-busy") === "true") return;
  const input = document.getElementById(button.dataset.directoryInput);
  if (!input || input.disabled) return;
  const previous = input.value;
  KDComponents.setBusyState(button, true);
  try {
    const selected = await invokeNative("choose_download_directory");
    // A late native dialog result must not erase text edited while it was open.
    if (typeof selected === "string" && input.value === previous && !input.disabled && !input.closest("[inert]")) {
      input.value = selected;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } catch (error) {
    showToast(`无法选择目录：${error.message}`, "error");
  } finally {
    KDComponents.setBusyState(button, false);
    if (button.isConnected && button.checkVisibility() && !button.closest("[inert]") &&
        (document.activeElement === document.body || document.activeElement === button)) {
      button.focus({ preventScroll: true });
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("m-torrent-file");
  document.getElementById("choose-torrent-btn")?.addEventListener("click", () => { if (!input.disabled) input.click(); });
  document.getElementById("clear-torrent-btn")?.addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("choose-torrent-btn").focus();
  });
  input?.addEventListener("change", updateTorrentSelection);
  document.querySelectorAll("[data-directory-input]").forEach((button) => {
    button.addEventListener("click", () => chooseDownloadDirectory(button));
  });
  updateTorrentSelection();
});
