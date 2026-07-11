// background/handlers/utilityHandlers.js - small storage utility RPCs

function storageCallback(sendResponse, work) {
  try {
    work((result = {}) => sendResponse({ success: true, ...result }));
  } catch (err) {
    sendResponse({
      success: false,
      error: err && err.message ? err.message : String(err),
    });
  }
  return true;
}

export function createUtilityHandlers() {
  return {
    "storageLocal.getBytesInUse": ({ message, sendResponse }) =>
      storageCallback(sendResponse, (ok) => {
        chrome.storage.local.getBytesInUse(message.keys, (bytes) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          ok({ bytes });
        });
      }),
  };
}
