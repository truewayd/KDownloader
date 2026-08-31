// background/handlers/creatorsHandlers.js - creator override cache RPCs
import { API } from "../constants.js";
import {
  setCreatorsOverrideEnabled,
  updateCacheFromNetwork,
  getCachedCreators,
  ensureRuleState,
} from "../creators.js";
import {
  beginAcceptedRequest,
  completeAcceptedRequest,
  requireExtensionPage,
  respondWith,
} from "../messageHelpers.js";

async function getCreatorSummary(host) {
  if (!API.HOSTS.includes(host)) throw new Error("Unknown host");
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
    "creators.getCached": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Creator cache reads");
      return respondWith(
        sendResponse,
        getCachedCreators(message.host),
        (cached) => ({ cached })
      );
    },

    "creators.getSummary": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Creator cache summaries");
      return respondWith(
        sendResponse,
        (async () => {
          if (message && message.host) return getCreatorSummary(message.host);
          return getCreatorSummaries();
        })(),
        (summary) => ({ summary })
      );
    },

    "creators.updateCache": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Creator cache updates");
      let requestRegistration;
      try {
        requestRegistration = beginAcceptedRequest(
          "creators.updateCache",
          message.requestId,
          sender
        );
        sendResponse({ success: true, accepted: true });
      } catch (e) {
        try {
          sendResponse({ success: false, error: e && e.message ? e.message : String(e) });
        } catch (sendError) {
          /* response port closed */
        }
        return false;
      }
      if (requestRegistration.duplicate) return false;
      (async () => {
        try {
          await updateCacheFromNetwork(message.host);
        } catch (err) {
          console.error("[Background] creators.updateCache failed", message.host, err);
        } finally {
          completeAcceptedRequest(requestRegistration.token);
        }
      })();
      return false;
    },

    "creators.setEnabled": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "Creator cache configuration");
      return respondWith(sendResponse, setCreatorsOverrideEnabled(!!message.enabled), () => ({}));
    },

    "creators.ensureRuleState": ({ sender, sendResponse }) => {
      requireExtensionPage(sender, "Creator cache configuration");
      return respondWith(sendResponse, ensureRuleState(), (enabled) => ({ enabled }));
    },
  };
}
