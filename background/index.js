// background/index.js - service worker entry
import { FAVORITES_ALARM, SYNC_VERSION_ALARM } from './constants.js';
import { registerMessageHandlers } from './messages.js';
import { loadFavoritesConfig } from './config.js';
import { ensureRuleState } from './creators.js';

// Register message router
registerMessageHandlers();

// Init alarms on installed/startup
chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await loadFavoritesConfig();
  try { await chrome.alarms.clear(FAVORITES_ALARM); } catch (e) { }
  if (cfg.enabled) chrome.alarms.create(FAVORITES_ALARM, { periodInMinutes: Math.max(1, Math.floor(cfg.intervalMinutes)) });
  try { await ensureRuleState(); } catch (e) { console.warn('[Background] ensureRuleState failed', e); }
});

chrome.runtime.onStartup.addListener(async () => {
  const cfg = await loadFavoritesConfig();
  try { await chrome.alarms.clear(FAVORITES_ALARM); } catch (e) { }
  if (cfg.enabled) chrome.alarms.create(FAVORITES_ALARM, { periodInMinutes: Math.max(1, Math.floor(cfg.intervalMinutes)) });
  try { await ensureRuleState(); } catch (e) { console.warn('[Background] ensureRuleState failed', e); }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (!alarm) return;
    if (alarm.name === FAVORITES_ALARM) {
      // runFavoritesCheck imported dynamically if needed
      return;
    }
    if (alarm.name === SYNC_VERSION_ALARM) {
      // safeIncrementStorageVersion retry handled in db module invocations
      return;
    }
  } catch (e) {
    console.error('[Background] onAlarm handler error', e);
  }
});

console.log('[Background] service worker modules loaded');
