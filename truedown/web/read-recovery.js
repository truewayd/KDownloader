// Retry failed reads at the owning view, never replay a mutation or submission.
const pendingReadRecoveries = new Map();
let readRecoveryDisposed = false;

function cancelReadRetry(key) {
  clearTimeout(pendingReadRecoveries.get(key)?.timer);
  pendingReadRecoveries.delete(key);
}

function cancelReadRetries() {
  for (const key of pendingReadRecoveries.keys()) cancelReadRetry(key);
}

function armReadRetry(entry, delay = entry.delay) {
  clearTimeout(entry.timer);
  if (readRecoveryDisposed || document.hidden) return;
  entry.timer = setTimeout(async () => {
    if (readRecoveryDisposed || entry.running || pendingReadRecoveries.get(entry.key) !== entry) return;
    if (!entry.current()) { cancelReadRetry(entry.key); return; }
    if (document.hidden) return;
    entry.running = true;
    try { await entry.read(); }
    catch { /* The owning view reports the failure and schedules its next read. */ }
    finally { entry.running = false; }
  }, delay);
}

function scheduleReadRetry(key, read, current) {
  if (readRecoveryDisposed || !current()) return;
  const previous = pendingReadRecoveries.get(key);
  const entry = { key, read, current, delay: Math.min(30000, previous ? previous.delay * 2 : 1000), timer: 0 };
  clearTimeout(previous?.timer);
  pendingReadRecoveries.set(key, entry);
  armReadRetry(entry);
}

document.addEventListener("visibilitychange", () => {
  for (const entry of pendingReadRecoveries.values()) armReadRetry(entry);
});
window.addEventListener("online", () => {
  for (const entry of pendingReadRecoveries.values()) armReadRetry(entry, 0);
});
window.addEventListener("pagehide", () => {
  readRecoveryDisposed = true;
  cancelReadRetries();
}, { once: true });

function reconcileReadDraft(base, draft, latest) {
  const merged = { ...latest };
  for (const key of Object.keys(draft)) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(base[key])) merged[key] = draft[key];
  }
  return merged;
}
