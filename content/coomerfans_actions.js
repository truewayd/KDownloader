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

async function addCoomerFansPostButton(context) {
  const parsed = parseCoomerFansPostPath(location.pathname);
  if (!parsed || !parsed.postId) return;

  const container = document.querySelector("article.text-block.model-info");
  if (!container) return;

  await renderPostDownloadButton(context, {
    container,
    parsed,
    source: "coomerfans",
    creatorName: getCoomerFansCreatorName(),
    classNames: ["kd-coomerfans-post-button"],
    place: (button) => {
      const platformRow =
        container.querySelector("p .as-button.as-tag.as-alt")?.closest("p") ||
        container.querySelector(".model-name") ||
        container.querySelector("figure");
      if (platformRow?.nextSibling) container.insertBefore(button, platformRow.nextSibling);
      else container.appendChild(button);
    },
  });
}

async function addCoomerFansCreatorButtons(context) {
  const entries = getCoomerFansCreatorEntries();
  const livePaths = new Set(entries.map((entry) => entry.path));
  removeStaleDownloadButtons(KD_CREATOR_BUTTON_SELECTOR, livePaths);

  await renderCreatorDownloadButtons(entries, context, {
    getContainer: (entry) => entry.postEl,
    decorateContainer: (container) => container.classList.add("kd-coomerfans-post"),
    getDownloadOptions: (entry) => ({
      source: "coomerfans",
      creatorName: entry.creatorName,
    }),
  });
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

  const btn = ensurePageFetchButton(actions);
  if (!btn) return;

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
      showTransientButtonStatus(
        btn,
        "SUCCESS",
        KDI18n.get("statusAllDoneDecorated"),
        false,
        KDI18n.get("pageFetchAction")
      );
      return;
    }

    await runPageFetchWithProgress({
      btn,
      service: creator.service,
      userId: creator.userId,
      requestMessage: {
        action: "startDownloadBatch",
        items,
        service: creator.service,
        userId: creator.userId,
        origin: location.origin,
        referer: location.href,
        aggregateExternalLinks: true,
        linksFileName: `${creator.service}_${creator.userId}_page_links.txt`,
        linksPostId: "page-links",
      },
      initialText: KDI18n.get("dispatchingCount", [String(items.length)]),
      ackText: KDI18n.get("statusSending"),
      resetText: KDI18n.get("pageFetchAction"),
      total: items.length,
    });
  };
}

function reportCoomerFansAccess() {
  try {
    const parsed = parseCoomerFansCreatorPath(location.pathname);
    if (!parsed) return;
    reportCreatorAccess(parsed.service, parsed.userId);
  } catch (e) {
    /* ignore */
  }
}

async function renderCoomerFansActions(context) {
  reportCoomerFansAccess();
  if (isCoomerFansPostPage()) {
    await addCoomerFansPostButton(context);
  } else {
    await addCoomerFansCreatorButtons(context);
    if (!isRenderCurrent(context)) return;
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
