// content/paw_actions.js - pawchive button rendering

const PAW_TARGET_SELECTOR = [
  ".post__actions",
  ".user-header__actions",
  "article.post-card",
].join(", ");

function isPawPostPage() {
  return /\/user\/[^\/]+\/post\//.test(location.pathname);
}

function renderPawWatchState(btn, watched) {
  btn.dataset.watched = watched ? "true" : "false";
  btn.textContent = watched ? KDI18n.get("unwatchAction") : KDI18n.get("watchAction");
  btn.title = watched ? KDI18n.get("unwatchTooltip") : KDI18n.get("watchTooltip");
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-pressed", String(watched));
}

async function addPawWatchButton(context) {
  const header = document.querySelector(".user-header__actions");
  const parsed = parseUrlPath(location.pathname);
  if (!header || !parsed || parsed.postId) return;

  const { button: btn } = ensureKdButton(header, '[data-kd-watch="true"]', {
    classNames: ["kd-watch-button"],
    attributes: { "data-kd-watch": "true" },
  });
  if (!btn) return;

  const response = await safeSendMessage(
    { action: "watch.getState", service: parsed.service, userId: parsed.userId },
    8000,
    { retries: 2, retryDelay: 300 }
  );
  if (!isRenderCurrent(context)) return;
  if (!response || response.success === false) {
    throw new Error(response?.error || "Failed to read watch state");
  }
  renderPawWatchState(btn, !!response.watched);

  btn.onclick = async (event) => {
    event.preventDefault();
    if (btn.disabled) return;
    const previous = btn.dataset.watched === "true";
    btn.disabled = true;
    btn.textContent = KDI18n.get("statusProcessing");
    try {
      const result = await safeSendMessage(
        { action: "watch.setState", service: parsed.service, userId: parsed.userId, watched: !previous },
        15000,
        { retries: 1, retryDelay: 400 }
      );
      if (!result || result.success === false) throw new Error(result?.error || "Watch request failed");
      renderPawWatchState(btn, !!result.watched);
    } catch (error) {
      btn.textContent = KDI18n.get("statusFailedDecorated");
      btn.title = error && error.message ? error.message : String(error);
      setTimeout(() => renderPawWatchState(btn, previous), 1800);
    } finally {
      btn.disabled = false;
    }
  };
}

async function addPawPostButton(context) {
  const container = document.querySelector(".post__actions");
  if (!container) return;

  const parsed = parseUrlPath(location.pathname);
  if (!parsed || !parsed.postId) return;

  await renderPostDownloadButton(context, { container, parsed });
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

async function addPawCreatorButtons(context) {
  const entries = getPawCreatorEntries();
  const livePaths = new Set(entries.map((entry) => entry.path));
  removeStaleDownloadButtons(KD_CREATOR_BUTTON_SELECTOR, livePaths);

  await renderCreatorDownloadButtons(entries, context, {
    getContainer: (entry) => entry.article,
  });
}

function addPawPageFetchButton() {
  const header = document.querySelector(".user-header__actions");
  if (!header) return;

  const parsed = parseUrlPath(location.pathname);
  if (!parsed) return;

  const btn = ensurePageFetchButton(header);
  if (!btn) return;

  btn.onclick = async (event) => {
    event.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;

    const entries = getPawCreatorEntries();
    const offset = Number(new URL(location.href).searchParams.get("o") || 0);

    await runPageFetchWithProgress({
      btn,
      service: parsed.service,
      userId: parsed.userId,
      requestMessage: {
        action: "creator.pageFetch",
        source: "pawchive",
        origin: location.origin,
        service: parsed.service,
        userId: parsed.userId,
        offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
      },
       initialText: KDI18n.get("dispatchingCount", [String(entries.length)]),
       ackText: KDI18n.get("statusSending"),
      total: entries.length,
      renderProgress: ({ btn: progressBtn, message, state }) => {
        progressBtn.title = KDI18n.get("sendingCount", [message.sentCount || 0, state.total]);
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
    await addPawWatchButton(context);
  }
}

function hasPawTargets() {
  return !!document.querySelector(PAW_TARGET_SELECTOR);
}

if (window.KDRouteWatcher) {
  window.KDRouteWatcher.register({
    name: "paw-download-actions",
    targetSelector: PAW_TARGET_SELECTOR,
    match: () => location.hostname === "pawchive.pw" && /\/[^/]+\/user\/[^/]+/.test(location.pathname),
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
