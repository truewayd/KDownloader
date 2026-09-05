// content/download.js - download request and progress state machines

const DOWNLOAD_WATCHDOG_MS = 10 * 60 * 1000;
const MAX_ACTIVE_DOWNLOAD_REQUESTS = 512;
const activeDownloadRequests = new Map();
let downloadRequestSequence = 0;

function createDownloadRequestId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `content:${uuid}`;
  } catch (error) {
    /* Fall back to the per-document sequence below. */
  }
  downloadRequestSequence += 1;
  return `content:${Date.now()}:${downloadRequestSequence}`;
}

function matchesPostMessage(message, service, userId, postId) {
  return message?.service === service
    && message?.userId === userId
    && message?.postId === postId;
}

function pruneActiveDownloadRequests() {
  for (const entry of activeDownloadRequests.values()) {
    if (entry.button?.isConnected === false) entry.cleanup();
  }
}

function registerActiveDownloadRequest({ requestId, button, timeoutMs, onMessage, onTimeout, onCancel }) {
  pruneActiveDownloadRequests();
  if (activeDownloadRequests.size >= MAX_ACTIVE_DOWNLOAD_REQUESTS) {
    throw new Error('Too many active download requests');
  }

  const entry = {
    requestId,
    button,
    timer: null,
    cleanup() {
      if (activeDownloadRequests.get(requestId) !== entry) return;
      activeDownloadRequests.delete(requestId);
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    },
    resetWatchdog() {
      if (activeDownloadRequests.get(requestId) !== entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.cleanup();
        onTimeout?.();
      }, timeoutMs);
    },
    onMessage,
    cancel() {
      entry.cleanup();
      onCancel?.();
    },
  };

  activeDownloadRequests.set(requestId, entry);
  entry.resetWatchdog();
  return entry;
}

function dispatchDownloadMessage(message) {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : '';
  if (!requestId) return;
  const entry = activeDownloadRequests.get(requestId);
  if (!entry) return;
  if (entry.button?.isConnected === false) {
    entry.cleanup();
    return;
  }
  try {
    entry.onMessage(message, entry);
  } catch (error) {
    entry.cleanup();
    console.warn('[Content] download message render failed', error);
  }
}

function clearActiveDownloadRequests() {
  for (const entry of Array.from(activeDownloadRequests.values())) entry.cancel();
}

chrome.runtime.onMessage.addListener(dispatchDownloadMessage);
window.addEventListener(EXTENSION_CONTEXT_INVALIDATED_EVENT, clearActiveDownloadRequests, { once: true });
window.addEventListener('pagehide', clearActiveDownloadRequests);

function setDownloadProgressText(button, message, isCreatorPage) {
  let text = null;
  if (typeof message.progress === 'number' && Number.isFinite(message.progress)) {
    text = KDI18n.get('sendingPercent', [Math.round(message.progress)]);
  } else if (typeof message.sentCount === 'number' && typeof message.totalCount === 'number') {
    text = KDI18n.get('sendingCount', [message.sentCount, message.totalCount]);
  }
  if (!text) return;

  if (isCreatorPage) {
    button.title = text;
    button.setAttribute('aria-label', text);
  } else {
    button.textContent = text;
  }
}

function isAcceptedDownloadResult(result) {
  return result.noFiles === true
    || result.backend === true
    || (typeof result.successCount === 'number' && result.successCount > 0)
    || (Array.isArray(result.results) && result.results.some((item) => item?.success));
}

function isPartialDownloadResult(result) {
  if (!isAcceptedDownloadResult(result) || result.noFiles === true) return false;
  const results = Array.isArray(result.results) ? result.results : [];
  const explicitTotalCount = Number(result.totalCount);
  const totalCount = Number.isFinite(explicitTotalCount) ? explicitTotalCount : results.length;
  const successCount = Number(result.successCount);
  const failedCount = Number(result.failedCount);
  return (Number.isFinite(failedCount) && failedCount > 0)
    || (Number.isFinite(totalCount) && Number.isFinite(successCount) && successCount < totalCount);
}

function renderDownloadResult(button, result, isCreatorPage) {
  const externalLinks = Array.isArray(result.externalLinks) ? result.externalLinks : [];
  if (externalLinks.length > 0) showExternalLinksModal(externalLinks);

  if (externalLinks.length > 0 && (result.noFiles === true || result.incomplete === true)) {
    showTransientButtonStatus(
      button,
      'SUCCESS',
      KDI18n.get('externalLinksShown'),
      isCreatorPage
    );
    return;
  }

  if (!result.success) {
    const message = result.error || KDI18n.get('statusFailedDecorated');
    console.error('[Content] downloadComplete error:', message);
    showTransientButtonStatus(button, 'ERROR', `× ${message}`, isCreatorPage);
    return;
  }

  if (result.alreadyDownloaded) {
    updateButtonStatus(
      button,
      'SUCCESS',
      KDI18n.get('statusDownloadedDecorated'),
      isCreatorPage
    );
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    return;
  }

  const accepted = isAcceptedDownloadResult(result);
  const hasUsefulResult = accepted || externalLinks.length > 0;
  const noFilesText = result.noFiles === true || !hasUsefulResult
    ? KDI18n.get('statusNoFiles')
    : null;

  if (isPartialDownloadResult(result)) {
    updateButtonStatus(
      button,
      'PARTIAL',
      KDI18n.get('partiallyDownloadedTooltip'),
      isCreatorPage
    );
    button.disabled = false;
    button.setAttribute('aria-disabled', 'false');
    return;
  }

  if (isCreatorPage && hasUsefulResult && result.noFiles !== true) {
    updateButtonStatus(button, 'SUCCESS', noFilesText, true);
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    return;
  }

  showTransientButtonStatus(button, 'SUCCESS', noFilesText, isCreatorPage);
}

async function handleDownload(
  button,
  service,
  userId,
  postId,
  path,
  isCreatorPage = false,
  options = {}
) {
  if (!button || button.disabled) return;
  updateButtonStatus(button, 'SCANNING', null, isCreatorPage);
  const requestId = createDownloadRequestId();
  let finished = false;
  let entry;

  try {
    entry = registerActiveDownloadRequest({
      requestId,
      button,
      timeoutMs: DOWNLOAD_WATCHDOG_MS,
      onCancel: () => {
        finished = true;
        updateButtonStatus(button, 'IDLE', null, isCreatorPage);
      },
      onTimeout: () => {
        if (finished || button.dataset.status !== 'SENDING') return;
        finished = true;
        console.error('[Content] handleDownload watchdog timed out');
        showTransientButtonStatus(
          button,
          'ERROR',
          `× ${KDI18n.get('errorTimeout')}`,
          isCreatorPage
        );
      },
      onMessage: (message, activeEntry) => {
        if (!matchesPostMessage(message, service, userId, postId)) return;
        if (message.action === 'downloadProgress') {
          if (button.dataset.status === 'SCANNING') {
            updateButtonStatus(button, 'SENDING', null, isCreatorPage);
          }
          setDownloadProgressText(button, message, isCreatorPage);
          activeEntry.resetWatchdog();
          return;
        }
        if (message.action !== 'downloadComplete') return;

        finished = true;
        activeEntry.cleanup();
        renderDownloadResult(button, message.result || {}, isCreatorPage);
      },
    });
  } catch (error) {
    showTransientButtonStatus(button, 'ERROR', `× ${getErrorMessage(error)}`, isCreatorPage);
    return;
  }

  let ack;
  try {
    ack = await safeSendMessage({
      action: 'startDownload',
      service,
      userId,
      postId,
      path,
      source: options.source,
      creatorName: options.creatorName,
      requestId,
    }, 7000, { retries: 0, retryDelay: 0 });
  } catch (error) {
    if (finished) return;
    finished = true;
    entry.cleanup();
    console.error('[Content] startDownload ack error:', getErrorMessage(error));
    showTransientButtonStatus(
      button,
      'ERROR',
      `× ${getErrorMessage(error) || KDI18n.get('errorNoAck')}`,
      isCreatorPage
    );
    return;
  }

  if (finished) return;
  if (!ack?.accepted) {
    finished = true;
    entry.cleanup();
    console.error('[Content] startDownload not accepted by background');
    showTransientButtonStatus(
      button,
      'ERROR',
      KDI18n.get('statusFailedDecorated'),
      isCreatorPage
    );
    return;
  }

  if (button.dataset.status === 'SCANNING') {
    updateButtonStatus(button, 'SENDING', null, isCreatorPage);
  }
}

async function runPageFetchWithProgress(options) {
  const {
    btn,
    service,
    userId,
    requestMessage,
    initialText,
    ackText,
    resetText = KDI18n.get('pageFetchAction'),
    total: initialTotal = null,
    timeoutMs = DOWNLOAD_WATCHDOG_MS,
    renderProgress,
    renderComplete,
  } = options || {};
  if (!btn || !service || !userId || !requestMessage) return;

  let total = initialTotal;
  let completed = 0;
  let successCount = 0;
  const completedItems = new Set();
  let finished = false;
  let entry;
  const requestId = createDownloadRequestId();

  const state = () => ({ total, completed, successCount });
  const finish = (status, text, keepDisabled) => {
    if (finished) return;
    finished = true;
    entry?.cleanup();
    if (keepDisabled) {
      updateButtonStatus(btn, status, text, false);
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    } else {
      showTransientButtonStatus(btn, status, text, false, resetText);
    }
  };

  const finishBatch = (result) => {
    if (Number.isSafeInteger(result.totalCount) && result.totalCount >= 0) total = result.totalCount;
    if (Number.isSafeInteger(result.successCount) && result.successCount >= 0) successCount = result.successCount;
    if (result.error || (result.success === false && successCount === 0)) {
      finish('ERROR', result.error ? `× ${result.error}` : KDI18n.get('statusFailedDecorated'), false);
      return;
    }
    if (total === 0) {
      finish('SUCCESS', KDI18n.get('statusAllDoneDecorated'), false);
      return;
    }
    if (total && successCount === total) finish('SUCCESS', `✓ ${successCount}/${total}`, true);
    else if (successCount > 0) finish('PARTIAL', `! ${successCount}/${total ?? '?'}`, false);
    else finish('ERROR', KDI18n.get('statusFailedDecorated'), false);
  };

  const onBatchMessage = (message, activeEntry) => {
    if (finished || !message) return;
    if (message.service !== service || message.userId !== userId) return;
    if (message.action !== 'downloadProgress' && message.action !== 'downloadComplete') return;

    if (message.error) {
      finish('ERROR', `× ${message.error}`, false);
      return;
    }
    activeEntry.resetWatchdog();

    if (message.action === 'downloadProgress') {
      if (!message.batch) return;
      if (Number.isFinite(message.totalCount) && message.totalCount >= 0) total = message.totalCount;
      if (typeof renderProgress === 'function') {
        renderProgress({ btn, message, state: state(), finish });
      } else {
        btn.textContent = KDI18n.get('sendingCount', [message.sentCount || 0, total ?? '?']);
      }
      return;
    }

    if (message.batch) {
      finishBatch(message.result || {});
      return;
    }

    const completionKey = JSON.stringify([
      message.service,
      message.userId,
      message.postId,
    ]);
    if (completedItems.has(completionKey)) return;
    completedItems.add(completionKey);
    completed += 1;
    if (message.result?.success) successCount += 1;
    if (typeof renderComplete === 'function') {
      renderComplete({ btn, message, state: state(), finish });
    } else {
      btn.textContent = KDI18n.get('ackCount', [completed, total ?? '?']);
    }
  };

  try {
    entry = registerActiveDownloadRequest({
      requestId,
      button: btn,
      timeoutMs,
      onMessage: onBatchMessage,
      onTimeout: () => finish('ERROR', `× ${KDI18n.get('errorTimeout')}`, false),
      onCancel: () => {
        finished = true;
        updateButtonStatus(btn, 'IDLE', resetText, false);
      },
    });
  } catch (error) {
    finish('ERROR', `× ${getErrorMessage(error)}`, false);
    return;
  }

  updateButtonStatus(btn, 'SENDING', initialText, false);

  try {
    const ack = await safeSendMessage(
      { ...requestMessage, requestId },
      10000,
      { retries: 0, retryDelay: 0 }
    );
    if (!ack || (!ack.accepted && !ack.success)) throw new Error(ack?.error || 'No ack');
    if (!finished && btn.dataset.status !== 'SUCCESS') {
      updateButtonStatus(btn, 'SENDING', ackText, false);
    }
  } catch (error) {
    finish('ERROR', `× ${getErrorMessage(error) || KDI18n.get('errorNoAck')}`, false);
  }
}
