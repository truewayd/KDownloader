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
const rawSource = await readFile(path.join(root, 'background', 'gist.js'), 'utf8');
const source = rawSource
  .replace(/from\s+['"]\.\/config\.js['"]/, `from '${configUrl}'`)
  .replace(/from\s+['"]\.\/db\.js['"]/, `from '${dbUrl}'`)
  .replace(/from\s+['"]\.\/network\.js['"]/, `from '${networkUrl}'`);
const gist = await import(asModuleUrl(source));

test('Gist upload rejects oversized history before materializing or fetching it', async () => {
  await assert.rejects(gist.gistUpload(), /too large/);
  assert.equal(globalThis.__gistExportCalls, 0);
  assert.equal(globalThis.__gistFetchCalls, 0);
});

let harnessSequence = 0;
async function uploadHarness(t, route) {
  const data = { local: {}, sync: {} };
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { storage: Object.fromEntries(['local', 'sync'].map((area) => [area, {
    async get(key) { return { [key]: structuredClone(data[area][key]) }; },
    async set(values) { Object.assign(data[area], structuredClone(values)); },
  }])) };
  t.after(() => { globalThis.chrome = originalChrome; });
  const configModuleUrl = new URL(`../background/config.js?gist-race=${++harnessSequence}`, import.meta.url).href;
  const config = await import(configModuleUrl);
  await config.saveGistConfig({
    enabled: true, token: 'original-token', gistId: route === 'create' ? '' : 'original-gist',
  });
  const smallDbUrl = asModuleUrl(`
    export async function getHistoryStats() { return { bytes: 100, records: 0 }; }
    export async function exportDB() { return '{}'; }
    export async function importDB() {}
  `);
  const moduleSource = rawSource
    .replace(/from\s+['"]\.\/config\.js['"]/, `from '${configModuleUrl}'`)
    .replace(/from\s+['"]\.\/db\.js['"]/, `from '${smallDbUrl}'`)
    .replace(/from\s+['"]\.\/network\.js['"]/, `from '${networkUrl}'`);
  const upload = (await import(asModuleUrl(moduleSource))).gistUpload;
  let announceRequest;
  let finishRequest;
  const started = new Promise((resolve) => { announceRequest = resolve; });
  const response = new Promise((resolve) => { finishRequest = resolve; });
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    methods.push(options.method);
    if (route === 'replacement' && options.method === 'PATCH') {
      return new Response('', { status: 404 });
    }
    announceRequest();
    return response;
  });
  return {
    config, upload, started, methods,
    finish() { finishRequest(new Response(JSON.stringify({ id: 'uploaded-gist' }))); },
  };
}

for (const route of ['create', 'update', 'replacement']) {
  for (const mutation of ['gist-id', 'token', 'restore-defaults']) {
    test(`a pending Gist ${route} cannot overwrite a newer ${mutation}`, async (t) => {
      const h = await uploadHarness(t, route);
      const pending = h.upload();
      const rejected = assert.rejects(pending, /configuration changed/);
      await h.started;
      if (mutation === 'restore-defaults') await h.config.restoreDefaultConfigs();
      else await h.config.saveGistConfig(mutation === 'gist-id'
        ? { gistId: 'user-selected-gist' } : { token: 'new-token' });
      const expected = await h.config.loadGistConfig();
      h.finish();
      await rejected;
      assert.deepEqual(await h.config.loadGistConfig(), expected);
      assert.deepEqual(h.methods, route === 'replacement' ? ['PATCH', 'POST']
        : [route === 'create' ? 'POST' : 'PATCH']);
    });
  }

  test(`a Gist ${route} persists its id when the configuration is unchanged`, async (t) => {
    const h = await uploadHarness(t, route);
    const pending = h.upload();
    await h.started;
    h.finish();
    assert.deepEqual(await pending, { gistId: 'uploaded-gist' });
    assert.deepEqual(await h.config.loadGistConfig(), {
      enabled: true, token: 'original-token', gistId: 'uploaded-gist',
    });
  });
}
