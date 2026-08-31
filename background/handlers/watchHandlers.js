// background/handlers/watchHandlers.js - Pawchive Watch RPCs
import { loadWatchConfig, saveWatchConfig } from '../config.js';
import { PAW } from '../constants.js';
import {
  requireExtensionPage,
  requireTrustedWebSender,
  respondWith,
} from '../messageHelpers.js';
import {
  configureWatchAlarm,
  exportWatches,
  getWatchState,
  getWatchSummary,
  importWatches,
  runWatchCheck,
  setWatchState,
} from '../watch.js';

async function saveConfigAndSchedule(config) {
  const saved = await saveWatchConfig(config || {});
  await configureWatchAlarm(saved);
  return saved;
}

export function createWatchHandlers() {
  return {
    'watch.getConfig': ({ sender, sendResponse }) => {
      requireExtensionPage(sender, 'Watch configuration');
      return respondWith(sendResponse, loadWatchConfig(), (config) => ({ config }));
    },

    'watch.setConfig': ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, 'Watch configuration');
      return respondWith(sendResponse, saveConfigAndSchedule(message.config), (config) => ({ config }));
    },

    'watch.getState': ({ message, sender, sendResponse }) => {
      requireTrustedWebSender(sender, [PAW.HOST], 'Watch state reads');
      return respondWith(sendResponse, getWatchState(message.service, message.userId), (state) => state);
    },

    'watch.getSummary': ({ sender, sendResponse }) => {
      requireExtensionPage(sender, 'Watch summaries');
      return respondWith(sendResponse, getWatchSummary(), (summary) => ({ summary }));
    },

    'watch.setState': ({ message, sender, sendResponse }) => {
      requireTrustedWebSender(sender, [PAW.HOST], 'Watch state changes');
      return respondWith(sendResponse, setWatchState(message.service, message.userId, message.watched), (state) => state);
    },

    'watch.export': ({ sender, sendResponse }) => {
      requireExtensionPage(sender, 'Watch export');
      return respondWith(sendResponse, exportWatches(), (data) => ({ data }));
    },

    'watch.import': ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, 'Watch import');
      return respondWith(sendResponse, importWatches(message.data), (result) => ({ result }));
    },

    'watch.forceCheck': ({ sender, sendResponse }) => {
      requireExtensionPage(sender, 'Watch checks');
      sendResponse({ success: true, accepted: true });
      runWatchCheck().catch((error) => console.error('[Watch] forced check failed', error));
      return false;
    },
  };
}
