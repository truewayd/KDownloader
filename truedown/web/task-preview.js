(() => {
  const stage = document.getElementById("preview-stage"), status = document.getElementById("preview-status");
  const info = document.getElementById("preview-info"), scaleLabel = document.getElementById("preview-scale");
  const zoomButtons = [...document.querySelectorAll(".preview-zoom button")];
  const kindLabel = document.getElementById("preview-kind"), wrapButton = document.getElementById("preview-wrap");
  let player = null;
  wrapButton.onclick = () => {
    const wrap = wrapButton.getAttribute("aria-pressed") !== "true";
    wrapButton.setAttribute("aria-pressed", String(wrap)); stage.classList.toggle("preview-nowrap", !wrap);
  };
  let target = null, controller = null, objectURL = null, picture = null, fit = true, scale = 1, disposed = false;
  let retryTimer = 0, retryDelay = 1000;
  const message = text => { status.textContent = text; };
  const release = () => {
    clearTimeout(retryTimer);
    controller?.abort(); controller = null;
    player?.dispose(); player = null;
    for (const media of stage.querySelectorAll("video, audio")) { media.pause(); media.removeAttribute("src"); media.load(); }
    stage.replaceChildren(); picture = null;
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = null;
    zoomButtons.forEach(button => { button.disabled = true; });
    scaleLabel.textContent = "—";
    document.querySelector(".preview-zoom").hidden = true; wrapButton.hidden = true;
    stage.dataset.kind = ""; kindLabel.textContent = "文件预览";
    stage.classList.remove("preview-nowrap"); wrapButton.setAttribute("aria-pressed", "true");
  };
  const resize = () => {
    if (!picture?.naturalWidth) return;
    if (fit) {
      const padding = getComputedStyle(stage);
      const width = stage.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
      const height = stage.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
      scale = Math.min(1, Math.max(1, width) / picture.naturalWidth, Math.max(1, height) / picture.naturalHeight);
    }
    picture.style.width = `${Math.max(1, Math.round(picture.naturalWidth * scale))}px`;
    picture.style.height = `${Math.max(1, Math.round(picture.naturalHeight * scale))}px`;
    scaleLabel.textContent = `${Math.round(scale * 100)}%`;
    document.getElementById("preview-fit").setAttribute("aria-pressed", String(fit));
  };
  const zoom = factor => { if (!picture) return; fit = false; scale = Math.min(8, Math.max(.05, scale * factor)); resize(); };
  document.getElementById("preview-fit").onclick = () => { fit = true; resize(); };
  document.getElementById("preview-actual").onclick = () => { fit = false; scale = 1; resize(); };
  document.getElementById("preview-out").onclick = () => zoom(1 / 1.25);
  document.getElementById("preview-in").onclick = () => zoom(1.25);
  stage.addEventListener("wheel", event => { if (picture && (event.ctrlKey || event.metaKey)) { event.preventDefault(); zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
  const observer = new ResizeObserver(resize); observer.observe(stage);
  document.querySelector('[data-preview-action="open-with"]').hidden = window.__TRUEDOWN_PLATFORM__ !== "windows";
  for (const button of document.querySelectorAll("[data-preview-action]")) {
    button.onclick = async () => {
      if (!target?.open || button.disabled) return;
      const snapshot = target;
      KDComponents.setBusyState(button, true);
      try { await requestText(`/tasks/${button.dataset.previewAction}?id=${snapshot.id}`, { method: "POST" }); }
      catch (error) { if (target === snapshot) message(`操作失败：${error.message}`); }
      finally { KDComponents.setBusyState(button, false); }
    };
  }
  async function apply(snapshot) {
    if (disposed || !Number.isSafeInteger(snapshot?.revision) || snapshot.revision <= (target?.revision ?? -1)
      || !Number.isSafeInteger(snapshot.id) || snapshot.id <= 0 || typeof snapshot.open !== "boolean") return;
    target = snapshot; release();
    retryDelay = 1000;
    document.title = "下载预览";
    info.textContent = "";
    if (!snapshot.open) return;
    await load(snapshot);
  }
  async function load(snapshot) {
    release();
    const abort = new AbortController(); controller = abort;
    const current = () => !disposed && target === snapshot && !abort.signal.aborted;
    message("正在读取文件…");
    try {
      let offset = 0, version = "", metadata, digest;
      const chunks = [];
      do {
        const chunk = await requestJSON(`/tasks/preview?id=${snapshot.id}&offset=${offset}&version=${version}`, { signal: abort.signal })
          .catch(error => { error.previewRetry = error.status === undefined || error.status >= 500; throw error; });
        if (!current()) return;
        if (!Number.isSafeInteger(chunk.size) || chunk.size < 0 || chunk.size > 64 * 1024 * 1024 || chunk.offset !== offset
          || !/^[a-f0-9]{64}$/.test(chunk.version) || (version && chunk.version !== version)
          || typeof chunk.data !== "string" || chunk.data.length > 700000
          || (metadata && (chunk.size !== metadata.size || chunk.mime !== metadata.mime || chunk.name !== metadata.name))) throw new Error("文件预览响应无效");
        if (offset === 0) {
          if (!/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error("文件校验信息无效");
          digest = chunk.sha256;
        }
        metadata = chunk; version = chunk.version;
        const bytes = Uint8Array.from(atob(chunk.data), char => char.charCodeAt(0));
        if (bytes.length !== Math.min(512 * 1024, chunk.size - offset)) throw new Error("文件预览不完整");
        chunks.push(bytes); offset += bytes.length;
        message(`正在读取文件… ${chunk.size ? Math.round(offset / chunk.size * 100) : 100}%`);
      } while (offset < metadata.size);
      if (!current()) return;
      const blob = new Blob(chunks, { type: metadata.mime });
      chunks.length = 0;
      let bytes = await blob.arrayBuffer();
      const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (!current()) return;
      if (actual !== digest) throw new Error("文件在读取过程中发生变化，请重新打开预览。");
      document.title = String(metadata.name).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
      info.textContent = `${metadata.name} · ${(metadata.size / 1024 / 1024).toFixed(2)} MiB`;
      if (metadata.mime === "text/plain") {
        stage.dataset.kind = "text"; kindLabel.textContent = "文本"; wrapButton.hidden = false;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!current()) return;
        const pre = document.createElement("pre"); pre.textContent = text; stage.append(pre);
      } else {
        const type = metadata.mime.startsWith("image/") ? "img" : metadata.mime.startsWith("audio/") ? "audio" : metadata.mime.startsWith("video/") ? "video" : null;
        if (!type) throw new Error("此格式暂不支持预览，请选择打开文件或打开方式。");
        stage.dataset.kind = type; kindLabel.textContent = { img: "图片", audio: "音频", video: "视频" }[type];
        objectURL = URL.createObjectURL(blob);
        const element = document.createElement(type);
        if (type === "img") {
          document.querySelector(".preview-zoom").hidden = false;
          element.alt = metadata.name; element.draggable = false;
          element.onload = () => {
            if (!current()) return;
            picture = element; fit = true; resize();
            info.textContent += ` · ${element.naturalWidth} × ${element.naturalHeight}`;
            zoomButtons.forEach(button => { button.disabled = false; });
          };
        } else {
          player = TrueDownPreviewPlayer.create(element, metadata.name, text => { if (current()) message(text); });
        }
        element.onerror = () => { if (current()) message("当前 WebView 无法解码此文件，请选择打开文件或打开方式。"); };
        element.src = objectURL; stage.append(player ? player.element : element);
      }
      bytes = null;
      message("");
    } catch (error) {
      if (current()) {
        message(`无法预览：${error.message}${error.previewRetry ? "，正在自动重试…" : ""}`);
        if (error.previewRetry) {
          retryTimer = setTimeout(() => { if (current()) void load(snapshot); }, retryDelay);
          retryDelay = Math.min(30000, retryDelay * 2);
        }
      }
    }
  }
  window.addEventListener("pagehide", () => { disposed = true; release(); observer.disconnect(); }, { once: true });
  KDComponents.installTooltips(); release();
  listenNativeEvent("truedown:task-preview", ({ payload }) => apply(payload))
    .then(() => invokeNative("task_preview_state")).then(apply).catch(error => message(`无法读取预览任务：${error.message}`));
})();
