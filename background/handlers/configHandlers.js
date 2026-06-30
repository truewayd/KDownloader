// background/handlers/configHandlers.js - config, gist, network, and status RPCs
import {
  loadFavoritesConfig,
  saveFavoritesConfig,
  loadBackendConfig,
  saveBackendConfig,
  loadGistConfig,
  saveGistConfig,
} from "../config.js";
import { gistUpload, gistDownload } from "../gist.js";
import { handleAPIRequest, getCookies } from "../network.js";
import { getGlobalProgress } from "../progress.js";
import { respondWith } from "../messageHelpers.js";

export function createConfigHandlers({ runFavoritesCheck }) {
  return {
    "favorites.getConfig": ({ sendResponse }) =>
      respondWith(sendResponse, loadFavoritesConfig(), (config) => ({ config })),

    "favorites.setConfig": ({ message, sendResponse }) =>
      respondWith(sendResponse, saveFavoritesConfig(message.config || {}), (config) => ({ config })),

    "favorites.forceCheck": ({ sendResponse }) =>
      respondWith(sendResponse, Promise.resolve().then(runFavoritesCheck), () => ({})),

    "backend.getConfig": ({ sendResponse }) =>
      respondWith(sendResponse, loadBackendConfig(), (config) => ({ config })),

    "backend.setConfig": ({ message, sendResponse }) =>
      respondWith(sendResponse, saveBackendConfig(message.config || {}), (config) => ({ config })),

    "gist.getConfig": ({ sendResponse }) =>
      respondWith(sendResponse, loadGistConfig(), (config) => ({ config })),

    "gist.setConfig": ({ message, sendResponse }) =>
      respondWith(sendResponse, saveGistConfig(message.config || {}), (config) => ({ config })),

    "gist.upload": ({ sendResponse }) =>
      respondWith(sendResponse, gistUpload(), (result) => ({ result })),

    "gist.download": ({ sendResponse }) =>
      respondWith(sendResponse, gistDownload(), (result) => ({ result })),

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
