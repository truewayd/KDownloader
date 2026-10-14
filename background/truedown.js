import { captureTrueDownRuleSync, commitTrueDownDownloadRules, loadDownloadRulesConfig } from './config.js';
import { readLimitedResponseText } from './network.js';

const RULE_SYNC_TIMEOUT_MS = 15 * 1000;
let ruleSyncQueue = Promise.resolve();

export function syncDownloadRulesFromTrueDown() {
  const run = ruleSyncQueue.then(performRuleSync);
  ruleSyncQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function fetchSettings(backend, path, signal, maximum = 16 * 1024) {
  const endpoint = `${backend.protocol}://${backend.host}:${backend.port}${path}`;
  const headers = {};
  if (backend.apiKey) headers['X-Api-Key'] = backend.apiKey;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers,
    credentials: 'omit',
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { }
    throw new Error(`TrueDown filter sync HTTP ${response.status}`);
  }
  const body = await readLimitedResponseText(response, maximum, 'TrueDown filter sync');
  try { return JSON.parse(body); } catch { throw new Error('Invalid TrueDown filter response'); }
}

function validExtensions(value) {
  return Array.isArray(value) && value.length <= 128
    && value.every(extension => typeof extension === 'string' && /^\.[a-z0-9]{1,16}(\.[a-z0-9]{1,16}){0,3}$/.test(extension));
}

async function performRuleSync() {
  const snapshot = await captureTrueDownRuleSync();
  const { config, backend } = snapshot;
  if (!config.syncFromTrueDown) return { config, sync: { state: 'disabled' } };
  if (!backend.enabled) return { config, sync: { state: 'skipped', reason: 'backend-disabled' } };
  if (backend.backendType !== 'abdm') return { config, sync: { state: 'skipped', reason: 'backend-type' } };
  try {
    const signal = AbortSignal.timeout(RULE_SYNC_TIMEOUT_MS);
    const remote = await fetchSettings(backend, '/settings/download-rules', signal);
    if (!remote || !['off', 'project', 'custom'].includes(remote.filterMode)
        || remote.enabled !== (remote.filterMode !== 'off')
        || !['direct', 'expand'].includes(remote.dropboxMode) || !['archive', 'expand'].includes(remote.megaMode)
        || (remote.excludedExtensions !== null && !validExtensions(remote.excludedExtensions))) {
      throw new Error('Invalid TrueDown filter response');
    }
    let projectExtensions = config.projectExtensions;
    if (remote.filterMode === 'project') {
      const groups = await fetchSettings(backend, '/settings/file-groups', signal, 64 * 1024);
      const project = Array.isArray(groups?.groups) ? groups.groups.filter(group => group?.id === 'project') : [];
      if (project.length !== 1 || !validExtensions(project[0].extensions)) throw new Error('Invalid TrueDown Engineering group');
      projectExtensions = project[0].extensions;
    }
    return await commitTrueDownDownloadRules(snapshot, { filterMode: remote.filterMode,
      excludedExtensions: remote.excludedExtensions, projectExtensions });
  } catch (error) {
    return { config: await loadDownloadRulesConfig(), sync: { state: 'failed',
      error: /^TrueDown filter sync HTTP \d{3}$/.test(error?.message) ? error.message : 'TrueDown filter synchronization failed' } };
  }
}
