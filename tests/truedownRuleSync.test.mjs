import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const asModuleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const synced = {}, local = {};
const storage = values => ({ async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
  async set(next) { Object.assign(values, structuredClone(next)); } });
globalThis.chrome = { storage: { sync: storage(synced), local: storage(local) } };
const constantsUrl = asModuleUrl(await readFile(path.join(root, 'background/constants.js'), 'utf8'));
const utilUrl = asModuleUrl((await readFile(path.join(root, 'background/util.js'), 'utf8')).replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`));
const configUrl = asModuleUrl((await readFile(path.join(root, 'background/config.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`).replace(/from\s+['"]\.\/util\.js['"]/, `from '${utilUrl}'`));
const config = await import(configUrl);
const networkUrl = asModuleUrl("export async function readLimitedResponseText(response, maximum) {\n"
  + "const text = await response.text(); if (Buffer.byteLength(text) > maximum) throw new Error('response too large'); return text;\n}");
const source = (await readFile(path.join(root, 'background/truedown.js'), 'utf8'))
  .replace(/from\s+['"]\.\/config\.js['"]/, `from '${configUrl}'`).replace(/from\s+['"]\.\/network\.js['"]/, `from '${networkUrl}'`);
const { syncDownloadRulesFromTrueDown } = await import(asModuleUrl(source));
const remoteRules = () => ({ enabled: true, filterMode: 'custom', excludedExtensions: ['.work.project'], dropboxMode: 'expand', megaMode: 'expand' });
let calls, remote;
const response = value => ({ ok: true, status: 200, async text() { return JSON.stringify(value); } });

beforeEach(async () => {
  for (const key of Object.keys(synced)) delete synced[key];
  for (const key of Object.keys(local)) delete local[key];
  calls = []; remote = remoteRules();
  await config.saveBackendConfig({ enabled: true, backendType: 'abdm', apiKey: 'k'.repeat(32) });
  await config.saveDownloadRulesConfig({ filterMode: 'custom', excludedExtensions: ['.psd'], syncFromTrueDown: true });
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return response(remote); };
});

test('pulls authenticated rules without writing TrueDown or forwarding cookies', async () => {
  const result = await syncDownloadRulesFromTrueDown();
  assert.equal(result.sync.state, 'synced');
  assert.deepEqual(result.config.excludedExtensions, ['.work.project']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:15151/settings/download-rules');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers['X-Api-Key'], 'k'.repeat(32));
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(synced.downloadRulesConfig, result.config);
  assert.equal(Object.hasOwn(result.config, 'dropboxMode'), false);
  assert.equal(JSON.stringify(result).includes('k'.repeat(32)), false);
});

test('resolves project mode against the current Engineering group and retains custom null', async () => {
  remote = { ...remoteRules(), filterMode: 'project', excludedExtensions: null };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/settings/file-groups') ? { groups: [{ id: 'project', extensions: ['.blend', '.work.project'] }] } : remote);
  };
  const result = await syncDownloadRulesFromTrueDown();
  assert.equal(result.config.filterMode, 'project');
  assert.equal(result.config.excludedExtensions, null);
  assert.deepEqual(result.config.projectExtensions, ['.blend', '.work.project']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
});

test('explicitly empty custom exclusions stay empty', async () => {
  remote.excludedExtensions = [];
  assert.deepEqual((await syncDownloadRulesFromTrueDown()).config.excludedExtensions, []);
});

test('disabled sync and incompatible backends never make a request', async () => {
  await config.saveDownloadRulesConfig({ syncFromTrueDown: false });
  assert.equal((await syncDownloadRulesFromTrueDown()).sync.state, 'disabled');
  await config.saveDownloadRulesConfig({ syncFromTrueDown: true });
  await config.saveBackendConfig({ enabled: false });
  assert.equal((await syncDownloadRulesFromTrueDown()).sync.reason, 'backend-disabled');
  await config.saveBackendConfig({ enabled: true, backendType: 'gopeed' });
  assert.equal((await syncDownloadRulesFromTrueDown()).sync.reason, 'backend-type');
  assert.equal(calls.length, 0);
});

test('invalid, oversized and unauthorized responses retain saved rules and bounded errors', async () => {
  const initial = await config.loadDownloadRulesConfig();
  for (const value of [{}, { ...remoteRules(), filterMode: 'unknown' }, { ...remoteRules(), excludedExtensions: ['../bad'] },
    { ...remoteRules(), extra: 'x'.repeat(16384) }]) {
    globalThis.fetch = async () => response(value);
    const result = await syncDownloadRulesFromTrueDown();
    assert.equal(result.sync.state, 'failed');
    assert.deepEqual(result.config, initial);
  }
  globalThis.fetch = async () => ({ ok: false, status: 401, async text() { return 'private token ' + 'k'.repeat(32); } });
  const result = await syncDownloadRulesFromTrueDown();
  assert.equal(result.sync.error, 'TrueDown filter sync HTTP 401');
  assert.deepEqual(result.config, initial);
});

test('missing Engineering groups fail without silently replacing the local list', async () => {
  remote = { ...remoteRules(), filterMode: 'project', excludedExtensions: null };
  globalThis.fetch = async url => response(url.endsWith('/settings/file-groups') ? { groups: [] } : remote);
  const result = await syncDownloadRulesFromTrueDown();
  assert.equal(result.sync.state, 'failed');
  assert.deepEqual(result.config.excludedExtensions, ['.psd']);
});

test('a delayed response cannot undo newer settings, resets or backend credentials', async () => {
  for (const change of [() => config.saveDownloadRulesConfig({ filterMode: 'off' }), () => config.restoreDefaultConfigs(),
    () => config.saveBackendConfig({ apiKey: 'n'.repeat(32) }), () => config.saveDownloadRulesConfig({ syncFromTrueDown: false })]) {
    await config.saveBackendConfig({ enabled: true, backendType: 'abdm', apiKey: 'k'.repeat(32) });
    await config.saveDownloadRulesConfig({ filterMode: 'custom', excludedExtensions: ['.psd'], syncFromTrueDown: true });
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    globalThis.fetch = async () => { started(); await gate; return response(remote); };
    const pending = syncDownloadRulesFromTrueDown();
    await entered; await change();
    const latest = await config.loadDownloadRulesConfig();
    release();
    const result = await pending;
    assert.equal(result.sync.state, 'conflict');
    assert.deepEqual(result.config, latest);
    assert.deepEqual(await config.loadDownloadRulesConfig(), latest);
  }
});

test('a failed pull leaves the serialized sync queue available for a retry', async () => {
  globalThis.fetch = async () => { throw new Error('unavailable'); };
  assert.equal((await syncDownloadRulesFromTrueDown()).sync.state, 'failed');
  globalThis.fetch = async () => response(remote);
  assert.equal((await syncDownloadRulesFromTrueDown()).sync.state, 'synced');
});
