// content/coomerfans_actions.js - coomerfans.com button rendering

const COOMERFANS_TARGET_SELECTOR = [
  "section.model-posts",
  ".posts-list .post",
  ".pagination-bottom",
  "article.text-block.model-info",
].join(", ");

function parseCoomerFansCreatorPath(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (parts[0] !== "u" || parts.length < 3) return null;
  return {
    service: String(parts[1] || "").toLowerCase(),
    userId: String(parts[2] || ""),
    creatorName: parts[3] ? decodeURIComponent(parts[3]) : "",
  };
}

function parseCoomerFansPostPath(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (parts[0] !== "p" || parts.length < 4) return null;
  return {
    postId: String(parts[1] || ""),
    userId: String(parts[2] || ""),
    service: String(parts[3] || "").toLowerCase(),
  };
}

function isCoomerFansPostPage() {
  return !!parseCoomerFansPostPath(location.pathname);
}

function isActiveCoomerFansButton(btn) {
  const status = btn && btn.getAttribute("data-status");
  return status === "SCANNING" || status === "SENDING";
}

function getCoomerFansCreatorName() {
  const parsed = parseCoomerFansCreatorPath(location.pathname);
  if (parsed && parsed.creatorName) return parsed.creatorName;
  const nameEl = document.querySelector("article.text-block.model-info .model-name");
  if (nameEl && nameEl.textContent) return nameEl.textContent.trim();
  const img = document.querySelector("article.text-block.model-info figure img[alt]");
  return img ? (img.getAttribute("alt") || "").trim() : "";
}

function getCoomerFansCreatorEntries() {
  const entries = [];
  const creator = parseCoomerFansCreatorPath(location.pathname);

  for (const postEl of document.querySelectorAll("section.model-posts .posts-list .post")) {
    const anchor =
      postEl.querySelector('h3 a[href^="/p/"], h3 a[href*="/p/"]') ||
      postEl.querySelector('a.view-post[href^="/p/"], a.view-post[href*="/p/"]');
    if (!anchor) continue;

    const href = anchor.getAttribute("href") || anchor.href;
    let url;
    try {
      url = new URL(href, location.origin);
    } catch (e) {
      continue;
    }

    const parsed = parseCoomerFansPostPath(url.pathname);
    if (!parsed || !parsed.postId || !parsed.userId || !parsed.service) continue;

    entries.push({
      postEl,
      anchor,
      path: url.pathname,
      source: "coomerfans",
      service: parsed.service,
      userId: parsed.userId,
      postId: parsed.postId,
      creatorName: creator && creator.userId === parsed.userId ? creator.creatorName : "",
    });
  }

  return entries;
}

function findCoomerFansButton(container, path) {
  return Array.from(
    container.querySelectorAll('.kemono-creator-btn[data-batch-download="true"]')
  ).find((btn) => btn.getAttribute("data-path") === path);
}

async function addCoomerFansPostButton() {
  const parsed = parseCoomerFansPostPath(location.pathname);
  if (!parsed || !parsed.postId) return;

  const container = document.querySelector("article.text-block.model-info");
  if (!container) return;

  let btn = container.querySelector('.batch-download-btn[data-batch-download="true"]');
  const isNew = !btn;
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "batch-download-btn coomerfans-post-download-btn";
    btn.type = "button";
    btn.setAttribute("data-batch-download", "true");
  }

  btn.dataset.path = location.pathname;
  btn.onclick = () => {
    if (btn.disabled) return;
    handleDownload(
      btn,
      parsed.service,
      parsed.userId,
      parsed.postId,
      location.pathname,
      false,
      { source: "coomerfans", creatorName: getCoomerFansCreatorName() }
    );
  };

  if (!isActiveCoomerFansButton(btn)) {
    updateButtonStatus(btn, "IDLE", null, false);
    const downloaded = await isPostDownloaded(
      parsed.service,
      parsed.userId,
      parsed.postId,
      { source: "coomerfans" }
    );
    if (downloaded) {
      updateButtonStatus(btn, "SUCCESS", "✓ Downloaded", false);
      btn.disabled = true;
    }
  }

  if (isNew) {
    const platformRow =
      container.querySelector("p .as-button.as-tag.as-alt")?.closest("p") ||
      container.querySelector(".model-name") ||
      container.querySelector("figure");
    if (platformRow && platformRow.nextSibling) {
      container.insertBefore(btn, platformRow.nextSibling);
    } else {
      container.appendChild(btn);
    }
  }
}

async function addCoomerFansCreatorButtons() {
  const entries = getCoomerFansCreatorEntries();
  const livePaths = new Set(entries.map((entry) => entry.path));
  document
    .querySelectorAll('.kemono-creator-btn[data-batch-download="true"]')
    .forEach((btn) => {
      const path = btn.getAttribute("data-path");
      if (!livePaths.has(path)) btn.remove();
    });

  const downloaded = await getDownloadedStatusMap(entries);

  for (const entry of entries) {
    const key = downloadedKey(entry.service, entry.userId, entry.postId, entry.source);
    const isDone = downloaded.get(key) === true;
    let btn = findCoomerFansButton(entry.postEl, entry.path);

    if (!btn) {
      btn = document.createElement("div");
      btn.className = "kemono-creator-btn coomerfans-creator-btn";
      btn.setAttribute("data-batch-download", "true");
      btn.setAttribute("data-path", entry.path);
      entry.postEl.appendChild(btn);
    }

    if (isActiveCoomerFansButton(btn)) continue;

    btn.textContent = isDone ? "✓" : "↓";
    btn.title = isDone ? "Already downloaded" : "Click to download";
    btn.disabled = isDone;
    entry.postEl.style.position = "relative";
    entry.postEl.classList.add("kd-coomerfans-post");

    btn.onclick = isDone
      ? null
      : (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (btn.disabled) return;
          handleDownload(
            btn,
            entry.service,
            entry.userId,
            entry.postId,
            entry.path,
            true,
            { source: "coomerfans", creatorName: entry.creatorName }
          );
        };
  }
}

function addCoomerFansPageFetchButton() {
  const section = document.querySelector("section.model-posts");
  if (!section) return;

  const creator = parseCoomerFansCreatorPath(location.pathname);
  if (!creator) return;

  let actions = section.querySelector(".kd-coomerfans-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "kd-coomerfans-actions";
    const title = section.querySelector("h2");
    if (title && title.nextSibling) section.insertBefore(actions, title.nextSibling);
    else section.prepend(actions);
  }

  let btn = actions.querySelector('.kemono-download-all[data-batch-download="true"]');
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "kemono-download-all batch-download-btn";
    btn.type = "button";
    btn.setAttribute("data-batch-download", "true");
    btn.textContent = "Page Fetch";
    btn.title = "Download all posts on this page";
    actions.appendChild(btn);
  }

  btn.onclick = async (event) => {
    event.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;

    const entries = getCoomerFansCreatorEntries();
    const downloaded = await getDownloadedStatusMap(entries);
    const items = entries
      .filter((entry) => !downloaded.get(downloadedKey(entry.service, entry.userId, entry.postId, entry.source)))
      .map((entry) => ({
        service: entry.service,
        userId: entry.userId,
        postId: entry.postId,
        path: entry.path,
        source: "coomerfans",
        creatorName: entry.creatorName,
      }));

    if (items.length === 0) {
      updateButtonStatus(btn, "SUCCESS", "✓ All done", false);
      setTimeout(() => {
        btn.disabled = false;
        updateButtonStatus(btn, "IDLE", "Page Fetch", false);
      }, 2000);
      return;
    }

    let total = items.length;
    let completed = 0;
    let successCount = 0;

    const finish = (status, text, keepDisabled) => {
      try {
        chrome.runtime.onMessage.removeListener(onBatchMessage);
      } catch (e) {
        /* ignore */
      }
      updateButtonStatus(btn, status, text, false);
      btn.disabled = !!keepDisabled;
      if (!keepDisabled) {
        setTimeout(() => updateButtonStatus(btn, "IDLE", "Page Fetch", false), 2000);
      }
    };

    const onBatchMessage = (message) => {
      if (!message) return;
      if (message.service !== creator.service || message.userId !== creator.userId) return;

      if (message.action === "downloadProgress" && message.batch) {
        if (Number.isFinite(message.totalCount)) total = message.totalCount;
        btn.textContent = `Sending ${message.sentCount || 0}/${total}`;
        if (completed >= total) {
          if (successCount > 0) finish("SUCCESS", `✓ ${successCount}/${total}`, true);
          else finish("ERROR", "✗ Failed", false);
        }
        return;
      }

      if (message.action !== "downloadComplete") return;
      completed++;
      if (message.result && message.result.success) successCount++;
      btn.textContent = `ACK ${completed}/${total}`;

      if (completed >= total) {
        if (successCount > 0) finish("SUCCESS", `✓ ${successCount}/${total}`, true);
        else finish("ERROR", "✗ Failed", false);
      }
    };

    chrome.runtime.onMessage.addListener(onBatchMessage);
    updateButtonStatus(btn, "SENDING", `Dispatching ${items.length}...`, false);

    try {
      const ack = await safeSendMessage(
        { action: "startDownloadBatch", items },
        10000,
        { retries: 2, retryDelay: 400 }
      );
      if (!ack || (!ack.accepted && !ack.success)) throw new Error("No ack");
      updateButtonStatus(btn, "SENDING", "Dispatched, awaiting ACK...", false);
    } catch (err) {
      try {
        chrome.runtime.onMessage.removeListener(onBatchMessage);
      } catch (e) {
        /* ignore */
      }
      updateButtonStatus(btn, "ERROR", "✗ No ack", false);
      setTimeout(() => {
        btn.disabled = false;
        updateButtonStatus(btn, "IDLE", "Page Fetch", false);
      }, 2000);
    }
  };
}

function reportCoomerFansAccess() {
  try {
    const parsed = parseCoomerFansCreatorPath(location.pathname);
    if (!parsed) return;
    chrome.runtime.sendMessage(
      { action: "creator.recordAccess", service: parsed.service, userId: parsed.userId },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch (e) {
    /* ignore */
  }
}

async function renderCoomerFansActions() {
  reportCoomerFansAccess();
  if (isCoomerFansPostPage()) {
    await addCoomerFansPostButton();
  } else {
    await addCoomerFansCreatorButtons();
    addCoomerFansPageFetchButton();
  }
}

function hasCoomerFansTargets() {
  if (isCoomerFansPostPage()) {
    return !!document.querySelector("article.text-block.model-info");
  }
  return !!document.querySelector(COOMERFANS_TARGET_SELECTOR);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.action === "updateUI") {
    if (window.KDRouteWatcher) window.KDRouteWatcher.schedule("updateUI", 100);
    else renderCoomerFansActions();
  }
});

if (window.KDRouteWatcher) {
  window.KDRouteWatcher.register({
    name: "coomerfans-download-actions",
    targetSelector: COOMERFANS_TARGET_SELECTOR,
    match: () => /^\/u\/[^/]+\/[^/]+/.test(location.pathname) || /^\/p\/[^/]+\/[^/]+\/[^/]+/.test(location.pathname),
    hasTargets: hasCoomerFansTargets,
    render: renderCoomerFansActions,
    maxAttempts: 25,
  });
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => renderCoomerFansActions(), {
    once: true,
  });
} else {
  setTimeout(renderCoomerFansActions, CONFIG.INIT_DELAY);
}
