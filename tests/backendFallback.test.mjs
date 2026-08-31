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
  export async function getCookies() {
    globalThis.__cookieReads = (globalThis.__cookieReads || 0) + 1;
    return globalThis.__cookieString || '';
  }
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
    sendMessage(_tabId, payload, callback) {
      globalThis.__backendTabMessageHook?.(payload);
      callback?.();
    },
  },
};

globalThis.chrome = testChrome;
globalThis.fetch = (...args) => globalThis.__fetchImplementation(...args);
const download = await import(asModuleUrl(downloadSource));
const downloadInternals = await import(asModuleUrl(
  downloadSource
  .replace('class TaskQueue', 'export class TaskQueue')
  .replace('const GLOBAL_TASK_QUEUE = new TaskQueue();', 'export const GLOBAL_TASK_QUEUE = new TaskQueue();')
  .replace('async function dispatchAllToBackend(tasks, backendCfg, context)', 'export async function dispatchAllToBackend(tasks, backendCfg, context)')
  .replace('const MAX_PENDING_BACKEND_TASKS = 10_000;', 'const MAX_PENDING_BACKEND_TASKS = 3;')
  .replace(
    'let currentDelay = CONFIG.TASK_INTERVAL_INITIAL || CONFIG.TASK_INTERVAL;',
    'let currentDelay = 0;'
  )
  .replace(
    'function extractCoomerFansMediaUrls(html)',
    'export function extractCoomerFansMediaUrls(html)'
  )
));

beforeEach(() => {
  globalThis.chrome = testChrome;
  nativeDownloadCalls = 0;
  nativeDownloadOptions = [];
  runtimeMessages = [];
  globalThis.__apiResponse = null;
  globalThis.__cookieString = '';
  globalThis.__cookieReads = 0;
  globalThis.__downloadRulesConfig = { enabled: false, excludedExtensions: [] };
  globalThis.__backendTabMessageHook = null;
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
  assert.equal(globalThis.__cookieReads, 0);
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
  assert.equal('Origin' in backendPayload.downloadSource.headers, false);
  assert.equal('Referer' in backendPayload.downloadSource.headers, false);
  assert.equal(backendOptions.headers['X-Api-Key'], 't'.repeat(32));
  assert.equal(backendOptions.credentials, 'omit');
  assert.equal(backendOptions.redirect, 'error');
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
  assert.equal(
    backendPayload.downloadSource.headers.Referer,
    'https://kemono.cr/patreon/user/creator-1/post/post-1'
  );
  assert.equal('Origin' in backendPayload.downloadSource.headers, false);
  assert.equal('X-Api-Key' in backendOptions.headers, false);
});

test('Gopeed also omits a full post Referer for cross-family media', async () => {
  globalThis.__backendConfig = {
    ...globalThis.__backendConfig,
    backendType: 'gopeed',
    gopeedProtocol: 'http',
    gopeedHost: '127.0.0.1',
    gopeedPort: 9999,
    gopeedToken: '',
  };
  globalThis.__apiResponse = {
    post: { title: 'cross-site media' },
    videos: [{ url: 'https://coomer.st/data/media.jpg' }],
  };
  let gopeedPayload;
  globalThis.__fetchImplementation = async (_url, options) => {
    gopeedPayload = JSON.parse(options.body);
    return { ok: true, status: 200, async text() { return ''; } };
  };

  const result = await download.startFullDownload(
    'patreon', 'creator-1', 'post-1', '', 'https://kemono.cr/post-1'
  );

  assert.equal(result.success, true);
  assert.equal('Referer' in gopeedPayload.req.extra.header, false);
  assert.equal('Cookie' in gopeedPayload.req.extra.header, false);
});

test('keeps Dropbox parsing and filter configuration out of per-file task requests', async () => {
  assert.doesNotMatch(
    downloadSource,
    /list_shared_link_folder_entries|fetch_user_content_link|secure_hash|next_request_voucher/
  );
  globalThis.__apiResponse = {
    post: { title: 'filter sync' },
    videos: [{ url: 'https://kemono.cr/data/media.jpg' }],
  };
  let backendPayload;
  globalThis.__fetchImplementation = async (_url, options) => {
    backendPayload = JSON.parse(options.body);
    return { ok: true, status: 200, async text() { return ''; } };
  };

  const result = await download.startFullDownload(
    'patreon', 'creator-1', 'post-1', '', 'https://kemono.cr/post-1'
  );

  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(backendPayload, 'downloadRules'), false);
});

test('Dropbox filter settings do not remove ordinary site media tasks', async () => {
  globalThis.__downloadRulesConfig = { enabled: true, excludedExtensions: ['.psd'] };
  globalThis.__apiResponse = {
    post: { title: 'ordinary project file' },
    videos: [{ url: 'https://kemono.cr/data/source.psd' }],
  };
  let backendPayload;
  globalThis.__fetchImplementation = async (_url, options) => {
    backendPayload = JSON.parse(options.body);
    return { ok: true, status: 200, async text() { return ''; } };
  };

  const result = await download.startFullDownload(
    'patreon', 'creator-1', 'post-1', '', 'https://kemono.cr/post-1'
  );

  assert.equal(result.success, true);
  assert.equal(backendPayload.downloadSource.link, 'https://kemono.cr/data/source.psd');
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

test('CoomerFans HTML cannot create an unbounded media task array', () => {
  const html = Array.from(
    { length: 5001 },
    (_, index) => `<a href="https://coomerfans.com/storage/${index}.jpg">file</a>`
  ).join('');
  assert.equal(downloadInternals.extractCoomerFansMediaUrls(html).length, 5000);
});

test('CoomerFans media scanning stays synchronized after many unclosed tags', () => {
  const malformed = '<a data-no-close '.repeat(25000);
  const expected = 'https://coomerfans.com/storage/final.jpg';
  const html = `${malformed}<img title="quoted > delimiter" data-src="${expected}">`;
  assert.deepEqual(downloadInternals.extractCoomerFansMediaUrls(html), [expected]);
  assert.doesNotMatch(downloadSource, /tagRe\s*=\s*\/<\(source\|video\|a\|img\).*\[\^>\]\*/);
});

test('backend queue rejects overflow atomically and restores capacity after draining', async () => {
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  globalThis.__fetchImplementation = async () => {
    await fetchGate;
    return { ok: true, status: 200, async text() { return ''; } };
  };

  const queue = new downloadInternals.TaskQueue(1);
  const options = {
    endpoint: 'http://127.0.0.1:15151/start-headless-download',
    origin: 'https://kemono.cr',
    service: 'patreon',
    userId: 'creator-1',
    postId: 'post-1',
    headers: {},
  };
  const tasks = Array.from({ length: 3 }, (_, index) => ({
    url: `https://kemono.cr/data/${index}.jpg`,
    fileName: `${index}.jpg`,
  }));
  const draining = queue.enqueueTasks(tasks, options);
  await assert.rejects(
    queue.enqueueTasks([{ url: 'https://kemono.cr/data/overflow.jpg', fileName: 'overflow.jpg' }], options),
    /pending-task limit/
  );

  releaseFetch();
  assert.equal((await draining).length, 3);
  assert.equal((await queue.enqueueTasks([
    { url: 'https://kemono.cr/data/recovered.jpg', fileName: 'recovered.jpg' },
  ], options)).length, 1);

  const unexpected = await queue.enqueueTasks([
    { url: 'https://kemono.cr/data/invalid.jpg', fileName: 'invalid.jpg' },
  ], { ...options, userId: '\ud800' });
  assert.equal(unexpected[0].success, false);
  const afterFailure = await queue.enqueueTasks([
    { url: 'https://kemono.cr/data/after-failure.jpg', fileName: 'after-failure.jpg' },
  ], options);
  assert.equal(afterFailure[0].success, true);
});

test('a later backend batch overflow preserves earlier successes as a partial result', async () => {
  let releasePressure;
  const pressureGate = new Promise((resolve) => { releasePressure = resolve; });
  globalThis.__fetchImplementation = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.name.startsWith('pressure-')) await pressureGate;
    return { ok: true, status: 200, async text() { return ''; } };
  };

  let pressurePromise;
  globalThis.__backendTabMessageHook = (message) => {
    if (message.action !== 'downloadProgress' || message.sentCount !== 1 || pressurePromise) return;
    const pressureTasks = Array.from({ length: 3 }, (_, index) => ({
      url: `https://kemono.cr/data/pressure-${index}.jpg`,
      fileName: `pressure-${index}.jpg`,
    }));
    pressurePromise = downloadInternals.GLOBAL_TASK_QUEUE.enqueueTasks(pressureTasks, {
      endpoint: 'http://127.0.0.1:15151/start-headless-download',
      origin: 'https://kemono.cr',
      service: 'patreon',
      userId: 'pressure',
      postId: 'pressure',
      headers: {},
    });
  };

  const tasks = [
    { url: 'https://kemono.cr/data/first.jpg', fileName: 'first.jpg' },
    { url: 'https://kemono.cr/data/second.jpg', fileName: 'second.jpg' },
  ];
  try {
    const results = await downloadInternals.dispatchAllToBackend(tasks, {
      protocol: 'http',
      host: '127.0.0.1',
      port: 15151,
      concurrency: 1,
      perPostFileLimit: 1,
      retryCount: 0,
    }, {
      origin: 'https://kemono.cr',
      service: 'patreon',
      userId: 'creator-1',
      postId: 'post-1',
      headers: {},
      senderTabId: 7,
      defaultFileLimit: 1,
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].success, true);
    assert.equal(results[1].success, false);
    assert.match(results[1].error, /pending-task limit/);
  } finally {
    releasePressure();
    if (pressurePromise) await pressurePromise;
  }
});

test('backend queue keeps workers available after lowering idle concurrency', async () => {
  globalThis.__fetchImplementation = async () => ({
    ok: true,
    status: 200,
    async text() { return ''; },
  });
  const queue = new downloadInternals.TaskQueue(6);
  await Promise.resolve();
  queue.setConcurrency(3);
  const completed = queue.enqueueTasks([{
    url: 'https://kemono.cr/data/after-resize.jpg',
    fileName: 'after-resize.jpg',
  }], {
    endpoint: 'http://127.0.0.1:15151/start-headless-download',
    origin: 'https://kemono.cr',
    service: 'patreon',
    userId: 'creator-1',
    postId: 'post-1',
    headers: {},
  });
  let timeoutId;
  const stalled = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('queue resize stalled')), 1000);
  });
  const result = await Promise.race([completed, stalled]).finally(() => clearTimeout(timeoutId));
  assert.equal(result.length, 1);
  assert.equal(result[0].success, true);
});
