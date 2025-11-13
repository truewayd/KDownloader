// content/actions.js - DOM actions: insert buttons, observe SPA navigation, and message handling

// Add download button to post page
async function addPostButton() {
  removeOldButtons();

  const container = document.querySelector('.post__actions') || document.querySelector('.post__header');
  if (!container) {
    console.log("[Content] Post actions container not found");
    return;
  }

  const btn = document.createElement('button');
  btn.className = 'button _button_e60d849 batch-download-btn';
  btn.type = 'button';
  btn.setAttribute('data-batch-download', 'true');
  // Styling handled via content.css

  const path = location.pathname;
  const parsed = parseUrlPath(path);

  // Set initial state
  updateButtonStatus(btn, 'IDLE', null, false);

  if (parsed && parsed.postId) {
    // Check if already downloaded
    try {
      const downloaded = await isPostDownloaded(parsed.service, parsed.userId, parsed.postId);
      if (downloaded) {
        updateButtonStatus(btn, 'SUCCESS', '✓ Downloaded', false);
        btn.disabled = true;
      }
    } catch (error) {
      console.warn('[Content] Failed to check download status:', error);
    }
  }

  btn.addEventListener('mouseenter', function () {
    if (!this.disabled) this.classList.add('kemono-btn-hover');
  });

  btn.addEventListener('mouseleave', function () {
    this.classList.remove('kemono-btn-hover');
  });

  btn.addEventListener('click', () => {
    if (btn.disabled) return;

    if (parsed && parsed.postId) {
      handleDownload(btn, parsed.service, parsed.userId, parsed.postId, path, false);
    } else {
      console.error("[Content] Failed to parse URL path");
      updateButtonStatus(btn, 'ERROR', '✗ Invalid URL', false);
    }
  });

  container.appendChild(btn);
  console.log("[Content] Post button inserted");
}

// Add download buttons to creator page
async function addCreatorButtons() {
  // Reconcile existing buttons: remove buttons whose articles are gone
  const articles = Array.from(document.querySelectorAll('article.post-card.post-card--preview, article.post-card'));
  const paths = new Set();
  for (const article of articles) {
    const a = article.querySelector('a.fancy-link, a[href*="/post/"], a.post__link');
    if (!a) continue;
    const href = a.getAttribute('href') || a.href;
    const fullUrl = new URL(href, location.origin).href;
    const path = new URL(fullUrl).pathname;
    paths.add(path);
  }

  // Remove stale buttons not attached to current articles
  document.querySelectorAll('.kemono-creator-btn[data-batch-download="true"]').forEach(btn => {
    const p = btn.getAttribute('data-path');
    if (!paths.has(p)) btn.remove();
  });

  for (const article of articles) {
    const a = article.querySelector('a.fancy-link, a[href*="/post/"], a.post__link');
    if (!a) continue;

    const href = a.getAttribute('href') || a.href;
    const fullUrl = new URL(href, location.origin).href;
    const path = new URL(fullUrl).pathname;
    const parsed = parseUrlPath(path);

    if (!parsed || !parsed.postId) continue;

    try {
      const isDone = await isPostDownloaded(parsed.service, parsed.userId, parsed.postId);
      const symbol = isDone ? '✓' : '↓';
      const title = isDone ? 'Already downloaded' : 'Click to download';

      // Place button inside the anchor to match requested layout
      const container = a;

      // If a button already exists inside this container, update it and continue
      const existing = container.querySelector('[data-batch-download="true"]');
      if (existing) {
        existing.textContent = symbol;
        existing.title = title;
        // ensure article still positioned for absolute placement
        article.style.position = 'relative';
        continue;
      }

      const btn = document.createElement('div');
      btn.textContent = symbol;
      btn.className = 'kemono-creator-btn';
      // Keep color consistent (white) via CSS - do not set dynamic color here
      btn.setAttribute('data-batch-download', 'true');
      btn.setAttribute('data-path', path);
      btn.title = title;

      article.style.position = 'relative';
      container.appendChild(btn);

      if (!isDone) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (btn.disabled) return;
          handleDownload(btn, parsed.service, parsed.userId, parsed.postId, path, true);
        });
      }
    } catch (error) {
      console.warn('[Content] Failed to check download status for article:', error);
    }
  }

  console.log('[Content] Creator buttons reconciled');
}

// Check if on creator page
function isCreatorPage() {
  return !location.pathname.includes('/post/');
}

// Add a button to creator header actions
function addDownloadAllButton() {
  try {
    const header = document.querySelector('.user-header__actions');
    if (!header) return;

    // Avoid duplicating the button
    const existing = header.querySelector('.kemono-download-all[data-batch-download="true"]');
    if (existing) return;

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
      const parsedPage = parseUrlPath(location.pathname);
      if (!parsedPage) {
        updateButtonStatus(btn, 'ERROR', '✗ Invalid page', false);
        setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, false); }, 2000);
        return;
      }

      const service = parsedPage.service;
      const userId = parsedPage.userId;

      // require backend configured to avoid many browser downloads
      try {
        const cfg = await safeSendMessage({ action: 'backend.getConfig' }, 3000, { retries: 1, retryDelay: 200 });
        if (!cfg || !cfg.success || !cfg.config || !cfg.config.enabled) {
          updateButtonStatus(btn, 'ERROR', 'Please enable backend first', false);
          setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, false); }, 2500);
          return;
        }
      } catch (err) {
        console.warn('[Content] backend.getConfig failed', err);
        updateButtonStatus(btn, 'ERROR', 'Backend check failed', false);
        setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, false); }, 2000);
        return;
      }

      // Determine offset from current URL (?o=)
      const offsetParam = (new URL(location.href)).searchParams.get('o');
      const offset = offsetParam ? Number(offsetParam) : null;

      updateButtonStatus(btn, 'SENDING', `Dispatching page...`, false);

      // Listen for progress & completion from background (scoped by service/user)
      let total = null;
      let completed = 0;
      let successCount = 0;

      const onBatchMessage = (message) => {
        if (!message) return;
        if (message.action === 'downloadProgress' && message.batch) {
          if (message.service !== service || message.userId !== userId) return;
          total = message.totalCount || total;
          const sent = message.sentCount || 0;
          if (!isCreatorPage) btn.textContent = `Sending ${sent}/${total || '?'} `; else btn.title = `Sending ${sent}/${total || '?'} `;
          return;
        }

        if (message.action !== 'downloadComplete') return;
        if (message.service !== service || message.userId !== userId) return;

        completed++;
        const res = message.result || {};
        if (res.success) successCount++;
        btn.textContent = `ACK ${completed}/${total || '?'} `;

        // when we know total and completed >= total, finalize
        if (total && completed >= total) {
          try { chrome.runtime.onMessage.removeListener(onBatchMessage); } catch (e) { }
          if (successCount > 0) {
            updateButtonStatus(btn, 'SUCCESS', `✓ ${successCount}/${total}`, true);
            btn.disabled = true;
          } else {
            updateButtonStatus(btn, 'ERROR', '✗ Failed', true);
            setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, true); }, 2000);
          }
        }
      };

      chrome.runtime.onMessage.addListener(onBatchMessage);

      // send request to background to fetch this page's posts & dispatch
      try {
        const ack = await safeSendMessage({ action: 'creator.pageFetch', service, userId, offset }, 7000, { retries: 2, retryDelay: 400 });
        if (ack && (ack.accepted || ack.success)) {
          updateButtonStatus(btn, 'SENDING', 'Dispatched, awaiting progress...', false);
        } else {
          throw new Error('No ack');
        }
      } catch (err) {
        try { chrome.runtime.onMessage.removeListener(onBatchMessage); } catch (e) { }
        console.warn('[Content] creator.pageFetch ack failed', err);
        updateButtonStatus(btn, 'ERROR', '✗ No ack', false);
        setTimeout(() => { btn.disabled = false; updateButtonStatus(btn, 'IDLE', null, false); }, 2000);
      }

    });

  } catch (e) {
    console.warn('[Content] addDownloadAllButton error', e);
  }
}

function initializeScript() {
  if (isCreatorPage()) {
    addCreatorButtons();
    addDownloadAllButton();
  } else {
    addPostButton();
  }
}


// Observe page changes for SPA navigation
function observePageChanges() {
  let lastUrl = location.href;

  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(initializeScript, CONFIG.INIT_DELAY);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// Wait for page elements to load
function waitForElements() {
  const checkInterval = setInterval(() => {
    const hasContent = isCreatorPage()
      ? document.querySelectorAll('article.post-card.post-card--preview, article.post-card').length > 0
      : document.querySelector('.post__actions') !== null || document.querySelector('.post__header') !== null;

    if (hasContent) {
      clearInterval(checkInterval);
      // Record access when content is ready
      reportAccessIfApplicable();
      initializeScript();
      observePageChanges();
    }
  }, 500);

  setTimeout(() => {
    clearInterval(checkInterval);
    reportAccessIfApplicable();
    initializeScript();
    observePageChanges();
  }, 10000);
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateUI') {
    reportAccessIfApplicable();
    initializeScript();
  }

  if (message.action === 'downloadProgress') {
    // Handle progress updates if needed
    console.log('[Content] Download progress:', message.data);
  }
});

// Start the script
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', waitForElements);
} else {
  setTimeout(waitForElements, CONFIG.INIT_DELAY);
}

console.log('[Content] Script initialized');
