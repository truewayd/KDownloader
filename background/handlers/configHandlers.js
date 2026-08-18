// background/handlers/configHandlers.js - config, gist, and status RPCs
import {
  loadBackendConfig,
  saveBackendConfig,
  loadDownloadRulesConfig,
  saveDownloadRulesConfig,
  loadExternalLinkFilterConfig,
  saveExternalLinkFilterConfig,
  loadGistConfig,
  saveGistConfig,
  restoreDefaultConfigs,
} from "../config.js";
import { setCreatorsOverrideEnabled } from "../creators.js";
import { gistUpload, gistDownload } from "../gist.js";
import { getGlobalProgress } from "../progress.js";
import { configureWatchAlarm } from "../watch.js";
import { respondWith } from "../messageHelpers.js";
import { syncDownloadRulesToTrueDown } from "../truedown.js";

async function restoreSettingsDefaults() {
  const configs = await restoreDefaultConfigs();
  await Promise.all([
    setCreatorsOverrideEnabled(false),
    configureWatchAlarm(configs.watch),
  ]);
  return configs;
}

async function saveAndSyncDownloadRules(value) {
  const config = await saveDownloadRulesConfig(value);
  try {
    return { config, sync: await syncDownloadRulesToTrueDown(config) };
  } catch (error) {
    return {
      config,
      sync: {
        state: "failed",
        error: error && error.message ? error.message : String(error),
      },
    };
  }
}

function isExtensionPageSender(sender) {
  return !sender || !sender.tab;
}

function requireExtensionPage(sender, operation) {
  if (!isExtensionPageSender(sender)) {
    throw new Error(`${operation} is restricted to extension pages`);
  }
}

function withoutBackendSecrets(config) {
  return { ...config, apiKey: "", gopeedToken: "" };
}

function withoutGistSecret(config) {
  return { ...config, token: "" };
}

export function createConfigHandlers() {
  return {
    "backend.getConfig": ({ sender, sendResponse }) =>
      respondWith(sendResponse, loadBackendConfig(), (config) => ({
        config: isExtensionPageSender(sender) ? config : withoutBackendSecrets(config),
      })),

    "backend.setConfig": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Backend configuration");
      return respondWith(sendResponse, saveBackendConfig(message.config || {}), (config) => ({ config }));
    },

    "downloadRules.getConfig": ({ sendResponse }) =>
      respondWith(sendResponse, loadDownloadRulesConfig(), (config) => ({ config })),

    "downloadRules.setConfig": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Download-rule configuration");
      return respondWith(sendResponse, saveAndSyncDownloadRules(message.config || {}), (result) => result);
    },

    "externalLinkFilter.getConfig": ({ sendResponse }) =>
      respondWith(sendResponse, loadExternalLinkFilterConfig(), (config) => ({ config })),

    "externalLinkFilter.setConfig": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "External-link filter configuration");
      return respondWith(sendResponse, saveExternalLinkFilterConfig(message.config || {}), (config) => ({ config }));
    },

    "gist.getConfig": ({ sender, sendResponse }) =>
      respondWith(sendResponse, loadGistConfig(), (config) => ({
        config: isExtensionPageSender(sender) ? config : withoutGistSecret(config),
      })),

    "gist.setConfig": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Gist configuration");
      return respondWith(sendResponse, saveGistConfig(message.config || {}), (config) => ({ config }));
    },

    "gist.upload": ({ sender, sendResponse }) => {
      requireExtensionPage(sender, "Gist upload");
      return respondWith(sendResponse, gistUpload(), (result) => ({ result }));
    },

    "gist.download": ({ sender, sendResponse }) => {
      requireExtensionPage(sender, "Gist download");
      return respondWith(sendResponse, gistDownload(), (result) => ({ result }));
    },

    "settings.restoreDefaults": ({ sender, sendResponse }) => {
      requireExtensionPage(sender, "Settings restore");
      return respondWith(sendResponse, restoreSettingsDefaults(), (configs) => ({ configs }));
    },

    "status.getGlobalProgress": ({ sendResponse }) => {
      sendResponse({ success: true, progress: getGlobalProgress() });
      return false;
    },
  };
}
