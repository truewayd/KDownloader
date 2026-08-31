// background/handlers/dbHandlers.js - downloaded history and creator flag RPCs
import {
  getDownloadedStatus,
  getDownloadedStatusesMany,
  markDownloaded,
  markMultipleDownloaded,
  getHistoryExportPage,
  beginHistoryExport,
  beginImportSession,
  appendImportChunk,
  commitImportSession,
  abortImportSession,
  getImportSessionStatus,
  clearDB,
  getHistoryStats,
  getCreatorFlagsMany,
  setCreatorFlag,
} from "../db.js";
import { API, PAW } from "../constants.js";
import {
  isExtensionPageSender,
  requireExtensionPage,
  requireTrustedWebSender,
  respondWith,
} from "../messageHelpers.js";

const CONTENT_HOSTS = [...API.HOSTS, API.COOMERFANS_HOST, PAW.HOST];

function requireHistoryReader(sender, operation) {
  if (isExtensionPageSender(sender)) return;
  requireTrustedWebSender(sender, CONTENT_HOSTS, operation, { allowSubdomains: true });
}

export function createDbHandlers() {
  const checkOne = ({ message, sender, sendResponse }) => {
    requireHistoryReader(sender, "History status reads");
    return respondWith(
      sendResponse,
      getDownloadedStatus(message.service, message.userId, message.postId, message.source),
      (status) => ({ downloaded: status === "complete" || status === "empty", status })
    );
  };

  const checkMany = ({ message, sender, sendResponse }) => {
    requireHistoryReader(sender, "History status reads");
    return respondWith(
      sendResponse,
      getDownloadedStatusesMany(message.items || message.posts || []),
      (statuses) => ({
        downloaded: Object.fromEntries(
          Object.entries(statuses).map(([key, status]) => [
            key,
            status === "complete" || status === "empty",
          ])
        ),
        statuses,
      })
    );
  };

  return {
    checkDownloaded: checkOne,
    "db.checkDownloaded": checkOne,
    checkDownloadedMany: checkMany,
    "db.checkDownloadedMany": checkMany,

    "db.markDownloaded": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "History writes");
      return respondWith(
        sendResponse,
        markDownloaded(message.record || {
          source: message.source,
          service: message.service,
          userId: message.userId,
          postId: message.postId,
          status: message.status,
          totalCount: message.totalCount,
          successCount: message.successCount,
          failedCount: message.failedCount,
          updatedAt: message.updatedAt,
        }),
        () => ({})
      );
    },

    "db.markMultiple": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "History writes");
      return respondWith(sendResponse, markMultipleDownloaded(message.items), () => ({}));
    },

    "db.export.begin": ({ sender, sendResponse }) => {
      requireExtensionPage(sender, "History export");
      return respondWith(sendResponse, beginHistoryExport(), (result) => result);
    },

    "db.export.page": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "History export");
      return respondWith(
        sendResponse,
        getHistoryExportPage(
          message.afterKey || null,
          message.maxBytes,
          message.generation,
          message.revision
        ),
        (page) => ({ page })
      );
    },

    "db.import.begin": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "History import");
      return respondWith(
        sendResponse,
        beginImportSession({
          schemaVersion: message.schemaVersion,
          exportedAt: message.exportedAt,
          expectedRecords: message.expectedRecords,
        }),
        (sessionId) => ({ sessionId })
      );
    },

    "db.import.chunk": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "History import");
      return respondWith(
        sendResponse,
        appendImportChunk(message.sessionId, message.records, {
          sequence: message.sequence,
          digest: message.digest,
        }),
        (result) => ({ result })
      );
    },

    "db.import.commit": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "History import");
      return respondWith(sendResponse, commitImportSession(message.sessionId), () => ({}));
    },

    "db.import.abort": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "History import");
      return respondWith(sendResponse, abortImportSession(message.sessionId), () => ({}));
    },

    "db.import.status": ({ message, sender, sendResponse }) => {
      requireExtensionPage(sender, "History import");
      return respondWith(
        sendResponse,
        getImportSessionStatus(message.sessionId),
        (status) => ({ status })
      );
    },

    "db.clear": ({ sender, sendResponse }) => {
      requireExtensionPage(sender, "History clear");
      return respondWith(sendResponse, clearDB(), () => ({}));
    },

    "db.stats": ({ sender, sendResponse }) => {
      requireExtensionPage(sender, "History statistics");
      return respondWith(sendResponse, getHistoryStats(), (stats) => ({ stats }));
    },

    "flag.getMany": ({ message, sender, sendResponse }) => {
      requireHistoryReader(sender, "Creator flag reads");
      return respondWith(
        sendResponse,
        getCreatorFlagsMany(message.items || []),
        (flags) => ({ flags })
      );
    },

    "flag.set": ({ message, sender, sendResponse }) => {
      requireHistoryReader(sender, "Creator flag writes");
      return respondWith(
        sendResponse,
        setCreatorFlag(message.service, message.userId, message.value),
        (flag) => ({ flag })
      );
    },
  };
}
