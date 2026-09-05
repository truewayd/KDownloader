// content/actions.js - Kemono/Coomer button rendering

const KEMONO_TARGET_SELECTOR = [
  ".post__actions",
  ".post__header",
  ".user-header__actions",
  "article.post-card",
  "article.post-card--preview",
].join(", ");

function isCreatorPage() {
  const parsed = parseUrlPath(location.pathname);
  return !!parsed && !parsed.postId;
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
    const path = getSameOriginPath(href);
    if (!path) continue;
    const parsed = parseUrlPath(path);
    if (!parsed || !parsed.postId) continue;
    entries.push({ article, anchor, path, ...parsed });
  }

  return entries;
}

async function addPostButton(context) {
  const container =
    document.querySelector(".post__actions") ||
    document.querySelector(".post__header");
  if (!container) return;

  const parsed = parseUrlPath(location.pathname);
  if (!parsed || !parsed.postId) return;

  await renderPostDownloadButton(context, { container, parsed });
}

async function addCreatorButtons(context) {
  const entries = getCreatorEntries();
  const livePaths = new Set(entries.map((entry) => entry.path));
  removeStaleDownloadButtons(KD_CREATOR_BUTTON_SELECTOR, livePaths);

  await renderCreatorDownloadButtons(entries, context, {
    getContainer: (entry) => entry.article,
  });
}

function addDownloadAllButton() {
  const header = document.querySelector(".user-header__actions");
  if (!header) return;

  const btn = ensurePageFetchButton(header);
  if (!btn) return;

  btn.onclick = async (event) => {
    event.preventDefault();
    if (btn.disabled) return;
    updateButtonStatus(btn, "SCANNING", KDI18n.get("statusFetching"), false);

    const parsedPage = parseUrlPath(location.pathname);
    if (!parsedPage) {
      showTransientButtonStatus(
        btn,
        "ERROR",
        KDI18n.get("statusFailedDecorated"),
        false,
        KDI18n.get("pageFetchAction")
      );
      return;
    }

    try {
      const cfg = await safeSendMessage(
        { action: "backend.getConfig" },
        3000,
        { retries: 1, retryDelay: 200 }
      );
      if (!cfg || !cfg.success || !cfg.config || !cfg.config.enabled) {
        showTransientButtonStatus(
          btn,
          "ERROR",
          KDI18n.get("backendEnableRequired"),
          false,
          KDI18n.get("pageFetchAction"),
          2500
        );
        return;
      }
    } catch (err) {
      console.warn("[Content] backend.getConfig failed", err);
      showTransientButtonStatus(
        btn,
        "ERROR",
        KDI18n.get("backendCheckFailed"),
        false,
        KDI18n.get("pageFetchAction")
      );
      return;
    }

    const service = parsedPage.service;
    const userId = parsedPage.userId;
    const offsetParam = new URL(location.href).searchParams.get("o");
    const parsedOffset = offsetParam ? Number(offsetParam) : null;
    const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : null;
    await runPageFetchWithProgress({
      btn,
      service,
      userId,
      requestMessage: { action: "creator.pageFetch", service, userId, offset },
      initialText: KDI18n.get("statusSending"),
      ackText: KDI18n.get("statusSending"),
    });
  };
}

async function renderKemonoDownloadUI(context) {
  if (isCreatorPage()) {
    removeKdElements(KD_POST_BUTTON_SELECTOR);
    await addCreatorButtons(context);
    if (!isRenderCurrent(context)) return;
    addDownloadAllButton();
  } else {
    removeKdElements([
      KD_CREATOR_BUTTON_SELECTOR,
      KD_PAGE_FETCH_BUTTON_SELECTOR,
    ].join(', '));
    await addPostButton(context);
  }
}

function cleanupKemonoDownloadUI() {
  removeKdElements([
    KD_CREATOR_BUTTON_SELECTOR,
    KD_POST_BUTTON_SELECTOR,
    KD_PAGE_FETCH_BUTTON_SELECTOR,
  ].join(', '));
}

function hasKemonoTargets() {
  return !!document.querySelector(KEMONO_TARGET_SELECTOR);
}

if (window.KDRouteWatcher) {
  window.KDRouteWatcher.register({
    name: "kemono-download-actions",
    targetSelector: KEMONO_TARGET_SELECTOR,
    match: () => !!parseUrlPath(location.pathname),
    hasTargets: hasKemonoTargets,
    render: renderKemonoDownloadUI,
    cleanup: cleanupKemonoDownloadUI,
    maxAttempts: 25,
  });
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => renderKemonoDownloadUI(), {
    once: true,
  });
} else {
  setTimeout(renderKemonoDownloadUI, CONFIG.INIT_DELAY);
}
