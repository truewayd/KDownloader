// content/ui.js - shared injected components and state rendering

const KD_ACTION_TAG = KDComponents.ACTION_TAG;
const KD_CREATOR_BUTTON_SELECTOR = `${KD_ACTION_TAG}[variant="creator"][data-batch-download="true"]`;
const KD_POST_BUTTON_SELECTOR = `${KD_ACTION_TAG}[data-kd-role="post-download"]`;
const KD_PAGE_FETCH_BUTTON_SELECTOR = `${KD_ACTION_TAG}[data-kd-role="page-fetch"]`;

const BTN_STATUS = Object.freeze({
  IDLE: { text: KDI18n.get('downloadActionDecorated'), icon: '↓', disabled: false },
  SCANNING: { text: KDI18n.get('statusFetching'), icon: '↻', disabled: true },
  SENDING: { text: KDI18n.get('statusSending'), icon: '↻', disabled: true },
  PARTIAL: { text: KDI18n.get('statusPartial'), icon: '!', disabled: false },
  SUCCESS: { text: KDI18n.get('statusAllSent'), icon: '✓', disabled: false },
  ERROR: { text: KDI18n.get('statusFailedDecorated'), icon: '×', disabled: false },
});

let kdButtonResetSequence = 0;
let closeActiveExternalLinksModal = null;
const MAX_BUTTON_TEXT_LENGTH = 240;
const MAX_EXTERNAL_LINKS = 500;
const MAX_EXTERNAL_LINK_LENGTH = 8192;

function boundedDisplayText(value, fallback = '') {
  const text = String(value ?? fallback).replace(/[\0\r\n\t]+/g, ' ').trim();
  return text.length <= MAX_BUTTON_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_BUTTON_TEXT_LENGTH - 1)}…`;
}

function updateButtonStatus(btn, statusKey, customText = null, isCreatorPage = false) {
  const status = BTN_STATUS[statusKey];
  if (!status || !btn) return;

  const label = boundedDisplayText(customText || status.text, status.text);
  delete btn.dataset.kdResetToken;
  btn.dataset.status = statusKey;
  btn.disabled = status.disabled;
  btn.setAttribute('aria-disabled', String(status.disabled));
  KDComponents.setBusyState(
    btn,
    statusKey === 'SCANNING' || statusKey === 'SENDING',
    { manageDisabled: false }
  );

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

  if (!button) button = document.createElement(KD_ACTION_TAG);

  button.type = 'button';
  button.setAttribute('variant', options.variant || 'action');
  button.className = classNames.filter(Boolean).join(' ');
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

  if (!button) {
    button = document.createElement(KD_ACTION_TAG);
    container.appendChild(button);
  }

  button.type = 'button';
  button.setAttribute('variant', 'creator');
  button.className = extraClassNames.filter(Boolean).join(' ');
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

function configureCreatorDownloadButton(button, historyStatus, onDownload) {
  if (!button) return;
  const downloaded = isHandledDownloadedStatus(historyStatus);
  const partial = historyStatus === 'partial';
  const label = downloaded
    ? KDI18n.get('alreadyDownloadedTooltip')
    : (partial ? KDI18n.get('partiallyDownloadedTooltip') : KDI18n.get('clickToDownloadTooltip'));
  updateButtonStatus(button, downloaded ? 'SUCCESS' : (partial ? 'PARTIAL' : 'IDLE'), label, true);
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
    const historyStatus = await getPostDownloadedStatus(
      parsed.service,
      parsed.userId,
      parsed.postId,
      { source }
    );
    if (!isRenderCurrent(context)) return null;
    if (isHandledDownloadedStatus(historyStatus)) {
      updateButtonStatus(button, 'SUCCESS', KDI18n.get('statusDownloadedDecorated'), false);
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    } else if (historyStatus === 'partial') {
      updateButtonStatus(button, 'PARTIAL', KDI18n.get('partiallyDownloadedTooltip'), false);
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
    const historyStatus = downloaded.get(key) || null;
    const button = ensureCreatorDownloadButton(
      container,
      entry.path,
      typeof options.getClassNames === 'function' ? options.getClassNames(entry) : []
    );
    if (isActiveDownloadButton(button)) continue;

    ensurePositionContext(container);
    if (options.decorateContainer) options.decorateContainer(container, entry);
    configureCreatorDownloadButton(button, historyStatus, () =>
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
  if (!document.body) return;
  const normalizedLinks = [];
  const seen = new Set();
  for (const value of Array.isArray(links) ? links : []) {
    if (normalizedLinks.length >= MAX_EXTERNAL_LINKS) break;
    const link = String(value || '').trim();
    if (!link || link.length > MAX_EXTERNAL_LINK_LENGTH) continue;
    try {
      const url = new URL(link);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        continue;
      }
      const normalized = url.href;
      if (normalized.length > MAX_EXTERNAL_LINK_LENGTH || seen.has(normalized)) continue;
      seen.add(normalized);
      normalizedLinks.push(normalized);
    } catch (error) {
      /* Ignore malformed links from host-page content. */
    }
  }
  if (normalizedLinks.length === 0) return;

  closeActiveExternalLinksModal?.();
  const previousFocus = document.activeElement;
  const dialog = document.createElement(KDComponents.LINKS_DIALOG_TAG);
  dialog.id = 'kd-external-links-modal';
  let removalObserver = null;
  const lifecycleController = typeof AbortController === 'function' ? new AbortController() : null;
  const finish = () => {
    lifecycleController?.abort();
    removalObserver?.disconnect();
    removalObserver = null;
    if (closeActiveExternalLinksModal === close) closeActiveExternalLinksModal = null;
  };
  const close = () => dialog.close();
  dialog.addEventListener('kd-close', finish, { once: true });
  const lifecycleSignal = lifecycleController?.signal;
  window.addEventListener('pagehide', close, { once: true, signal: lifecycleSignal });
  window.addEventListener(EXTENSION_CONTEXT_INVALIDATED_EVENT, close, {
    once: true,
    signal: lifecycleSignal,
  });
  closeActiveExternalLinksModal = close;

  document.body.appendChild(dialog);
  if (typeof MutationObserver === 'function') {
    removalObserver = new MutationObserver(() => {
      if (!dialog.isConnected) finish();
    });
    removalObserver.observe(document.body, { childList: true });
  }
  dialog.show({
    title: KDI18n.get('externalLinksTitle'),
    description: KDI18n.get('externalLinksDescription'),
    links: normalizedLinks,
    closeLabel: KDI18n.get('closeAction'),
    returnFocus: previousFocus,
  });
}
