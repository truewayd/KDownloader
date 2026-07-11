// content/paw_actions.js - pawchive button rendering

const PAW_TARGET_SELECTOR = [
  ".post__actions",
  ".user-header__actions",
  "article.post-card",
].join(", ");

function isPawPostPage() {
  return /\/user\/[^\/]+\/post\//.test(location.pathname);
}

async function addPawPostButton(context) {
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
    handleDownload(
      btn,
      parsed.service,
      parsed.userId,
      parsed.postId,
      location.pathname,
      false
    );
  };

  if (!isActiveDownloadButton(btn)) {
    updateButtonStatus(btn, "IDLE", null, false);
    const downloaded = await isPostDownloaded(
      parsed.service,
      parsed.userId,
      parsed.postId
    );
    if (!isRenderCurrent(context)) return;
    if (downloaded) {
      updateButtonStatus(btn, "SUCCESS", KDI18n.get("statusDownloadedDecorated"), false);
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
  return findDownloadButtonByPath(
    container,
    '.kemono-creator-btn[data-batch-download="true"]',
    path
  );
}

async function addPawCreatorButtons(context) {
  const entries = getPawCreatorEntries();
  const livePaths = new Set(entries.map((entry) => entry.path));
  removeStaleDownloadButtons('.kemono-creator-btn[data-batch-download="true"]', livePaths);

  const downloaded = await getDownloadedStatusMap(entries);
  if (!isRenderCurrent(context)) return;

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

    if (isActiveDownloadButton(btn)) continue;

    btn.textContent = isDone ? "✓" : "↓";
    btn.title = isDone ? KDI18n.get("alreadyDownloadedTooltip") : KDI18n.get("clickToDownloadTooltip");
    btn.disabled = isDone;
    entry.article.style.position = "relative";
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
    btn.textContent = KDI18n.get("pageFetchAction");
    btn.title = KDI18n.get("pageFetchTooltip");
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
      }));

    if (items.length === 0) {
      updateButtonStatus(btn, "SUCCESS", KDI18n.get("statusAllDoneDecorated"), false);
      setTimeout(() => {
        btn.disabled = false;
        updateButtonStatus(btn, "IDLE", null, false);
      }, 2000);
      return;
    }

    await runPageFetchWithProgress({
      btn,
      service: parsed.service,
      userId: parsed.userId,
      requestMessage: { action: "startDownloadBatch", items },
      initialText: `Dispatching ${items.length}...`,
      ackText: "Dispatched, awaiting ACK...",
      total: items.length,
      renderProgress: ({ btn: progressBtn, message, state }) => {
        progressBtn.title = `Sending ${message.sentCount || 0}/${state.total}`;
      },
    });
  };
}

function reportPawAccess() {
  try {
    const match = location.pathname.match(/\/([^\/]+)\/user\/([^\/]+)/);
    if (!match) return;
    reportCreatorAccess(match[1], match[2]);
  } catch (e) {
    /* ignore */
  }
}

async function renderPawActions(context) {
  reportPawAccess();
  if (isPawPostPage()) {
    await addPawPostButton(context);
  } else {
    await addPawCreatorButtons(context);
    if (!isRenderCurrent(context)) return;
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
