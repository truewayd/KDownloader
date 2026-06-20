// content/paw_actions.js - pawchive.st page injection logic
// Relies on helpers.js (parseUrlPath, safeSendMessage, isPostDownloaded),
// ui.js (updateButtonStatus, showExternalLinksModal), and
// download.js (handleDownload) already loaded in the same content-script scope.

function isPawPostPage() {
  return /\/user\/[^\/]+\/post\//.test(location.pathname);
}

// Sends startDownload with source:'pawchive' so background routes to startPawchiveDownload.
function handlePawDownload(btn, service, userId, postId, path, isCreatorPage) {
  if (btn.disabled) return;
  updateButtonStatus(btn, 'SCANNING', null, isCreatorPage);

  safeSendMessage(
    { action: 'startDownload', service, userId, postId, path, source: 'pawchive' },
    7000,
    { retries: 2, retryDelay: 400 }
  ).then((ack) => {
    if (!ack || !ack.accepted) {
      updateButtonStatus(btn, 'ERROR', '✗ Not accepted', isCreatorPage);
      setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, isCreatorPage); }, 2000);
      return;
    }

    updateButtonStatus(btn, 'SENDING', null, isCreatorPage);

    const WATCHDOG = 10 * 60 * 1000;
    let watchdog = null;
    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        try { chrome.runtime.onMessage.removeListener(onComplete); } catch (_) {}
        if (btn.getAttribute('data-status') === 'SENDING') {
          updateButtonStatus(btn, 'ERROR', '✗ Timeout', isCreatorPage);
          setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, isCreatorPage); }, 2000);
        }
      }, WATCHDOG);
    };

    const onComplete = (message) => {
      try {
        if (!message) return;
        if (message.action === 'downloadProgress') {
          if (message.service !== service || message.userId !== userId || message.postId !== postId) return;
          resetWatchdog();
          return;
        }
        if (message.action !== 'downloadComplete') return;
        if (message.service !== service || message.userId !== userId || message.postId !== postId) return;

        const result = message.result || {};
        if (result.externalLinks && result.externalLinks.length > 0) showExternalLinksModal(result.externalLinks);

        if (result.success) {
          const noFiles = result.noFiles === true;
          const anyDownloaded = noFiles || result.backend === true ||
            (typeof result.successCount === 'number' && result.successCount > 0) ||
            (Array.isArray(result.results) && result.results.some(r => r && r.success));

          if (result.alreadyDownloaded) {
            updateButtonStatus(btn, 'SUCCESS', '✓ Downloaded', isCreatorPage);
            btn.disabled = true;
          } else if (anyDownloaded) {
            if (noFiles) {
              updateButtonStatus(btn, 'SUCCESS', isCreatorPage ? null : 'No files', isCreatorPage);
              if (isCreatorPage) btn.title = 'No downloadable files';
            } else {
              updateButtonStatus(btn, 'SUCCESS', null, isCreatorPage);
            }
            if (!isCreatorPage) {
              if (!noFiles) setTimeout(() => { btn.disabled = false; setTimeout(() => updateButtonStatus(btn, 'IDLE', null, false), 2000); }, 200);
              else btn.disabled = false;
            } else {
              btn.disabled = true;
            }
          } else {
            if (isCreatorPage) btn.title = 'No downloadable files';
            else updateButtonStatus(btn, 'SUCCESS', 'No files', false);
            btn.disabled = false;
            setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000);
          }
        } else {
          const errMsg = result.error || 'Download failed';
          updateButtonStatus(btn, 'ERROR', `✗ ${errMsg}`, isCreatorPage);
          setTimeout(() => { btn.disabled = false; setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000); }, 2000);
        }
      } finally {
        try { chrome.runtime.onMessage.removeListener(onComplete); } catch (_) {}
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      }
    };

    chrome.runtime.onMessage.addListener(onComplete);
    resetWatchdog();
  }).catch((err) => {
    updateButtonStatus(btn, 'ERROR', `✗ ${err && err.message ? err.message : 'Error'}`, isCreatorPage);
    setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, isCreatorPage); }, 2000);
  });
}

// --- Post page: inject a "Download" button into .post__actions ---
async function addPawPostButton() {
  const container = document.querySelector('.post__actions');
  if (!container) return;
  if (container.querySelector('[data-batch-download="true"]')) return;

  const parsed = parseUrlPath(location.pathname);
  if (!parsed || !parsed.postId) return;

  const btn = document.createElement('button');
  btn.className = 'button _button_e60d849 batch-download-btn';
  btn.type = 'button';
  btn.setAttribute('data-batch-download', 'true');
  updateButtonStatus(btn, 'IDLE', null, false);

  try {
    const downloaded = await isPostDownloaded(parsed.service, parsed.userId, parsed.postId);
    if (downloaded) {
      updateButtonStatus(btn, 'SUCCESS', '✓ Downloaded', false);
      btn.disabled = true;
    }
  } catch (_) {}

  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    handlePawDownload(btn, parsed.service, parsed.userId, parsed.postId, location.pathname, false);
  });

  container.appendChild(btn);
}

// --- Creator page: inject per-card download buttons ---
async function addPawCreatorButtons() {
  for (const article of document.querySelectorAll('article.post-card')) {
    const a = article.querySelector('a.image-link, a[href*="/post/"]');
    if (!a) continue;

    const href = a.getAttribute('href') || a.href;
    const path = new URL(new URL(href, location.origin).href).pathname;
    const parsed = parseUrlPath(path);
    if (!parsed || !parsed.postId) continue;

    const container = a;
    if (container.querySelector('[data-batch-download="true"]')) continue;

    const isDone = await isPostDownloaded(parsed.service, parsed.userId, parsed.postId).catch(() => false);
    const btn = document.createElement('div');
    btn.textContent = isDone ? '✓' : '↓';
    btn.className = 'kemono-creator-btn';
    btn.setAttribute('data-batch-download', 'true');
    btn.setAttribute('data-path', path);
    btn.title = isDone ? 'Already downloaded' : 'Click to download';

    article.style.position = 'relative';
    container.appendChild(btn);

    if (!isDone) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        handlePawDownload(btn, parsed.service, parsed.userId, parsed.postId, path, true);
      });
    }
  }
}

// --- Creator page: "Page Fetch" button ---
function addPawPageFetchButton() {
  const header = document.querySelector('.user-header__actions');
  if (!header) return;
  if (header.querySelector('.kemono-download-all[data-batch-download="true"]')) return;

  const parsed = parseUrlPath(location.pathname);
  if (!parsed) return;

  const btn = document.createElement('button');
  btn.className = 'kemono-download-all button _button_e60d849';
  btn.type = 'button';
  btn.setAttribute('data-batch-download', 'true');
  btn.textContent = 'Page Fetch';
  btn.title = 'Download all posts on this page';
  btn.style.margin = '0';
  btn.style.padding = '0';

  header.appendChild(btn);

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;

    const items = [];
    for (const article of document.querySelectorAll('article.post-card')) {
      const a = article.querySelector('a.image-link, a[href*="/post/"]');
      if (!a) continue;
      const href = a.getAttribute('href') || a.href;
      const path = new URL(new URL(href, location.origin).href).pathname;
      const p = parseUrlPath(path);
      if (!p || !p.postId) continue;
      const done = await isPostDownloaded(p.service, p.userId, p.postId).catch(() => false);
      if (!done) items.push({ service: p.service, userId: p.userId, postId: p.postId, source: 'pawchive' });
    }

    if (items.length === 0) {
      updateButtonStatus(btn, 'SUCCESS', '✓ All done', false);
      setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, false); }, 2000);
      return;
    }

    const service = parsed.service;
    const userId = parsed.userId;
    let total = items.length;
    let completed = 0;
    let successCount = 0;

    const onBatchMessage = (message) => {
      if (!message) return;
      if (message.action === 'downloadProgress' && message.batch) {
        if (message.service !== service || message.userId !== userId) return;
        total = message.totalCount || total;
        btn.title = `Sending ${message.sentCount || 0}/${total}`;
        return;
      }
      if (message.action !== 'downloadComplete') return;
      if (message.service !== service || message.userId !== userId) return;
      completed++;
      if (message.result && message.result.success) successCount++;
      btn.textContent = `ACK ${completed}/${total}`;
      if (completed >= total) {
        try { chrome.runtime.onMessage.removeListener(onBatchMessage); } catch (_) {}
        if (successCount > 0) {
          updateButtonStatus(btn, 'SUCCESS', `✓ ${successCount}/${total}`, false);
          btn.disabled = true;
        } else {
          updateButtonStatus(btn, 'ERROR', '✗ Failed', false);
          setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, false); }, 2000);
        }
      }
    };

    chrome.runtime.onMessage.addListener(onBatchMessage);
    updateButtonStatus(btn, 'SENDING', `Dispatching ${items.length}...`, false);

    try {
      const ack = await safeSendMessage({ action: 'startDownloadBatch', items }, 10000, { retries: 2, retryDelay: 400 });
      if (!ack || (!ack.accepted && !ack.success)) throw new Error('No ack');
      updateButtonStatus(btn, 'SENDING', 'Dispatched, awaiting ACK...', false);
    } catch (err) {
      try { chrome.runtime.onMessage.removeListener(onBatchMessage); } catch (_) {}
      updateButtonStatus(btn, 'ERROR', '✗ No ack', false);
      setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, false); }, 2000);
    }
  });
}

function reportPawAccess() {
  try {
    const m = location.pathname.match(/\/([^\/]+)\/user\/([^\/]+)/);
    if (!m) return;
    chrome.runtime.sendMessage({ action: 'creator.recordAccess', service: m[1], userId: m[2] }, () => {});
  } catch (_) {}
}

function initPaw() {
  reportPawAccess();
  if (isPawPostPage()) {
    addPawPostButton();
  } else {
    addPawCreatorButtons();
    addPawPageFetchButton();
  }
}

// Re-run injection after navigation, with a short debounce so DOM settles first.
let _pawNavTimer = null;
function onPawNavigate() {
  if (_pawNavTimer) clearTimeout(_pawNavTimer);
  _pawNavTimer = setTimeout(() => {
    _pawNavTimer = null;
    // Remove stale buttons so initPaw can re-inject cleanly.
    document.querySelectorAll('[data-batch-download="true"]').forEach(b => b.remove());
    initPaw();
  }, 350);
}

function observePawNavigation() {
  let lastUrl = location.href;

  const checkUrl = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onPawNavigate();
    }
  };

  // pushState / replaceState interception (HTMX uses these for history)
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...a) { origPush(...a); checkUrl(); };
  history.replaceState = function (...a) { origReplace(...a); checkUrl(); };

  window.addEventListener('popstate', checkUrl);

  // HTMX fires htmx:afterSettle once the swapped content is in the DOM.
  document.addEventListener('htmx:afterSettle', onPawNavigate);

  // Fallback: MutationObserver watching for the key containers appearing.
  const mo = new MutationObserver(() => checkUrl());
  mo.observe(document.body, { childList: true, subtree: true });
}

setTimeout(initPaw, 300);
observePawNavigation();
