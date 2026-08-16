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
  export async function loadExternalLinkFilterConfig() {
    return globalThis.__externalLinkFilterConfig || { mode: 'blacklist', blacklist: ['patreon.com'] };
  }
`);
const networkUrl = asModuleUrl(`
  export async function handleAPIRequest() {
    if (globalThis.__apiResponse) return globalThis.__apiResponse;
    throw new Error('unexpected API request');
  }
  export async function getCookies() { return globalThis.__cookieString || ''; }
  export async function readLimitedResponseText(response) { return response.text(); }
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
let runtimeMessages;
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
      runtimeMessages.push(_payload);
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
globalThis.fetch = (...args) => globalThis.__fetchImplementation(...args);
const download = await import(asModuleUrl(downloadSource));

beforeEach(() => {
  globalThis.chrome = testChrome;
  nativeDownloadCalls = 0;
  nativeDownloadOptions = [];
  runtimeMessages = [];
  globalThis.__apiResponse = null;
  globalThis.__cookieString = '';
  globalThis.__fetchImplementation = async () => ({
    ok: false,
    status: 503,
    async text() { return 'backend unavailable'; },
  });
  globalThis.__backendConfig = {
    enabled: true,
    backendType: 'abdm',
    protocol: 'http',
    host: '127.0.0.1',
    port: 15151,
    concurrency: 1,
    perPostFileLimit: 100,
    retryCount: 0,
    apiKey: 't'.repeat(32),
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

test('rejects media URLs outside supported HTTPS site families', async () => {
  globalThis.__apiResponse = {
    post: { title: 'unsafe' },
    videos: [{ url: 'https://attacker.example/payload.exe' }],
  };

  await assert.rejects(
    download.startFullDownload('patreon', 'creator-1', 'post-1', '', 'https://kemono.cr/post-1'),
    /no trusted HTTPS media URLs/
  );
});

test('does not forward a site cookie to another supported media family', async () => {
  globalThis.__apiResponse = {
    post: { title: 'cross-site media' },
    videos: [{ url: 'https://coomer.st/data/media.jpg' }],
  };
  globalThis.__cookieString = 'session=secret';
  let backendPayload;
  let backendOptions;
  globalThis.__fetchImplementation = async (_url, options) => {
    backendPayload = JSON.parse(options.body);
    backendOptions = options;
    return { ok: true, status: 200, async text() { return ''; } };
  };

  const result = await download.startFullDownload(
    'patreon',
    'creator-1',
    'post-1',
    '',
    'https://kemono.cr/post-1'
  );

  assert.equal(result.success, true);
  assert.equal(backendPayload.downloadSource.link, 'https://coomer.st/data/media.jpg');
  assert.equal('Cookie' in backendPayload.downloadSource.headers, false);
  assert.equal(backendOptions.headers['X-Api-Key'], 't'.repeat(32));
  assert.equal(backendOptions.credentials, 'omit');
});

test('forwards a site cookie through TrueDown for same-family media', async () => {
  globalThis.__apiResponse = {
    post: { title: 'protected media' },
    videos: [{ url: 'https://n1.kemono.cr/data/protected.jpg' }],
  };
  globalThis.__cookieString = 'session=secret; clearance=allowed';
  let backendPayload;
  let backendOptions;
  globalThis.__backendConfig.apiKey = '';
  globalThis.__fetchImplementation = async (_url, options) => {
    backendPayload = JSON.parse(options.body);
    backendOptions = options;
    return { ok: true, status: 200, async text() { return ''; } };
  };

  const result = await download.startFullDownload(
    'patreon',
    'creator-1',
    'post-1',
    '',
    'https://kemono.cr/post-1'
  );

  assert.equal(result.success, true);
  assert.equal(backendPayload.downloadSource.link, 'https://n1.kemono.cr/data/protected.jpg');
  assert.equal(backendPayload.downloadSource.headers.Cookie, 'session=secret; clearance=allowed');
  assert.equal('X-Api-Key' in backendOptions.headers, false);
});

test('backend progress preserves the originating request id', async () => {
  globalThis.__apiResponse = {
    post: { title: 'progress' },
    videos: [{ url: 'https://kemono.cr/data/media.jpg' }],
  };
  globalThis.__fetchImplementation = async () => ({
    ok: true,
    status: 200,
    async text() { return ''; },
  });

  await download.startFullDownload(
    'patreon',
    'creator-1',
    'post-1',
    '',
    'https://kemono.cr/post-1',
    undefined,
    'request-123'
  );

  const progress = runtimeMessages.find((message) => message.action === 'downloadProgress');
  assert.equal(progress.requestId, 'request-123');
});
