import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const asModuleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

globalThis.__gistExportCalls = 0;
globalThis.__gistFetchCalls = 0;
globalThis.fetch = async () => {
  globalThis.__gistFetchCalls++;
  throw new Error('unexpected fetch');
};

const configUrl = asModuleUrl(`
  export async function loadGistConfig() { return { token: "t", gistId: "" }; }
  export async function saveGistConfig() {}
`);
const dbUrl = asModuleUrl(`
  export async function getHistoryStats() { return { bytes: 64 * 1024 * 1024 + 1, records: 1 }; }
  export async function exportDB() { globalThis.__gistExportCalls++; return "{}"; }
  export async function importDB() {}
`);
const networkUrl = asModuleUrl(`
  export async function readLimitedResponseText(response) { return response.text(); }
`);
const source = (await readFile(path.join(root, 'background', 'gist.js'), 'utf8'))
  .replace(/from\s+['"]\.\/config\.js['"]/, `from '${configUrl}'`)
  .replace(/from\s+['"]\.\/db\.js['"]/, `from '${dbUrl}'`)
  .replace(/from\s+['"]\.\/network\.js['"]/, `from '${networkUrl}'`);
const gist = await import(asModuleUrl(source));

test('Gist upload rejects oversized history before materializing or fetching it', async () => {
  await assert.rejects(gist.gistUpload(), /too large/);
  assert.equal(globalThis.__gistExportCalls, 0);
  assert.equal(globalThis.__gistFetchCalls, 0);
});
