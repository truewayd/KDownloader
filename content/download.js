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
      updateButtonStatus(btn, 'ERROR', `\u2717 ${err.message || 'No ack'}`, isCreatorPage);
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
            updateButtonStatus(btn, 'ERROR', '\u2717 No response (timeout)', isCreatorPage);
            setTimeout(() => {
              btn.disabled = false;
              setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000);
            }, 2000);
          }
        }, WATCHDOG_DEFAULT);
      }

      const onComplete = (message, sender, sendResponse) => {
        try {
          if (!message) return;

          if (message.action === 'downloadProgress') {
            if (message.service !== service || message.userId !== userId || message.postId !== postId) return;
            if (typeof message.progress === 'number') {
              const pct = Math.round(message.progress);
              if (!isCreatorPage) btn.textContent = `Sending ${pct}%`;
              else btn.title = `Sending ${pct}%`;
            } else if (typeof message.sentCount === 'number' && typeof message.totalCount === 'number') {
              if (!isCreatorPage) btn.textContent = `Sending ${message.sentCount}/${message.totalCount}`;
              else btn.title = `Sending ${message.sentCount}/${message.totalCount}`;
            }
            resetWatchdog();
            return;
          }

          if (message.action !== 'downloadComplete') return;
          if (message.service !== service || message.userId !== userId || message.postId !== postId) return;

          const result = message.result || {};
          const noFiles = result.noFiles === true;
          if (result.externalLinks && result.externalLinks.length > 0) showExternalLinksModal(result.externalLinks);

          if (result.success) {
            const anyDownloaded = noFiles || (result.backend === true) || (typeof result.successCount === 'number' && result.successCount > 0) || (Array.isArray(result.results) && result.results.some(r => r && r.success));

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
                if (isCreatorPage) btn.title = 'No downloadable files'; else updateButtonStatus(btn, 'SUCCESS', 'No files', isCreatorPage);
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
          try { chrome.runtime.onMessage.removeListener(onComplete); } catch (e) { }
          if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
        }
      };

      chrome.runtime.onMessage.addListener(onComplete);
      resetWatchdog();
    } else {
      console.error('[Content] startDownload not accepted by background');
      updateButtonStatus(btn, 'ERROR', '\u2717 Not accepted', isCreatorPage);
      setTimeout(() => { btn.disabled = false; setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000); }, 2000);
    }
  } catch (error) {
    console.error('[Content] handleDownload error:', error && error.message ? error.message : error);
    updateButtonStatus(btn, 'ERROR', `✗ ${error && error.message ? error.message : String(error)}`, isCreatorPage);
    setTimeout(() => { btn.disabled = false; setTimeout(() => updateButtonStatus(btn, 'IDLE', null, isCreatorPage), 2000); }, 2000);
  }
}
