// Included only by the macOS debug fixture. Native code polls the result;
// neither readiness nor completion depends on a WebView timer.
function beginMacosEvaluation(id, operation) {
  window.__acceptanceResult = { id, done: false };
  Promise.resolve().then(operation).then(Boolean).catch(() => false).then(ok => {
    if (window.__acceptanceResult?.id === id) {
      window.__acceptanceResult = { id, done: true, ok };
    }
  });
}
