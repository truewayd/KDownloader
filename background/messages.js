// background/messages.js - message router entry
import { createConfigHandlers } from "./handlers/configHandlers.js";
import { createDbHandlers } from "./handlers/dbHandlers.js";
import { createDownloadHandlers } from "./handlers/downloadHandlers.js";
import { createCreatorsHandlers } from "./handlers/creatorsHandlers.js";
import { createUtilityHandlers } from "./handlers/utilityHandlers.js";
import { createWatchHandlers } from "./handlers/watchHandlers.js";

function buildHandlers() {
  return {
    ...createConfigHandlers(),
    ...createDbHandlers(),
    ...createDownloadHandlers(),
    ...createCreatorsHandlers(),
    ...createUtilityHandlers(),
    ...createWatchHandlers(),
  };
}

export function registerMessageHandlers() {
  const handlers = buildHandlers();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (!message || !message.action) return false;
      const handler = handlers[message.action];
      if (!handler) return false;
      return handler({ message, sender, sendResponse });
    } catch (err) {
      console.error("[Background] onMessage error", err);
      try {
        sendResponse({
          success: false,
          error: err && err.message ? err.message : String(err),
        });
      } catch (e) {
        /* ignore */
      }
      return true;
    }
  });
}
