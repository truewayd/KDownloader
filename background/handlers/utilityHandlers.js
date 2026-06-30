// background/handlers/utilityHandlers.js - util and storage proxy RPCs
import UTIL from "../util.js";

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

function utilResponse(sendResponse, work, key) {
  try {
    sendResponse({ success: true, [key]: work() });
  } catch (err) {
    sendResponse({
      success: false,
      error: err && err.message ? err.message : String(err),
    });
  }
  return false;
}

export function createUtilityHandlers() {
  return {
    "util.extractExternalLinks": ({ message, sendResponse }) =>
      utilResponse(sendResponse, () => UTIL.extractExternalLinks(message.content), "links"),

    "util.sanitizeFileName": ({ message, sendResponse }) =>
      utilResponse(sendResponse, () => UTIL.sanitizeFileName(message.name), "name"),

    "util.getFileExtension": ({ message, sendResponse }) =>
      utilResponse(sendResponse, () => UTIL.getFileExtension(message.path), "ext"),

    "util.buildDownloadTasks": ({ message, sendResponse }) =>
      utilResponse(
        sendResponse,
        () => UTIL.buildDownloadTasks(message.postData, message.title, message.baseUrl),
        "tasks"
      ),

    "storage.get": ({ message, sendResponse }) =>
      storageCallback(sendResponse, (ok) => {
        chrome.storage.sync.get(message.keys, (result) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          ok({ result });
        });
      }),

    "storage.set": ({ message, sendResponse }) =>
      storageCallback(sendResponse, (ok) => {
        chrome.storage.sync.set(message.items, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          ok();
        });
      }),

    "storage.getBytesInUse": ({ message, sendResponse }) =>
      storageCallback(sendResponse, (ok) => {
        chrome.storage.sync.getBytesInUse(message.keys, (bytes) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          ok({ bytes });
        });
      }),

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
