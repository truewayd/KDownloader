// background/handlers/configHandlers.js - config, gist, network, and status RPCs
import {
  loadBackendConfig,
  saveBackendConfig,
  loadDownloadRulesConfig,
  saveDownloadRulesConfig,
  loadGistConfig,
  saveGistConfig,
  restoreDefaultConfigs,
} from "../config.js";
import { setCreatorsOverrideEnabled } from "../creators.js";
import { gistUpload, gistDownload } from "../gist.js";
import { handleAPIRequest, getCookies } from "../network.js";
import { getGlobalProgress } from "../progress.js";
import { configureWatchAlarm } from "../watch.js";
import { respondWith } from "../messageHelpers.js";

async function restoreSettingsDefaults() {
  const configs = await restoreDefaultConfigs();
  await Promise.all([
    setCreatorsOverrideEnabled(false),
    configureWatchAlarm(configs.watch),
  ]);
  return configs;
}

export function createConfigHandlers() {
  return {
    "backend.getConfig": ({ sendResponse }) =>
      respondWith(sendResponse, loadBackendConfig(), (config) => ({ config })),

    "backend.setConfig": ({ message, sendResponse }) =>
      respondWith(sendResponse, saveBackendConfig(message.config || {}), (config) => ({ config })),

    "downloadRules.getConfig": ({ sendResponse }) =>
      respondWith(sendResponse, loadDownloadRulesConfig(), (config) => ({ config })),

    "downloadRules.setConfig": ({ message, sendResponse }) =>
      respondWith(sendResponse, saveDownloadRulesConfig(message.config || {}), (config) => ({ config })),

    "gist.getConfig": ({ sendResponse }) =>
      respondWith(sendResponse, loadGistConfig(), (config) => ({ config })),

    "gist.setConfig": ({ message, sendResponse }) =>
      respondWith(sendResponse, saveGistConfig(message.config || {}), (config) => ({ config })),

    "gist.upload": ({ sendResponse }) =>
      respondWith(sendResponse, gistUpload(), (result) => ({ result })),

    "gist.download": ({ sendResponse }) =>
      respondWith(sendResponse, gistDownload(), (result) => ({ result })),

    "settings.restoreDefaults": ({ sendResponse }) =>
      respondWith(sendResponse, restoreSettingsDefaults(), (configs) => ({ configs })),

    fetchAPI: ({ message, sendResponse }) =>
      respondWith(sendResponse, handleAPIRequest(message.url, message.headers), (data) => ({ data })),

    getCookies: ({ message, sendResponse }) =>
      respondWith(sendResponse, getCookies(message.domain), (cookies) => ({ cookies })),

    "status.getGlobalProgress": ({ sendResponse }) => {
      sendResponse({ success: true, progress: getGlobalProgress() });
      return false;
    },
  };
}
