import { loadBackendConfig } from './config.js';
import { readLimitedResponseText } from './network.js';

const RULE_SYNC_TIMEOUT_MS = 15 * 1000;

export async function syncDownloadRulesToTrueDown(rules, configuredBackend) {
  if (!rules?.syncToTrueDown) return { state: 'disabled' };
  const backend = configuredBackend || await loadBackendConfig();
  if (!backend.enabled) return { state: 'skipped', reason: 'backend-disabled' };
  if (backend.backendType !== 'abdm') return { state: 'skipped', reason: 'backend-type' };

  const endpoint = `${backend.protocol}://${backend.host}:${backend.port}/settings/download-rules`;
  const headers = { 'Content-Type': 'application/json' };
  if (backend.apiKey) headers['X-Api-Key'] = backend.apiKey;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      enabled: rules.enabled === true,
      excludedExtensions: Array.isArray(rules.excludedExtensions) ? rules.excludedExtensions : [],
    }),
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(RULE_SYNC_TIMEOUT_MS),
  });
  let body = '';
  try {
    body = await readLimitedResponseText(response, 16 * 1024, 'TrueDown filter sync');
  } catch (error) {
    if (response.ok) throw error;
  }
  if (!response.ok) {
    throw new Error(`TrueDown filter sync HTTP ${response.status}${body ? `: ${body.slice(0, 200).trim()}` : ''}`);
  }
  return { state: 'synced' };
}
