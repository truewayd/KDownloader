// content/download.js - download request and progress state machines

const DOWNLOAD_WATCHDOG_MS = 10 * 60 * 1000;
let downloadRequestSequence = 0;

function createDownloadRequestId() {
  downloadRequestSequence += 1;
  return `content:${Date.now()}:${downloadRequestSequence}`;
}

function matchesPostMessage(message, service, userId, postId) {
  return message?.service === service
    && message?.userId === userId
    && message?.postId === postId;
}

function setDownloadProgressText(button, message, isCreatorPage) {
  let text = null;
  if (typeof message.progress === 'number') {
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

function renderDownloadResult(button, result, isCreatorPage) {
  const externalLinks = Array.isArray(result.externalLinks) ? result.externalLinks : [];
  if (externalLinks.length > 0) showExternalLinksModal(externalLinks);

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

  if (isCreatorPage && hasUsefulResult) {
    updateButtonStatus(button, 'SUCCESS', noFilesText, true);
    if (result.noFiles === true) {
      button.title = KDI18n.get('noDownloadableFiles');
      button.setAttribute('aria-label', button.title);
    }
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
    }, 7000, { retries: 2, retryDelay: 400 });
  } catch (error) {
    console.error('[Content] startDownload ack error:', getErrorMessage(error));
    showTransientButtonStatus(
      button,
      'ERROR',
      `× ${getErrorMessage(error) || KDI18n.get('errorNoAck')}`,
      isCreatorPage
    );
    return;
  }

  if (!ack?.accepted) {
    console.error('[Content] startDownload not accepted by background');
    showTransientButtonStatus(
      button,
      'ERROR',
      KDI18n.get('statusFailedDecorated'),
      isCreatorPage
    );
    return;
  }

  updateButtonStatus(button, 'SENDING', null, isCreatorPage);
  let watchdogTimer = null;

  const cleanup = () => {
    try {
      chrome.runtime.onMessage.removeListener(onDownloadMessage);
    } catch (error) {
      /* Extension context may have been invalidated. */
    }
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = null;
  };

  const resetWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      cleanup();
      if (button.dataset.status !== 'SENDING') return;
      console.error('[Content] handleDownload watchdog timed out');
      showTransientButtonStatus(
        button,
        'ERROR',
        `× ${KDI18n.get('errorTimeout')}`,
        isCreatorPage
      );
    }, DOWNLOAD_WATCHDOG_MS);
  };

  function onDownloadMessage(message) {
    if (!matchesPostMessage(message, service, userId, postId)) return;
    if (message.requestId && message.requestId !== requestId) return;
    if (message.action === 'downloadProgress') {
      setDownloadProgressText(button, message, isCreatorPage);
      resetWatchdog();
      return;
    }
    if (message.action !== 'downloadComplete') return;

    cleanup();
    renderDownloadResult(button, message.result || {}, isCreatorPage);
  }

  try {
    chrome.runtime.onMessage.addListener(onDownloadMessage);
    resetWatchdog();
  } catch (error) {
    cleanup();
    showTransientButtonStatus(
      button,
      'ERROR',
      `× ${getErrorMessage(error)}`,
      isCreatorPage
    );
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
  let watchdogTimer = null;
  let finished = false;
  const requestId = createDownloadRequestId();

  const state = () => ({ total, completed, successCount });
  const cleanup = () => {
    try {
      chrome.runtime.onMessage.removeListener(onBatchMessage);
    } catch (error) {
      /* Extension context may have been invalidated. */
    }
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = null;
  };

  const finish = (status, text, keepDisabled) => {
    if (finished) return;
    finished = true;
    cleanup();
    if (keepDisabled) {
      updateButtonStatus(btn, status, text, false);
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    } else {
      showTransientButtonStatus(btn, status, text, false, resetText);
    }
  };

  const resetWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      finish('ERROR', `× ${KDI18n.get('errorTimeout')}`, false);
    }, timeoutMs);
  };

  const maybeFinish = () => {
    if (total === 0) {
      finish('SUCCESS', KDI18n.get('statusAllDoneDecorated'), false);
      return true;
    }
    if (total && completed >= total) {
      if (successCount > 0) finish('SUCCESS', `✓ ${successCount}/${total}`, true);
      else finish('ERROR', KDI18n.get('statusFailedDecorated'), false);
      return true;
    }
    return false;
  };

  function onBatchMessage(message) {
    if (finished || !message) return;
    if (message.requestId !== requestId) return;
    if (message.service !== service || message.userId !== userId) return;
    if (message.action !== 'downloadProgress' && message.action !== 'downloadComplete') return;

    if (message.error) {
      finish('ERROR', `× ${message.error}`, false);
      return;
    }
    resetWatchdog();

    if (message.action === 'downloadProgress' && message.batch) {
      if (Number.isFinite(message.totalCount)) total = message.totalCount;
      if (typeof renderProgress === 'function') {
        renderProgress({ btn, message, state: state(), finish });
      } else {
        btn.textContent = KDI18n.get('sendingCount', [message.sentCount || 0, total ?? '?']);
      }
      maybeFinish();
      return;
    }

    completed += 1;
    if (message.result?.success) successCount += 1;
    if (typeof renderComplete === 'function') {
      renderComplete({ btn, message, state: state(), finish });
    } else {
      btn.textContent = KDI18n.get('ackCount', [completed, total ?? '?']);
    }
    maybeFinish();
  }

  chrome.runtime.onMessage.addListener(onBatchMessage);
  updateButtonStatus(btn, 'SENDING', initialText, false);
  resetWatchdog();

  try {
    const ack = await safeSendMessage(
      { ...requestMessage, requestId },
      10000,
      { retries: 2, retryDelay: 400 }
    );
    if (!ack || (!ack.accepted && !ack.success)) throw new Error(ack?.error || 'No ack');
    if (!finished && btn.dataset.status !== 'SUCCESS') {
      updateButtonStatus(btn, 'SENDING', ackText, false);
    }
  } catch (error) {
    finish('ERROR', `× ${getErrorMessage(error) || KDI18n.get('errorNoAck')}`, false);
  }
}
