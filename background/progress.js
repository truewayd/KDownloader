// background/progress.js - aggregate active batch progress for popup/content UI

const GLOBAL_BATCHES = new Map();
const SNAPSHOT_WRITE_INTERVAL_MS = 500;
const RUNTIME_EMIT_INTERVAL_MS = 100;
const aggregate = { total: 0, processed: 0, acked: 0 };
let pendingSnapshot = null;
let snapshotWriteTimer = null;
let pendingRuntimeProgress = null;
let runtimeEmitTimer = null;

export function getGlobalProgress() {
  return { ...aggregate };
}

function sendRuntimeProgress(progress) {
  pendingRuntimeProgress = null;
  try {
    chrome.runtime.sendMessage({ action: "globalProgress", ...progress }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    console.warn("[Background] emitGlobalProgress failed", e);
  }
}

function scheduleRuntimeProgress(progress, immediate = false) {
  pendingRuntimeProgress = progress;
  if (immediate) {
    if (runtimeEmitTimer) {
      clearTimeout(runtimeEmitTimer);
      runtimeEmitTimer = null;
    }
    sendRuntimeProgress(progress);
    return;
  }
  if (runtimeEmitTimer) return;
  runtimeEmitTimer = setTimeout(() => {
    runtimeEmitTimer = null;
    if (pendingRuntimeProgress) sendRuntimeProgress(pendingRuntimeProgress);
  }, RUNTIME_EMIT_INTERVAL_MS);
}

function emitGlobalProgress(immediate = false) {
  const progress = getGlobalProgress();
  scheduleRuntimeProgress(progress, immediate);

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
  const previous = GLOBAL_BATCHES.get(batchId);
  if (previous) {
    aggregate.total -= previous.total;
    aggregate.processed -= previous.processed;
    aggregate.acked -= previous.acked;
  }
  const batch = { total: total || 0, processed: 0, acked: 0 };
  GLOBAL_BATCHES.set(batchId, batch);
  aggregate.total += batch.total;
  emitGlobalProgress(true);
}

export function updateProcessed(batchId, delta = 1) {
  const batch = GLOBAL_BATCHES.get(batchId);
  if (!batch) return;
  batch.processed = (batch.processed || 0) + delta;
  aggregate.processed += delta;
  emitGlobalProgress();
}

export function updateAcked(batchId, delta = 1) {
  const batch = GLOBAL_BATCHES.get(batchId);
  if (!batch) return;
  batch.acked = (batch.acked || 0) + delta;
  aggregate.acked += delta;
  emitGlobalProgress();
}

export function completeBatch(batchId) {
  const batch = GLOBAL_BATCHES.get(batchId);
  if (!batch) return;
  GLOBAL_BATCHES.delete(batchId);
  aggregate.total -= batch.total;
  aggregate.processed -= batch.processed;
  aggregate.acked -= batch.acked;
  emitGlobalProgress(true);
}
