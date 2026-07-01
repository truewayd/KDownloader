// background/handlers/dbHandlers.js - downloaded history and creator flag RPCs
import {
  loadDB,
  saveDB,
  checkDownloaded,
  checkDownloadedMany,
  markDownloaded,
  markMultipleDownloaded,
  exportDB,
  importDB,
  clearDB,
  safeIncrementStorageVersion,
  setLastAccess,
  getCreatorFlag,
  setCreatorFlag,
} from "../db.js";
import { respondWith } from "../messageHelpers.js";

export function createDbHandlers() {
  const checkOne = ({ message, sendResponse }) =>
    respondWith(
      sendResponse,
      checkDownloaded(message.service, message.userId, message.postId, message.source),
      (downloaded) => ({ downloaded })
    );

  const checkMany = ({ message, sendResponse }) =>
    respondWith(
      sendResponse,
      checkDownloadedMany(message.items || message.posts || []),
      (downloaded) => ({ downloaded })
    );

  return {
    "creator.recordAccess": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        setLastAccess(
          message.service,
          message.userId,
          message.when ? new Date(message.when) : new Date()
        ),
        () => ({})
      ),

    checkDownloaded: checkOne,
    "db.checkDownloaded": checkOne,
    checkDownloadedMany: checkMany,
    "db.checkDownloadedMany": checkMany,

    "db.load": ({ sendResponse }) =>
      respondWith(sendResponse, loadDB(), (db) => ({ db })),

    "db.save": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        saveDB(message.data || {}).then(safeIncrementStorageVersion),
        () => ({})
      ),

    "db.markDownloaded": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        markDownloaded(message.service, message.userId, message.postId, message.source),
        () => ({})
      ),

    "db.markMultiple": ({ message, sendResponse }) =>
      respondWith(sendResponse, markMultipleDownloaded(message.items), () => ({})),

    "db.export": ({ sendResponse }) =>
      respondWith(sendResponse, exportDB(), (text) => ({ text })),

    "db.import": ({ message, sendResponse }) =>
      respondWith(sendResponse, importDB(message.text), (success) => ({ success })),

    "db.clear": ({ sendResponse }) =>
      respondWith(sendResponse, clearDB(), () => ({})),

    "flag.get": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        getCreatorFlag(message.service, message.userId),
        (flag) => ({ flag })
      ),

    "flag.set": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        setCreatorFlag(message.service, message.userId, message.value),
        (flag) => ({ flag })
      ),
  };
}
