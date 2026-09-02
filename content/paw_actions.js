// content/paw_actions.js - pawchive button rendering

const PAW_TARGET_SELECTOR = [
  ".post__actions",
  ".user-header__actions",
  "article.post-card",
].join(", ");
let pawWatchOperationSequence = 0;

function isPawPostPage() {
  return !!parseUrlPath(location.pathname)?.postId;
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
  const identity = JSON.stringify([parsed.service, parsed.userId]);
  if (btn.dataset.kdWatchIdentity === identity && btn.dataset.kdInitialized === "true") {
    return;
  }

  btn.dataset.kdWatchIdentity = identity;
  btn.dataset.kdInitialized = "false";
  KDComponents.setBusyState(btn, true);
  btn.setAttribute("aria-disabled", "true");
  btn.textContent = KDI18n.get("statusProcessing");

  let response;
  try {
    response = await safeSendMessage(
      { action: "watch.getState", service: parsed.service, userId: parsed.userId },
      8000,
      { retries: 2, retryDelay: 300 }
    );
    if (!response || response.success === false) {
      throw new Error(response?.error || "Failed to read watch state");
    }
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) throw error;
    if (!isRenderCurrent(context) || btn.dataset.kdWatchIdentity !== identity) return;
    const message = boundedDisplayText(getErrorMessage(error), KDI18n.get("statusFailedDecorated"));
    btn.textContent = KDI18n.get("statusFailedDecorated");
    btn.title = message;
    btn.setAttribute("aria-label", message);
    btn.onclick = (event) => {
      event.preventDefault();
      window.KDRouteWatcher?.schedule("watch-retry", 0);
    };
    KDComponents.setBusyState(btn, false);
    btn.setAttribute("aria-disabled", "false");
    return;
  }
  if (!isRenderCurrent(context) || btn.dataset.kdWatchIdentity !== identity) return;
  renderPawWatchState(btn, !!response.watched);
  btn.dataset.kdInitialized = "true";
  KDComponents.setBusyState(btn, false);
  btn.setAttribute("aria-disabled", "false");

  btn.onclick = async (event) => {
    event.preventDefault();
    if (btn.disabled) return;
    const previous = btn.dataset.watched === "true";
    const operationToken = String(++pawWatchOperationSequence);
    btn.dataset.kdWatchOperation = operationToken;
    delete btn.dataset.kdWatchReset;
    KDComponents.setBusyState(btn, true);
    btn.setAttribute("aria-disabled", "true");
    btn.textContent = KDI18n.get("statusProcessing");
    try {
      const result = await safeSendMessage(
        { action: "watch.setState", service: parsed.service, userId: parsed.userId, watched: !previous },
        15000,
        { retries: 1, retryDelay: 400 }
      );
      if (!result || result.success === false) throw new Error(result?.error || "Watch request failed");
      if (btn.dataset.kdWatchIdentity !== identity || btn.dataset.kdWatchOperation !== operationToken) return;
      renderPawWatchState(btn, !!result.watched);
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) return;
      if (btn.dataset.kdWatchIdentity !== identity || btn.dataset.kdWatchOperation !== operationToken) return;
      btn.textContent = KDI18n.get("statusFailedDecorated");
      btn.title = boundedDisplayText(getErrorMessage(error), KDI18n.get("statusFailedDecorated"));
      btn.setAttribute("aria-label", btn.title);
      const resetToken = `${operationToken}:reset`;
      btn.dataset.kdWatchReset = resetToken;
      setTimeout(() => {
        if (btn.dataset.kdWatchIdentity !== identity || btn.dataset.kdWatchReset !== resetToken) return;
        delete btn.dataset.kdWatchReset;
        renderPawWatchState(btn, previous);
      }, 1800);
    } finally {
      if (btn.dataset.kdWatchIdentity === identity && btn.dataset.kdWatchOperation === operationToken) {
        delete btn.dataset.kdWatchOperation;
        KDComponents.setBusyState(btn, false);
        btn.setAttribute("aria-disabled", "false");
      }
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
    const path = getSameOriginPath(href);
    if (!path) continue;
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
    updateButtonStatus(btn, "SCANNING", KDI18n.get("statusFetching"), false);

    const entries = getPawCreatorEntries();
    const offset = Number(new URL(location.href).searchParams.get("o") || 0);

    await runPageFetchWithProgress({
      btn,
      service: parsed.service,
      userId: parsed.userId,
      requestMessage: {
        action: "creator.pageFetch",
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

async function renderPawActions(context) {
  if (isPawPostPage()) {
    removeKdElements([
      KD_CREATOR_BUTTON_SELECTOR,
      KD_PAGE_FETCH_BUTTON_SELECTOR,
      '[data-kd-watch="true"]',
    ].join(', '));
    await addPawPostButton(context);
  } else {
    removeKdElements(KD_POST_BUTTON_SELECTOR);
    await addPawCreatorButtons(context);
    if (!isRenderCurrent(context)) return;
    addPawPageFetchButton();
    await addPawWatchButton(context);
  }
}

function cleanupPawActions() {
  removeKdElements([
    KD_CREATOR_BUTTON_SELECTOR,
    KD_POST_BUTTON_SELECTOR,
    KD_PAGE_FETCH_BUTTON_SELECTOR,
    '[data-kd-watch="true"]',
  ].join(', '));
}

function hasPawTargets() {
  return !!document.querySelector(PAW_TARGET_SELECTOR);
}

if (window.KDRouteWatcher) {
  window.KDRouteWatcher.register({
    name: "paw-download-actions",
    targetSelector: PAW_TARGET_SELECTOR,
    match: () => location.hostname === "pawchive.pw" && !!parseUrlPath(location.pathname),
    hasTargets: hasPawTargets,
    render: renderPawActions,
    cleanup: cleanupPawActions,
    maxAttempts: 25,
  });
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => renderPawActions(), {
    once: true,
  });
} else {
  setTimeout(renderPawActions, CONFIG.INIT_DELAY);
}
