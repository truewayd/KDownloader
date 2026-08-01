// content/ui.js - shared injected components and state rendering

const KD_CREATOR_BUTTON_SELECTOR = [
  '.kd-creator-button[data-batch-download="true"]',
  '.kemono-creator-btn[data-batch-download="true"]',
].join(', ');

const KD_POST_BUTTON_SELECTOR = [
  '[data-kd-role="post-download"]',
  '.batch-download-btn[data-batch-download="true"]',
].join(', ');

const KD_PAGE_FETCH_BUTTON_SELECTOR = [
  '[data-kd-role="page-fetch"]',
  '.kemono-download-all[data-batch-download="true"]',
].join(', ');

const BTN_STATUS = Object.freeze({
  IDLE: { text: KDI18n.get('downloadActionDecorated'), icon: '↓', disabled: false },
  SCANNING: { text: KDI18n.get('statusFetching'), icon: '↻', disabled: true },
  SENDING: { text: KDI18n.get('statusSending'), icon: '↻', disabled: true },
  SUCCESS: { text: KDI18n.get('statusAllSent'), icon: '✓', disabled: false },
  ERROR: { text: KDI18n.get('statusFailedDecorated'), icon: '×', disabled: false },
});

let kdButtonResetSequence = 0;
let closeActiveExternalLinksModal = null;

function updateButtonStatus(btn, statusKey, customText = null, isCreatorPage = false) {
  const status = BTN_STATUS[statusKey];
  if (!status || !btn) return;

  const label = customText || status.text;
  delete btn.dataset.kdResetToken;
  btn.dataset.status = statusKey;
  btn.disabled = status.disabled;
  btn.setAttribute('aria-disabled', String(status.disabled));
  btn.setAttribute('aria-busy', String(statusKey === 'SCANNING' || statusKey === 'SENDING'));

  if (isCreatorPage) {
    btn.textContent = status.icon;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  } else {
    btn.textContent = label;
  }
}

function scheduleButtonReset(btn, customText = null, isCreatorPage = false, delayMs = 2000) {
  if (!btn) return;
  const token = String(++kdButtonResetSequence);
  btn.dataset.kdResetToken = token;
  setTimeout(() => {
    if (btn.dataset.kdResetToken !== token) return;
    updateButtonStatus(btn, 'IDLE', customText, isCreatorPage);
  }, delayMs);
}

function showTransientButtonStatus(
  btn,
  statusKey,
  customText = null,
  isCreatorPage = false,
  resetText = null,
  delayMs = 2000
) {
  updateButtonStatus(btn, statusKey, customText, isCreatorPage);
  scheduleButtonReset(btn, resetText, isCreatorPage, delayMs);
}

function ensureKdButton(container, selector, options = {}) {
  if (!container) return { button: null, isNew: false };

  const classNames = Array.isArray(options.classNames) ? options.classNames : [];
  const attributes = options.attributes || {};
  let button = container.querySelector(selector);
  let isNew = !button;

  if (button && button.tagName !== 'BUTTON') {
    const replacement = document.createElement('button');
    button.replaceWith(replacement);
    button = replacement;
  }
  if (!button) button = document.createElement('button');

  button.type = 'button';
  button.className = ['kd-action-button', ...classNames].filter(Boolean).join(' ');
  button.setAttribute('aria-live', 'polite');
  for (const [name, value] of Object.entries(attributes)) {
    button.setAttribute(name, String(value));
  }

  if (isNew && options.append !== false) container.appendChild(button);
  return { button, isNew };
}

function ensureCreatorDownloadButton(container, path, extraClassNames = []) {
  const existing = findDownloadButtonByPath(container, KD_CREATOR_BUTTON_SELECTOR, path);
  let button = existing;

  if (button && button.tagName !== 'BUTTON') {
    const replacement = document.createElement('button');
    button.replaceWith(replacement);
    button = replacement;
  }
  if (!button) {
    button = document.createElement('button');
    container.appendChild(button);
  }

  button.type = 'button';
  button.className = ['kd-creator-button', ...extraClassNames].filter(Boolean).join(' ');
  button.setAttribute('aria-live', 'polite');
  button.setAttribute('data-batch-download', 'true');
  button.setAttribute('data-path', path);
  if (button.parentElement !== container) container.appendChild(button);
  return button;
}

function ensurePageFetchButton(container) {
  const { button } = ensureKdButton(container, KD_PAGE_FETCH_BUTTON_SELECTOR, {
    classNames: ['kd-page-fetch-button'],
    attributes: { 'data-batch-download': 'true', 'data-kd-role': 'page-fetch' },
  });
  if (!button) return null;
  if (!button.dataset.kdInitialized) {
    button.textContent = KDI18n.get('pageFetchAction');
    button.title = KDI18n.get('pageFetchTooltip');
    button.dataset.kdInitialized = 'true';
  }
  return button;
}

function configureCreatorDownloadButton(button, downloaded, onDownload) {
  if (!button) return;
  const label = downloaded
    ? KDI18n.get('alreadyDownloadedTooltip')
    : KDI18n.get('clickToDownloadTooltip');
  updateButtonStatus(button, downloaded ? 'SUCCESS' : 'IDLE', label, true);
  button.disabled = downloaded;
  button.setAttribute('aria-disabled', String(downloaded));
  button.onclick = downloaded
    ? null
    : (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!button.disabled) onDownload(event);
      };
}

async function renderPostDownloadButton(context, options = {}) {
  const {
    container,
    parsed,
    path = location.pathname,
    source,
    creatorName,
    classNames = [],
    place,
  } = options;
  if (!container || !parsed?.service || !parsed?.userId || !parsed?.postId) return null;

  const { button, isNew } = ensureKdButton(container, KD_POST_BUTTON_SELECTOR, {
    classNames: ['kd-download-button', ...classNames],
    attributes: { 'data-batch-download': 'true', 'data-kd-role': 'post-download' },
    append: false,
  });
  if (!button) return null;

  button.dataset.path = path;
  button.onclick = () => {
    if (button.disabled) return;
    handleDownload(button, parsed.service, parsed.userId, parsed.postId, path, false, {
      source,
      creatorName,
    });
  };

  if (!isActiveDownloadButton(button)) {
    updateButtonStatus(button, 'IDLE', null, false);
    const downloaded = await isPostDownloaded(parsed.service, parsed.userId, parsed.postId, { source });
    if (!isRenderCurrent(context)) return null;
    if (downloaded) {
      updateButtonStatus(button, 'SUCCESS', KDI18n.get('statusDownloadedDecorated'), false);
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
  }

  if (isNew) {
    if (typeof place === 'function') place(button);
    else container.appendChild(button);
  }
  return button;
}

async function renderCreatorDownloadButtons(entries, context, options = {}) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  const downloaded = await getDownloadedStatusMap(normalizedEntries);
  if (!isRenderCurrent(context)) return;

  for (const entry of normalizedEntries) {
    const container = typeof options.getContainer === 'function'
      ? options.getContainer(entry)
      : (entry.article || entry.postEl);
    if (!container || !entry.path) continue;

    const source = typeof options.getSource === 'function'
      ? options.getSource(entry)
      : entry.source;
    const key = downloadedKey(entry.service, entry.userId, entry.postId, source);
    const isDone = downloaded.get(key) === true;
    const button = ensureCreatorDownloadButton(
      container,
      entry.path,
      typeof options.getClassNames === 'function' ? options.getClassNames(entry) : []
    );
    if (isActiveDownloadButton(button)) continue;

    ensurePositionContext(container);
    if (options.decorateContainer) options.decorateContainer(container, entry);
    configureCreatorDownloadButton(button, isDone, () =>
      handleDownload(
        button,
        entry.service,
        entry.userId,
        entry.postId,
        entry.path,
        true,
        typeof options.getDownloadOptions === 'function'
          ? options.getDownloadOptions(entry)
          : { source, creatorName: entry.creatorName }
      )
    );
  }
}

function ensurePositionContext(element) {
  element?.classList.add('kd-position-context');
}

function showExternalLinksModal(links) {
  const normalizedLinks = Array.from(new Set(Array.isArray(links) ? links : []))
    .map((link) => String(link || '').trim())
    .filter((link) => {
      try {
        const url = new URL(link);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch (error) {
        return false;
      }
    });
  if (normalizedLinks.length === 0) return;

  closeActiveExternalLinksModal?.();
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.id = 'kd-external-links-modal';
  overlay.className = 'kd-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'kd-external-links-title');
  overlay.setAttribute('aria-describedby', 'kd-external-links-description');

  const modal = document.createElement('div');
  modal.className = 'kd-modal';

  const title = document.createElement('h3');
  title.id = 'kd-external-links-title';
  title.className = 'kd-modal-title';
  title.textContent = KDI18n.get('externalLinksTitle');

  const description = document.createElement('p');
  description.id = 'kd-external-links-description';
  description.className = 'kd-modal-description';
  description.textContent = KDI18n.get('externalLinksDescription');

  const list = document.createElement('ul');
  list.className = 'kd-modal-list';
  for (const link of normalizedLinks) {
    const item = document.createElement('li');
    item.className = 'kd-modal-list-item';
    const anchor = document.createElement('a');
    anchor.className = 'kd-modal-link';
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link;
    item.appendChild(anchor);
    list.appendChild(item);
  }

  const closeButton = document.createElement('button');
  closeButton.className = 'kd-action-button kd-modal-close';
  closeButton.type = 'button';
  closeButton.textContent = KDI18n.get('closeAction');

  const close = () => {
    document.removeEventListener('keydown', handleKeydown);
    overlay.remove();
    closeActiveExternalLinksModal = null;
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
      previousFocus.focus({ preventScroll: true });
    }
  };
  const handleKeydown = (event) => {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(modal.querySelectorAll('a[href], button:not(:disabled)'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', handleKeydown);
  closeActiveExternalLinksModal = close;

  modal.append(title, description, list, closeButton);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  closeButton.focus({ preventScroll: true });
}
