// content/actions.js - Kemono/Coomer button rendering

const KEMONO_TARGET_SELECTOR = [
  ".post__actions",
  ".post__header",
  ".user-header__actions",
  "article.post-card",
  "article.post-card--preview",
].join(", ");

function isCreatorPage() {
  return !location.pathname.includes("/post/");
}

function getCreatorEntries() {
  const entries = [];
  const articles = Array.from(
    document.querySelectorAll(
      "article.post-card.post-card--preview, article.post-card"
    )
  );

  for (const article of articles) {
    const anchor = article.querySelector(
      'a.fancy-link, a[href*="/post/"], a.post__link'
    );
    if (!anchor) continue;

    const href = anchor.getAttribute("href") || anchor.href;
    const url = new URL(href, location.origin);
    const path = url.pathname;
    const parsed = parseUrlPath(path);
    if (!parsed || !parsed.postId) continue;
    entries.push({ article, anchor, path, ...parsed });
  }

  return entries;
}

function findCreatorButton(container, path) {
  return findDownloadButtonByPath(
    container,
    '.kemono-creator-btn[data-batch-download="true"]',
    path
  );
}

async function addPostButton(context) {
  const container =
    document.querySelector(".post__actions") ||
    document.querySelector(".post__header");
  if (!container) return;

  const parsed = parseUrlPath(location.pathname);
  if (!parsed || !parsed.postId) return;

  let btn = container.querySelector('.batch-download-btn[data-batch-download="true"]');
  const isNew = !btn;
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "button _button_e60d849 batch-download-btn";
    btn.type = "button";
    btn.setAttribute("data-batch-download", "true");
  }

  btn.dataset.path = location.pathname;
  btn.onmouseenter = function () {
    if (!this.disabled) this.classList.add("kemono-btn-hover");
  };
  btn.onmouseleave = function () {
    this.classList.remove("kemono-btn-hover");
  };
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

async function addCreatorButtons(context) {
  const entries = getCreatorEntries();
  const livePaths = new Set(entries.map((entry) => entry.path));
  removeStaleDownloadButtons('.kemono-creator-btn[data-batch-download="true"]', livePaths);

  const downloaded = await getDownloadedStatusMap(entries);
  if (!isRenderCurrent(context)) return;

  for (const entry of entries) {
    const key = downloadedKey(entry.service, entry.userId, entry.postId);
    const isDone = downloaded.get(key) === true;
    const container = entry.anchor;
    let btn = findCreatorButton(container, entry.path);

    if (!btn) {
      btn = document.createElement("div");
      btn.className = "kemono-creator-btn";
      btn.setAttribute("data-batch-download", "true");
      btn.setAttribute("data-path", entry.path);
      container.appendChild(btn);
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

function addDownloadAllButton() {
  const header = document.querySelector(".user-header__actions");
  if (!header) return;

  let btn = header.querySelector(
    '.kemono-download-all[data-batch-download="true"]'
  );
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

    const parsedPage = parseUrlPath(location.pathname);
    if (!parsedPage) {
      updateButtonStatus(btn, "ERROR", "✗ Invalid page", false);
      setTimeout(() => {
        btn.disabled = false;
        updateButtonStatus(btn, "IDLE", null, false);
      }, 2000);
      return;
    }

    try {
      const cfg = await safeSendMessage(
        { action: "backend.getConfig" },
        3000,
        { retries: 1, retryDelay: 200 }
      );
      if (!cfg || !cfg.success || !cfg.config || !cfg.config.enabled) {
        updateButtonStatus(btn, "ERROR", KDI18n.get("backendEnableRequired"), false);
        setTimeout(() => {
          btn.disabled = false;
          updateButtonStatus(btn, "IDLE", null, false);
        }, 2500);
        return;
      }
    } catch (err) {
      console.warn("[Content] backend.getConfig failed", err);
      updateButtonStatus(btn, "ERROR", KDI18n.get("backendCheckFailed"), false);
      setTimeout(() => {
        btn.disabled = false;
        updateButtonStatus(btn, "IDLE", null, false);
      }, 2000);
      return;
    }

    const service = parsedPage.service;
    const userId = parsedPage.userId;
    const offsetParam = new URL(location.href).searchParams.get("o");
    const offset = offsetParam ? Number(offsetParam) : null;
    await runPageFetchWithProgress({
      btn,
      service,
      userId,
      requestMessage: { action: "creator.pageFetch", service, userId, offset },
      initialText: "Dispatching page...",
      ackText: "Dispatched, awaiting progress...",
    });
  };
}

async function renderKemonoDownloadUI(context) {
  reportAccessIfApplicable();
  if (isCreatorPage()) {
    await addCreatorButtons(context);
    if (!isRenderCurrent(context)) return;
    addDownloadAllButton();
  } else {
    await addPostButton(context);
  }
}

function hasKemonoTargets() {
  return !!document.querySelector(KEMONO_TARGET_SELECTOR);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.action === "updateUI") {
    if (window.KDRouteWatcher) window.KDRouteWatcher.schedule("updateUI", 100);
    else renderKemonoDownloadUI();
  }
});

if (window.KDRouteWatcher) {
  window.KDRouteWatcher.register({
    name: "kemono-download-actions",
    targetSelector: KEMONO_TARGET_SELECTOR,
    match: () => /\/[^/]+\/user\/[^/]+/.test(location.pathname),
    hasTargets: hasKemonoTargets,
    render: renderKemonoDownloadUI,
    maxAttempts: 25,
  });
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => renderKemonoDownloadUI(), {
    once: true,
  });
} else {
  setTimeout(renderKemonoDownloadUI, CONFIG.INIT_DELAY);
}
