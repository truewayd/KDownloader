// content/paw_actions.js - pawchive.st button rendering

const PAW_TARGET_SELECTOR = [
  ".post__actions",
  ".user-header__actions",
  "article.post-card",
].join(", ");

function isPawPostPage() {
  return /\/user\/[^\/]+\/post\//.test(location.pathname);
}

function isActivePawButton(btn) {
  const status = btn && btn.getAttribute("data-status");
  return status === "SCANNING" || status === "SENDING";
}

function handlePawDownload(btn, service, userId, postId, path, isCreatorPage) {
  if (btn.disabled) return;
  updateButtonStatus(btn, "SCANNING", null, isCreatorPage);

  safeSendMessage(
    { action: "startDownload", service, userId, postId, path, source: "pawchive" },
    7000,
    { retries: 2, retryDelay: 400 }
  )
    .then((ack) => {
      if (!ack || !ack.accepted) {
        updateButtonStatus(btn, "ERROR", "✗ Not accepted", isCreatorPage);
        setTimeout(() => {
          btn.disabled = false;
          updateButtonStatus(btn, "IDLE", null, isCreatorPage);
        }, 2000);
        return;
      }

      updateButtonStatus(btn, "SENDING", null, isCreatorPage);

      const watchdogMs = 10 * 60 * 1000;
      let watchdog = null;
      const resetWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          try {
            chrome.runtime.onMessage.removeListener(onComplete);
          } catch (e) {
            /* ignore */
          }
          if (btn.getAttribute("data-status") === "SENDING") {
            updateButtonStatus(btn, "ERROR", "✗ Timeout", isCreatorPage);
            setTimeout(() => {
              btn.disabled = false;
              updateButtonStatus(btn, "IDLE", null, isCreatorPage);
            }, 2000);
          }
        }, watchdogMs);
      };

      const finish = () => {
        try {
          chrome.runtime.onMessage.removeListener(onComplete);
        } catch (e) {
          /* ignore */
        }
        if (watchdog) clearTimeout(watchdog);
        watchdog = null;
      };

      const onComplete = (message) => {
        try {
          if (!message) return;
          if (message.service !== service || message.userId !== userId || message.postId !== postId) return;

          if (message.action === "downloadProgress") {
            resetWatchdog();
            return;
          }
          if (message.action !== "downloadComplete") return;

          const result = message.result || {};
          if (result.externalLinks && result.externalLinks.length > 0) {
            showExternalLinksModal(result.externalLinks);
          }

          if (result.success) {
            const noFiles = result.noFiles === true;
            const anyDownloaded =
              noFiles ||
              result.backend === true ||
              (typeof result.successCount === "number" && result.successCount > 0) ||
              (Array.isArray(result.results) && result.results.some((item) => item && item.success));

            if (result.alreadyDownloaded) {
              updateButtonStatus(btn, "SUCCESS", "✓ Downloaded", isCreatorPage);
              btn.disabled = true;
            } else if (anyDownloaded) {
              updateButtonStatus(btn, "SUCCESS", noFiles && !isCreatorPage ? "No files" : null, isCreatorPage);
              if (isCreatorPage) {
                btn.title = noFiles ? "No downloadable files" : "Already downloaded";
                btn.disabled = true;
              } else {
                btn.disabled = false;
                if (!noFiles) {
                  setTimeout(() => updateButtonStatus(btn, "IDLE", null, false), 2000);
                }
              }
            } else {
              if (isCreatorPage) btn.title = "No downloadable files";
              else updateButtonStatus(btn, "SUCCESS", "No files", false);
              btn.disabled = false;
              setTimeout(() => updateButtonStatus(btn, "IDLE", null, isCreatorPage), 2000);
            }
          } else {
            const errMsg = result.error || "Download failed";
            updateButtonStatus(btn, "ERROR", `✗ ${errMsg}`, isCreatorPage);
            setTimeout(() => {
              btn.disabled = false;
              updateButtonStatus(btn, "IDLE", null, isCreatorPage);
            }, 2000);
          }
        } finally {
          finish();
        }
      };

      chrome.runtime.onMessage.addListener(onComplete);
      resetWatchdog();
    })
    .catch((err) => {
      updateButtonStatus(
        btn,
        "ERROR",
        `✗ ${err && err.message ? err.message : "Error"}`,
        isCreatorPage
      );
      setTimeout(() => {
        btn.disabled = false;
        updateButtonStatus(btn, "IDLE", null, isCreatorPage);
      }, 2000);
    });
}

async function addPawPostButton() {
  const container = document.querySelector(".post__actions");
  if (!container) return;

  const parsed = parseUrlPath(location.pathname);
  if (!parsed || !parsed.postId) return;

  let btn = container.querySelector('[data-batch-download="true"]');
  const isNew = !btn;
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "button _button_e60d849 batch-download-btn";
    btn.type = "button";
    btn.setAttribute("data-batch-download", "true");
  }

  btn.onclick = () => {
    if (btn.disabled) return;
    handlePawDownload(
      btn,
      parsed.service,
      parsed.userId,
      parsed.postId,
      location.pathname,
      false
    );
  };

  if (!isActivePawButton(btn)) {
    updateButtonStatus(btn, "IDLE", null, false);
    const downloaded = await isPostDownloaded(
      parsed.service,
      parsed.userId,
      parsed.postId
    );
    if (downloaded) {
      updateButtonStatus(btn, "SUCCESS", "✓ Downloaded", false);
      btn.disabled = true;
    }
  }

  if (isNew) container.appendChild(btn);
}

function getPawCreatorEntries() {
  const entries = [];
  for (const article of document.querySelectorAll("article.post-card")) {
    const anchor = article.querySelector('a.image-link, a[href*="/post/"]');
    if (!anchor) continue;
    const href = anchor.getAttribute("href") || anchor.href;
    const path = new URL(href, location.origin).pathname;
    const parsed = parseUrlPath(path);
    if (!parsed || !parsed.postId) continue;
    entries.push({ article, anchor, path, ...parsed });
  }
  return entries;
}

function findPawCreatorButton(container, path) {
  return Array.from(
    container.querySelectorAll('.kemono-creator-btn[data-batch-download="true"]')
  ).find((btn) => btn.getAttribute("data-path") === path);
}

async function addPawCreatorButtons() {
  const entries = getPawCreatorEntries();
  const livePaths = new Set(entries.map((entry) => entry.path));
  document
    .querySelectorAll('.kemono-creator-btn[data-batch-download="true"]')
    .forEach((btn) => {
      const path = btn.getAttribute("data-path");
      if (!livePaths.has(path)) btn.remove();
    });

  const downloaded = await getDownloadedStatusMap(entries);

  for (const entry of entries) {
    const key = downloadedKey(entry.service, entry.userId, entry.postId);
    const isDone = downloaded.get(key) === true;
    let btn = findPawCreatorButton(entry.anchor, entry.path);

    if (!btn) {
      btn = document.createElement("div");
      btn.className = "kemono-creator-btn";
      btn.setAttribute("data-batch-download", "true");
      btn.setAttribute("data-path", entry.path);
      entry.anchor.appendChild(btn);
    }

    if (isActivePawButton(btn)) continue;

    btn.textContent = isDone ? "✓" : "↓";
    btn.title = isDone ? "Already downloaded" : "Click to download";
    btn.disabled = isDone;
    entry.article.style.position = "relative";
    btn.onclick = isDone
      ? null
      : (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (btn.disabled) return;
          handlePawDownload(
            btn,
            entry.service,
            entry.userId,
            entry.postId,
            entry.path,
            true
          );
        };
  }
}

function addPawPageFetchButton() {
  const header = document.querySelector(".user-header__actions");
  if (!header) return;

  const parsed = parseUrlPath(location.pathname);
  if (!parsed) return;

  let btn = header.querySelector('.kemono-download-all[data-batch-download="true"]');
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "kemono-download-all button _button_e60d849";
    btn.type = "button";
    btn.setAttribute("data-batch-download", "true");
    btn.textContent = "Page Fetch";
    btn.title = "Download all posts on this page";
    btn.style.margin = "0";
    btn.style.padding = "0";
    header.appendChild(btn);
  }

  btn.onclick = async (event) => {
    event.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;

    const entries = getPawCreatorEntries();
    const downloaded = await getDownloadedStatusMap(entries);
    const items = entries
      .filter((entry) => !downloaded.get(downloadedKey(entry.service, entry.userId, entry.postId)))
      .map((entry) => ({
        service: entry.service,
        userId: entry.userId,
        postId: entry.postId,
        source: "pawchive",
      }));

    if (items.length === 0) {
      updateButtonStatus(btn, "SUCCESS", "✓ All done", false);
      setTimeout(() => {
        btn.disabled = false;
        updateButtonStatus(btn, "IDLE", null, false);
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
        setTimeout(() => updateButtonStatus(btn, "IDLE", null, false), 2000);
      }
    };

    const onBatchMessage = (message) => {
      if (!message) return;
      if (message.service !== parsed.service || message.userId !== parsed.userId) return;

      if (message.action === "downloadProgress" && message.batch) {
        if (Number.isFinite(message.totalCount)) total = message.totalCount;
        btn.title = `Sending ${message.sentCount || 0}/${total}`;
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
        updateButtonStatus(btn, "IDLE", null, false);
      }, 2000);
    }
  };
}

function reportPawAccess() {
  try {
    const match = location.pathname.match(/\/([^\/]+)\/user\/([^\/]+)/);
    if (!match) return;
    chrome.runtime.sendMessage(
      { action: "creator.recordAccess", service: match[1], userId: match[2] },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch (e) {
    /* ignore */
  }
}

async function renderPawActions() {
  reportPawAccess();
  if (isPawPostPage()) {
    await addPawPostButton();
  } else {
    await addPawCreatorButtons();
    addPawPageFetchButton();
  }
}

function hasPawTargets() {
  return !!document.querySelector(PAW_TARGET_SELECTOR);
}

if (window.KDRouteWatcher) {
  window.KDRouteWatcher.register({
    name: "paw-download-actions",
    targetSelector: PAW_TARGET_SELECTOR,
    match: () => /\/[^/]+\/user\/[^/]+/.test(location.pathname),
    hasTargets: hasPawTargets,
    render: renderPawActions,
    maxAttempts: 25,
  });
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => renderPawActions(), {
    once: true,
  });
} else {
  setTimeout(renderPawActions, CONFIG.INIT_DELAY);
}
