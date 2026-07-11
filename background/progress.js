// background/progress.js - aggregate active batch progress for popup/content UI

const GLOBAL_BATCHES = new Map();
const SNAPSHOT_WRITE_INTERVAL_MS = 500;
let pendingSnapshot = null;
let snapshotWriteTimer = null;

export function getGlobalProgress() {
  let total = 0;
  let processed = 0;
  let acked = 0;
  for (const batch of GLOBAL_BATCHES.values()) {
    total += batch.total || 0;
    processed += batch.processed || 0;
    acked += batch.acked || 0;
  }
  return { total, processed, acked };
}

export function emitGlobalProgress() {
  const progress = getGlobalProgress();
  try {
    chrome.runtime.sendMessage({ action: "globalProgress", ...progress }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    console.warn("[Background] emitGlobalProgress failed", e);
  }

  scheduleProgressSnapshot(progress, progress.total === 0);
}

function writeProgressSnapshot(snapshot) {
  try {
    chrome.storage.local.set(
      {
        globalProgressSnapshot: {
          ...snapshot,
          updatedAt: Date.now(),
        },
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch (e) {
    console.warn("[Background] write progress snapshot failed", e);
  }
}

function scheduleProgressSnapshot(progress, immediate = false) {
  pendingSnapshot = progress;
  if (immediate) {
    if (snapshotWriteTimer) {
      clearTimeout(snapshotWriteTimer);
      snapshotWriteTimer = null;
    }
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    writeProgressSnapshot(snapshot);
    return;
  }
  if (snapshotWriteTimer) return;
  snapshotWriteTimer = setTimeout(() => {
    snapshotWriteTimer = null;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    if (snapshot) writeProgressSnapshot(snapshot);
  }, SNAPSHOT_WRITE_INTERVAL_MS);
}

export function registerBatch(batchId, total) {
  GLOBAL_BATCHES.set(batchId, { total: total || 0, processed: 0, acked: 0 });
  emitGlobalProgress();
}

export function updateProcessed(batchId, delta = 1) {
  const batch = GLOBAL_BATCHES.get(batchId);
  if (!batch) return;
  batch.processed = (batch.processed || 0) + delta;
  emitGlobalProgress();
}

export function updateAcked(batchId, delta = 1) {
  const batch = GLOBAL_BATCHES.get(batchId);
  if (!batch) return;
  batch.acked = (batch.acked || 0) + delta;
  emitGlobalProgress();
}

export function completeBatch(batchId) {
  GLOBAL_BATCHES.delete(batchId);
  emitGlobalProgress();
}
