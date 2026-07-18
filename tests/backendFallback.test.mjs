import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const asModuleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const constantsUrl = asModuleUrl(await readFile(path.join(root, 'background', 'constants.js'), 'utf8'));
const utilSource = (await readFile(path.join(root, 'background', 'util.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`);
const utilUrl = asModuleUrl(utilSource);
const configUrl = asModuleUrl(`
  export async function loadBackendConfig() { return globalThis.__backendConfig; }
  export async function loadDownloadRulesConfig() {
    return globalThis.__downloadRulesConfig || { enabled: false, excludedExtensions: [] };
  }
`);
const networkUrl = asModuleUrl(`
  export async function handleAPIRequest() { throw new Error('unexpected API request'); }
  export async function getCookies() { return ''; }
`);
const pawchiveUrl = asModuleUrl(`
  export function isCompletePawchivePost(post) { return post && post.has_full === true; }
  export async function fetchPawchivePost() { throw new Error('unexpected post request'); }
  export function buildPawchiveDownloadTasks(post) {
    if (!isCompletePawchivePost(post)) return [];
    return [{ url: 'https://file.pawchive.pw/data/mock.jpg', fileName: 'mock.jpg', type: 'file' }];
  }
`);
const downloadSource = (await readFile(path.join(root, 'background', 'download.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`)
  .replace(/from\s+['"]\.\/util\.js['"]/, `from '${utilUrl}'`)
  .replace(/from\s+['"]\.\/config\.js['"]/, `from '${configUrl}'`)
  .replace(/from\s+['"]\.\/network\.js['"]/, `from '${networkUrl}'`)
  .replace(/from\s+['"]\.\/pawchive\.js['"]/, `from '${pawchiveUrl}'`);

let nativeDownloadCalls;
let nativeDownloadOptions;
const testChrome = {
  downloads: {
    download(options, callback) {
      nativeDownloadCalls++;
      nativeDownloadOptions.push(options);
      callback(100 + nativeDownloadCalls);
    },
  },
  runtime: {
    id: 'test-extension',
    lastError: null,
    sendMessage(_payload, callback) {
      callback?.();
    },
  },
  tabs: {
    sendMessage(_tabId, _payload, callback) {
      callback?.();
    },
  },
};

globalThis.chrome = testChrome;
globalThis.fetch = async () => ({
  ok: false,
  status: 503,
  async text() { return 'backend unavailable'; },
});
const download = await import(asModuleUrl(downloadSource));

beforeEach(() => {
  globalThis.chrome = testChrome;
  nativeDownloadCalls = 0;
  nativeDownloadOptions = [];
  globalThis.__backendConfig = {
    enabled: true,
    backendType: 'abdm',
    protocol: 'http',
    host: '127.0.0.1',
    port: 15151,
    concurrency: 1,
    perPostFileLimit: 100,
    retryCount: 0,
  };
});

test('total backend failure returns pending tasks without silently using Chrome downloads', async () => {
  const result = await download.startPawchiveDownload(
    'patreon',
    'creator-1',
    'post-1',
    undefined,
    { id: 'post-1', has_full: true }
  );
  assert.equal(result.backendFailed, true);
  assert.equal(result.fallbackTasks.length, 1);
  assert.equal(nativeDownloadCalls, 0);
});

test('disabled backend still uses the normal Chrome download path directly', async () => {
  globalThis.__backendConfig = { enabled: false };
  const result = await download.startPawchiveDownload(
    'patreon',
    'creator-1',
    'post-1',
    undefined,
    { id: 'post-1', has_full: true }
  );
  assert.equal(result.success, true);
  assert.equal(result.successCount, 1);
  assert.equal(nativeDownloadCalls, 1);
});

test('downloads the aggregated external-link TXT directly through Chrome', async () => {
  const result = await download.dispatchExternalLinksTextTask([
    { url: 'https://mega.nz/file/no-key', sourceUrl: 'https://pawchive.pw/patreon/user/creator-1/post/post-1' },
  ], {
    fileName: 'patreon_creator-1_creator_links.txt',
    origin: 'https://pawchive.pw',
    service: 'patreon',
    userId: 'creator-1',
  });

  assert.equal(result.success, true);
  assert.equal(nativeDownloadCalls, 1);
  assert.equal(nativeDownloadOptions[0].filename, 'patreon_creator-1_creator_links.txt');
  assert.equal(nativeDownloadOptions[0].saveAs, false);
  assert.equal(nativeDownloadOptions[0].conflictAction, 'uniquify');
  assert.match(nativeDownloadOptions[0].url, /^data:text\/plain;charset=utf-8,/);
  const text = decodeURIComponent(nativeDownloadOptions[0].url.split(',', 2)[1]);
  assert.match(text, /https:\/\/mega\.nz\/file\/no-key/);
  assert.match(text, /https:\/\/pawchive\.pw\/patreon\/user\/creator-1\/post\/post-1/);
});
