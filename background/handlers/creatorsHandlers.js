// background/handlers/creatorsHandlers.js - creator override cache RPCs
import { API } from "../constants.js";
import {
  setCreatorsOverrideEnabled,
  updateCacheFromNetwork,
  getCachedCreators,
  ensureRuleState,
} from "../creators.js";
import { respondWith } from "../messageHelpers.js";

async function getCreatorSummary(host) {
  const meta = await chrome.storage.local.get(`creatorsOverride_${host}_meta`);
  const item = meta ? meta[`creatorsOverride_${host}_meta`] : null;
  return item
    ? { updatedAt: item.updatedAt, sourceHost: item.sourceHost }
    : null;
}

async function getCreatorSummaries() {
  const keys = API.HOSTS.map((host) => `creatorsOverride_${host}_meta`);
  const stored = await chrome.storage.local.get(keys);
  return Object.fromEntries(API.HOSTS.map((host) => {
    const item = stored[`creatorsOverride_${host}_meta`];
    return [host, item ? { updatedAt: item.updatedAt, sourceHost: item.sourceHost } : null];
  }));
}

export function createCreatorsHandlers() {
  return {
    "creators.getCached": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        getCachedCreators(message.host),
        (cached) => ({ cached })
      ),

    "creators.getSummary": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        (async () => {
          if (message && message.host) return getCreatorSummary(message.host);
          return getCreatorSummaries();
        })(),
        (summary) => ({ summary })
      ),

    "creators.updateCache": ({ message, sendResponse }) => {
      try {
        sendResponse({ success: true, accepted: true });
      } catch (e) {
        /* ignore */
      }
      (async () => {
        try {
          await updateCacheFromNetwork(message.host);
        } catch (err) {
          console.error("[Background] creators.updateCache failed", message.host, err);
        }
      })();
      return false;
    },

    "creators.setEnabled": ({ message, sendResponse }) =>
      respondWith(sendResponse, setCreatorsOverrideEnabled(!!message.enabled), () => ({})),

    "creators.ensureRuleState": ({ sendResponse }) =>
      respondWith(sendResponse, ensureRuleState(), (enabled) => ({ enabled })),
  };
}
