// background/handlers/dbHandlers.js - downloaded history and creator flag RPCs
import {
  checkDownloaded,
  checkDownloadedMany,
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
  setLastAccess,
  getCreatorFlagsMany,
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

    "db.markDownloaded": ({ message, sendResponse }) =>
      respondWith(
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
      ),

    "db.markMultiple": ({ message, sendResponse }) =>
      respondWith(sendResponse, markMultipleDownloaded(message.items), () => ({})),

    "db.export.begin": ({ sendResponse }) =>
      respondWith(sendResponse, beginHistoryExport(), (result) => result),

    "db.export.page": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        getHistoryExportPage(message.afterKey || null, message.maxBytes, message.generation),
        (page) => ({ page })
      ),

    "db.import.begin": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        beginImportSession({
          schemaVersion: message.schemaVersion,
          exportedAt: message.exportedAt,
          expectedRecords: message.expectedRecords,
        }),
        (sessionId) => ({ sessionId })
      ),

    "db.import.chunk": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        appendImportChunk(message.sessionId, message.records, {
          sequence: message.sequence,
          digest: message.digest,
        }),
        (result) => ({ result })
      ),

    "db.import.commit": ({ message, sendResponse }) =>
      respondWith(sendResponse, commitImportSession(message.sessionId), () => ({})),

    "db.import.abort": ({ message, sendResponse }) =>
      respondWith(sendResponse, abortImportSession(message.sessionId), () => ({})),

    "db.import.status": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        getImportSessionStatus(message.sessionId),
        (status) => ({ status })
      ),

    "db.clear": ({ sendResponse }) =>
      respondWith(sendResponse, clearDB(), () => ({})),

    "db.stats": ({ sendResponse }) =>
      respondWith(sendResponse, getHistoryStats(), (stats) => ({ stats })),

    "flag.getMany": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        getCreatorFlagsMany(message.items || []),
        (flags) => ({ flags })
      ),

    "flag.set": ({ message, sendResponse }) =>
      respondWith(
        sendResponse,
        setCreatorFlag(message.service, message.userId, message.value),
        (flag) => ({ flag })
      ),
  };
}
