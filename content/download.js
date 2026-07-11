// content/download.js - handleDownload logic moved out of content.js

async function handleDownload(btn, service, userId, postId, path, isCreatorPage = false, options = {}) {
  if (btn.disabled) return;

  updateButtonStatus(btn, 'SCANNING', null, isCreatorPage);

  try {
    let ack = null;
    try {
      ack = await safeSendMessage({
        action: 'startDownload',
        service,
        userId,
        postId,
        path,
        source: options.source,
        creatorName: options.creatorName,
      }, 7000, { retries: 2, retryDelay: 400 });
    } catch (err) {
      console.error('[Content] startDownload ack error:', err && err.message ? err.message : err);
      updateButtonStatus(btn, 'ERROR', `✗ ${err.message || KDI18n.get('errorNoAck')}`, isCreatorPage);
      setTimeout(() => {
        btn.disabled = false;
        setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000);
      }, 2000);
      return;
    }

    if (ack && ack.accepted) {
      updateButtonStatus(btn, 'SENDING', null, isCreatorPage);

      const WATCHDOG_DEFAULT = 10 * 60 * 1000; // 10 minutes
      let watchdogTimer = null;

      function resetWatchdog() {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(() => {
          try { chrome.runtime.onMessage.removeListener(onComplete); } catch (e) { }
          if (btn.getAttribute('data-status') === 'SENDING') {
            console.error('[Content] handleDownload error: No response from extension (watchdog timeout)');
            updateButtonStatus(btn, 'ERROR', `✗ ${KDI18n.get('errorTimeout')}`, isCreatorPage);
            setTimeout(() => {
              btn.disabled = false;
              setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000);
            }, 2000);
          }
        }, WATCHDOG_DEFAULT);
      }

      const onComplete = (message, sender, sendResponse) => {
        let shouldCleanup = false;
        try {
          if (!message) return;

          if (message.action === 'downloadProgress') {
            if (message.service !== service || message.userId !== userId || message.postId !== postId) return;
            if (typeof message.progress === 'number') {
              const pct = Math.round(message.progress);
              if (!isCreatorPage) btn.textContent = KDI18n.get('sendingPercent', [pct]);
              else btn.title = KDI18n.get('sendingPercent', [pct]);
            } else if (typeof message.sentCount === 'number' && typeof message.totalCount === 'number') {
              if (!isCreatorPage) btn.textContent = KDI18n.get('sendingCount', [message.sentCount, message.totalCount]);
              else btn.title = KDI18n.get('sendingCount', [message.sentCount, message.totalCount]);
            }
            resetWatchdog();
            return;
          }

          if (message.action !== 'downloadComplete') return;
          if (message.service !== service || message.userId !== userId || message.postId !== postId) return;
          shouldCleanup = true;

          const result = message.result || {};
          const noFiles = result.noFiles === true;
          if (result.externalLinks && result.externalLinks.length > 0) showExternalLinksModal(result.externalLinks);

          if (result.success) {
            const anyDownloaded = noFiles || (result.backend === true) || (typeof result.successCount === 'number' && result.successCount > 0) || (Array.isArray(result.results) && result.results.some(r => r && r.success));

            if (result.alreadyDownloaded) {
              updateButtonStatus(btn, 'SUCCESS', KDI18n.get('statusDownloadedDecorated'), isCreatorPage);
              btn.disabled = true;
            } else if (anyDownloaded) {
              if (noFiles) {
                updateButtonStatus(btn, 'SUCCESS', isCreatorPage ? null : KDI18n.get('statusNoFiles'), isCreatorPage);
                if (isCreatorPage) btn.title = KDI18n.get('noDownloadableFiles');
              } else {
                updateButtonStatus(btn, 'SUCCESS', null, isCreatorPage);
              }
              if (!isCreatorPage) {
                if (!noFiles) {
                  setTimeout(() => { btn.disabled = false; setTimeout(() => updateButtonStatus(btn, 'IDLE', null, false), 2000); }, 200);
                } else {
                  btn.disabled = false;
                }
              } else {
                btn.disabled = true;
              }
            } else {
              if (result.externalLinks && result.externalLinks.length > 0) {
                updateButtonStatus(btn, 'SUCCESS', null, isCreatorPage);
                if (!isCreatorPage) { setTimeout(() => { btn.disabled = false; setTimeout(() => updateButtonStatus(btn, 'IDLE', null, false), 2000); }, 200); } else { btn.disabled = true; }
              } else {
                if (isCreatorPage) btn.title = KDI18n.get('noDownloadableFiles'); else updateButtonStatus(btn, 'SUCCESS', KDI18n.get('statusNoFiles'), isCreatorPage);
                btn.disabled = false;
                setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000);
              }
            }
          } else {
            const errMsg = result.error || 'Download failed';
            console.error('[Content] downloadComplete error:', errMsg);
            updateButtonStatus(btn, 'ERROR', `\u2717 ${errMsg}`, isCreatorPage);
            setTimeout(() => { btn.disabled = false; setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000); }, 2000);
          }
        } finally {
          if (shouldCleanup) {
            try { chrome.runtime.onMessage.removeListener(onComplete); } catch (e) { }
            if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
          }
        }
      };

      chrome.runtime.onMessage.addListener(onComplete);
      resetWatchdog();
    } else {
      console.error('[Content] startDownload not accepted by background');
      updateButtonStatus(btn, 'ERROR', KDI18n.get('statusFailedDecorated'), isCreatorPage);
      setTimeout(() => { btn.disabled = false; setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000); }, 2000);
    }
  } catch (error) {
    console.error('[Content] handleDownload error:', error && error.message ? error.message : error);
    updateButtonStatus(btn, 'ERROR', `✗ ${error && error.message ? error.message : String(error)}`, isCreatorPage);
    setTimeout(() => { btn.disabled = false; setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000); }, 2000);
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
    resetText = null,
    total: initialTotal = null,
    timeoutMs = 10 * 60 * 1000,
    renderProgress,
    renderComplete,
  } = options || {};
  if (!btn || !service || !userId || !requestMessage) return;

  let total = initialTotal;
  let completed = 0;
  let successCount = 0;
  let watchdogTimer = null;

  const state = () => ({ total, completed, successCount });

  const finish = (status, text, keepDisabled) => {
    try {
      chrome.runtime.onMessage.removeListener(onBatchMessage);
    } catch (e) {
      /* ignore */
    }
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    updateButtonStatus(btn, status, text, false);
    btn.disabled = !!keepDisabled;
    if (!keepDisabled) {
      setTimeout(() => updateButtonStatus(btn, "IDLE", resetText, false), 2000);
    }
  };

  const resetWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      finish("ERROR", "✗ Timeout", false);
    }, timeoutMs);
  };

  const defaultProgress = (message) => {
    const sent = message.sentCount || 0;
    btn.textContent = KDI18n.get('sendingCount', [sent, total ?? '?']);
  };

  const defaultComplete = () => {
    btn.textContent = KDI18n.get('ackCount', [completed, total ?? '?']);
  };

  const maybeFinish = () => {
    if (total === 0) {
      finish("SUCCESS", KDI18n.get('statusAllDoneDecorated'), false);
      return true;
    }
    if (total && completed >= total) {
      if (successCount > 0) finish("SUCCESS", `✓ ${successCount}/${total}`, true);
      else finish("ERROR", KDI18n.get('statusFailedDecorated'), false);
      return true;
    }
    return false;
  };

  function onBatchMessage(message) {
    if (!message) return;
    if (message.service !== service || message.userId !== userId) return;
    if (message.error) {
      finish("ERROR", `✗ ${message.error}`, false);
      return;
    }
    resetWatchdog();

    if (message.action === "downloadProgress" && message.batch) {
      if (Number.isFinite(message.totalCount)) total = message.totalCount;
      if (typeof renderProgress === "function") renderProgress({ btn, message, state: state(), finish });
      else defaultProgress(message);
      maybeFinish();
      return;
    }

    if (message.action !== "downloadComplete") return;
    completed++;
    const result = message.result || {};
    if (result.success) successCount++;
    if (typeof renderComplete === "function") renderComplete({ btn, message, state: state(), finish });
    else defaultComplete(message);
    maybeFinish();
  }

  chrome.runtime.onMessage.addListener(onBatchMessage);
  updateButtonStatus(btn, "SENDING", initialText, false);
  resetWatchdog();

  try {
    const ack = await safeSendMessage(requestMessage, 10000, { retries: 2, retryDelay: 400 });
    if (!ack || (!ack.accepted && !ack.success)) throw new Error("No ack");
    if (btn.getAttribute("data-status") !== "SUCCESS") {
      updateButtonStatus(btn, "SENDING", ackText, false);
    }
  } catch (err) {
    try {
      chrome.runtime.onMessage.removeListener(onBatchMessage);
    } catch (e) {
      /* ignore */
    }
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    updateButtonStatus(btn, "ERROR", `✗ ${KDI18n.get('errorNoAck')}`, false);
    setTimeout(() => {
      btn.disabled = false;
      updateButtonStatus(btn, "IDLE", resetText, false);
    }, 2000);
  }
}
