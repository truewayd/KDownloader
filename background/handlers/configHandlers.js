// background/handlers/configHandlers.js - config, gist, and status RPCs
import {
  loadBackendConfig,
  saveBackendConfig,
  probeAutoResolve,
  loadLinkHandlingConfig,
  saveLinkHandlingConfig,
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
import {
  isExtensionPageSender,
  requireExtensionPage,
  respondWith,
} from "../messageHelpers.js";
import { syncDownloadRulesFromTrueDown } from "../truedown.js";
import { writeLinkRecords } from "../linkHistory.js";

async function restoreSettingsDefaults() {
  const configs = await restoreDefaultConfigs();
  await Promise.all([
    setCreatorsOverrideEnabled(false),
    configureWatchAlarm(configs.watch),
  ]);
  return configs;
}

async function saveAndSyncDownloadRules(value) {
  await saveDownloadRulesConfig(value);
  return syncDownloadRulesFromTrueDown();
}

function withoutBackendSecrets(config) {
  return { ...config, apiKey: "", gopeedToken: "" };
}

function withoutGistSecret(config) {
  return { ...config, token: "" };
}

export function createConfigHandlers() {
  return {
    "links.getConfig": ({ sender, sendResponse }) => {
      requireExtensionPage(sender, "Link settings");
      return respondWith(sendResponse, loadLinkHandlingConfig(), config => ({ config }));
    },
    "links.setConfig": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Link settings");
      return respondWith(sendResponse, saveLinkHandlingConfig(message.config || {}), config => ({ config }));
    },
    "links.markExtracted": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Link history");
      return respondWith(sendResponse, writeLinkRecords(message.links, message.remove === true ? 'remove' : 'manual'), result => result);
    },
    "backend.getConfig": ({ sender, sendResponse }) =>
      respondWith(sendResponse, loadBackendConfig(), (config) => ({
        config: isExtensionPageSender(sender) ? config : withoutBackendSecrets(config),
      })),

    "backend.setConfig": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Backend configuration");
      return respondWith(sendResponse, saveBackendConfig(message.config || {}), (config) => ({ config }));
    },

    "backend.probeAutoResolve": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Backend capability detection");
      return respondWith(sendResponse, probeAutoResolve(message.config || {}), (capabilities) => ({ capabilities }));
    },

    "downloadRules.getConfig": ({ sender, sendResponse }) => isExtensionPageSender(sender)
      ? respondWith(sendResponse, syncDownloadRulesFromTrueDown(), result => result)
      : respondWith(sendResponse, loadDownloadRulesConfig(), config => ({ config })),

    "downloadRules.syncFromTrueDown": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "TrueDown filter synchronization");
      return respondWith(sendResponse, message.enable === true
        ? saveAndSyncDownloadRules({ syncFromTrueDown: true }) : syncDownloadRulesFromTrueDown(), result => result);
    },

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
