// File contents stay with the existing bounded task submission.
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

let readingNativeDrop = false;
let nativeDropRequested = false;
let dropDisposed = false;
let applyingDrop = false;

function parseDroppedLinks(text) {
  if (typeof text !== "string" || text.length > 65536) throw new Error("拖入的链接内容过长");
  return parseLinks(text.split(/\r?\n/).filter((line) => !line.trim().startsWith("#")).join("\n"));
}

function validateDroppedTorrent(file) {
  if (!file || !/\.torrent$/i.test(file.name) || file.size <= 0 || file.size > 4 * 1024 * 1024) {
    throw new Error("请拖入一个不超过 4 MiB 的 .torrent 文件");
  }
}

async function applyDroppedSource({ file = null, links = [] }) {
  if (dropDisposed) return;
  if (applyingDrop || els.downloadForm.inert) throw new Error("请等待当前表单操作完成后再拖入");
  applyingDrop = true;
  try {
    const originalLink = els.mLink.value;
    let originalFile = els.mTorrentFile.files?.[0];
    if (file) validateDroppedTorrent(file);
    if (nativeWindowRole === "main" || nativeWindowRole === "batch-task") {
      if (file) throw new Error("请通过桌面窗口拖入 .torrent 文件");
      await invokeNative("drop_download_links", { links: links.join("\n") });
      return;
    }
    if (els.mLink.value.trim() || els.mTorrentFile.files?.length) {
      const accepted = await confirmAction({
        title: "替换下载来源", message: "当前表单已有下载来源，是否替换为拖入的内容？其他下载选项会保留。",
        confirmLabel: "替换", cancelLabel: "取消",
      });
      if (!accepted || dropDisposed) return;
    }
    if (nativeWindowRole === "browser" && !els.overlay.classList.contains("open")) {
      await openModal(file || links.length <= 1 ? "single" : "batch");
      if (!els.overlay.classList.contains("open") || dropDisposed) return;
      originalFile = undefined;
    }
    if (els.downloadForm.inert || els.mLink.value !== originalLink || els.mTorrentFile.files?.[0] !== originalFile) {
      throw new Error("表单内容已变更，请重新拖入");
    }
    if (file && modalMode === "batch") configureTaskForm("single");
    els.mTorrentFile.value = "";
    if (file) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      els.mTorrentFile.files = transfer.files;
    }
    els.mLink.value = links.join("\n");
    updateTorrentSelection();
    showModalMsg(file ? "已导入种子，请确认下载目录后开始下载" : "已填入链接，请确认下载选项后开始下载");
    (file ? els.mFolder : els.mLink).focus();
  } finally {
    applyingDrop = false;
  }
}

async function drainNativeDrop() {
  nativeDropRequested = true;
  if (nativeWindowRole !== "new-task" || !nativeTaskFormReady || els.downloadForm.inert || readingNativeDrop || dropDisposed) return;
  readingNativeDrop = true;
  try {
    while (nativeDropRequested && !dropDisposed && !els.downloadForm.inert) {
      nativeDropRequested = false;
      const source = await invokeNative("take_dropped_torrent");
      if (!source || dropDisposed) continue;
      if (source.links) {
        await applyDroppedSource({ links: parseDroppedLinks(source.links) });
      } else {
        const bytes = Uint8Array.from(atob(source.base64), (value) => value.charCodeAt(0));
        await applyDroppedSource({ file: new File([bytes], source.name, { type: "application/x-bittorrent" }) });
      }
    }
  } catch (error) {
    if (!dropDisposed) showToast(`无法导入拖入内容：${error.message}`, "error");
  } finally {
    readingNativeDrop = false;
  }
}

function bindDownloadDrops() {
  if (nativeWindowRole === "settings") return;
  const error = (cause) => { if (!dropDisposed) showToast(cause.message || String(cause), "error"); };
  const over = (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const drop = (event) => {
    event.preventDefault();
    const transfer = event.dataTransfer;
    if (!transfer) return;
    try {
      if (transfer.files.length) {
        if (transfer.files.length !== 1) throw new Error("一次只能拖入一个 .torrent 文件");
        const file = transfer.files[0];
        validateDroppedTorrent(file);
        applyDroppedSource({ file }).catch(error);
      } else {
        const links = parseDroppedLinks(transfer.getData("text/uri-list") || transfer.getData("text/plain"));
        if (!links.length) throw new Error("请拖入 .torrent 文件、HTTP(S) 或 Magnet 链接");
        applyDroppedSource({ links }).catch(error);
      }
    } catch (cause) { error(cause); }
  };
  document.addEventListener("dragover", over);
  document.addEventListener("drop", drop);
  window.addEventListener("pagehide", () => {
    dropDisposed = true;
    document.removeEventListener("dragover", over);
    document.removeEventListener("drop", drop);
  }, { once: true });
  if (nativeWindowRole !== "browser") {
    listenNativeEvent("truedown:drop-error", ({ payload }) => error(new Error(payload))).catch(error);
    if (nativeWindowRole === "new-task") {
      listenNativeEvent("truedown:drop-ready", drainNativeDrop).then(() => drainNativeDrop()).catch(error);
      window.addEventListener("focus", drainNativeDrop);
      window.addEventListener("pagehide", () => window.removeEventListener("focus", drainNativeDrop), { once: true });
    }
  }
}
