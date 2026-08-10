// background/index.js - service worker entry
import { WATCH_ALARM } from './constants.js';
import { registerMessageHandlers } from './messages.js';
import { cleanupHistoryStorage } from './db.js';
import { configureWatchAlarm, runWatchCheck } from './watch.js';
import { handleNativeFallbackDecision } from './handlers/downloadHandlers.js';
import {
  openPawchiveForVerification,
  PAWCHIVE_CLOUDFLARE_NOTIFICATION_ID,
} from './network.js';

// Register message router
registerMessageHandlers();

// Init alarms on installed/startup
chrome.runtime.onInstalled.addListener(async () => {
  try { await configureWatchAlarm(); } catch (e) { console.warn('[Background] configureWatchAlarm failed', e); }
  try { await cleanupHistoryStorage(); } catch (e) { console.warn('[Background] history cleanup failed', e); }
});

chrome.runtime.onStartup.addListener(async () => {
  try { await configureWatchAlarm(); } catch (e) { console.warn('[Background] configureWatchAlarm failed', e); }
  try { await cleanupHistoryStorage(); } catch (e) { console.warn('[Background] history cleanup failed', e); }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (!alarm) return;
    if (alarm.name === WATCH_ALARM) {
      await runWatchCheck({ prepareCloudflareContext: true });
    }
  } catch (e) {
    console.error('[Background] onAlarm handler error', e);
  }
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId === PAWCHIVE_CLOUDFLARE_NOTIFICATION_ID) {
    if (buttonIndex === 0) {
      openPawchiveForVerification().catch((error) => {
        console.error('[Background] failed to open Pawchive verification page', error);
      });
    }
    return;
  }
  handleNativeFallbackDecision(notificationId, buttonIndex === 0).catch((error) => {
    console.error('[Background] native fallback decision failed', error);
  });
});

chrome.notifications.onClosed.addListener((notificationId) => {
  if (notificationId === PAWCHIVE_CLOUDFLARE_NOTIFICATION_ID) return;
  handleNativeFallbackDecision(notificationId, false).catch((error) => {
    console.error('[Background] native fallback close failed', error);
  });
});
