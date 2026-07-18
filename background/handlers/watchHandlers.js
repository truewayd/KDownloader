// background/handlers/watchHandlers.js - Pawchive Watch RPCs
import { loadWatchConfig, saveWatchConfig } from '../config.js';
import { respondWith } from '../messageHelpers.js';
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
    'watch.getConfig': ({ sendResponse }) =>
      respondWith(sendResponse, loadWatchConfig(), (config) => ({ config })),

    'watch.setConfig': ({ message, sendResponse }) =>
      respondWith(sendResponse, saveConfigAndSchedule(message.config), (config) => ({ config })),

    'watch.getState': ({ message, sendResponse }) =>
      respondWith(sendResponse, getWatchState(message.service, message.userId), (state) => state),

    'watch.getSummary': ({ sendResponse }) =>
      respondWith(sendResponse, getWatchSummary(), (summary) => ({ summary })),

    'watch.setState': ({ message, sendResponse }) =>
      respondWith(sendResponse, setWatchState(message.service, message.userId, message.watched), (state) => state),

    'watch.export': ({ sendResponse }) =>
      respondWith(sendResponse, exportWatches(), (data) => ({ data })),

    'watch.import': ({ message, sendResponse }) =>
      respondWith(sendResponse, importWatches(message.data), (result) => ({ result })),

    'watch.forceCheck': ({ sendResponse }) => {
      sendResponse({ success: true, accepted: true });
      runWatchCheck().catch((error) => console.error('[Watch] forced check failed', error));
      return false;
    },
  };
}
