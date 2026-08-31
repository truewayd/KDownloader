import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const asModuleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const configUrl = asModuleUrl(`
  export async function loadBackendConfig() { return globalThis.__backendConfig; }
`);
const networkUrl = asModuleUrl(`
  export async function readLimitedResponseText(response) { return response.text(); }
`);
const source = (await readFile(path.join(root, 'background', 'truedown.js'), 'utf8'))
  .replace(/from\s+['"]\.\/config\.js['"]/, `from '${configUrl}'`)
  .replace(/from\s+['"]\.\/network\.js['"]/, `from '${networkUrl}'`);
const { syncDownloadRulesToTrueDown } = await import(asModuleUrl(source));

let calls;

beforeEach(() => {
  calls = [];
  globalThis.__backendConfig = {
    enabled: true,
    backendType: 'abdm',
    protocol: 'http',
    host: '127.0.0.1',
    port: 15151,
    apiKey: 'k'.repeat(32),
  };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, async text() { return '{}'; } };
  };
});

test('syncs rules through the dedicated authenticated TrueDown endpoint', async () => {
  const result = await syncDownloadRulesToTrueDown({
    enabled: true,
    excludedExtensions: ['.psd', '.clip'],
    syncToTrueDown: true,
  });

  assert.deepEqual(result, { state: 'synced' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:15151/settings/download-rules');
  assert.equal(calls[0].options.headers['X-Api-Key'], 'k'.repeat(32));
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    enabled: true,
    excludedExtensions: ['.psd', '.clip'],
  });
});

test('does not contact TrueDown when sync or the backend is disabled', async () => {
  assert.deepEqual(await syncDownloadRulesToTrueDown({ syncToTrueDown: false }), { state: 'disabled' });
  globalThis.__backendConfig.enabled = false;
  assert.deepEqual(await syncDownloadRulesToTrueDown({ syncToTrueDown: true }), {
    state: 'skipped',
    reason: 'backend-disabled',
  });
  assert.equal(calls.length, 0);
});

test('surfaces authentication and endpoint failures without hiding the status', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() { return 'TrueDown API Key is required'; },
  });
  await assert.rejects(
    syncDownloadRulesToTrueDown({ enabled: false, excludedExtensions: [], syncToTrueDown: true }),
    /HTTP 401.*API Key is required/,
  );
});
