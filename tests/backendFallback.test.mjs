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
  export async function getCookies(url, context) {
    globalThis.__cookieReads = (globalThis.__cookieReads || 0) + 1;
    globalThis.__cookieLookups.push({ url, context });
    if (globalThis.__cookieFailureUrl === url) throw new Error('Site cookies exceed the 64 KiB forwarding safety limit');
    return globalThis.__cookieString || '';
  }
  export async function getDownloadCookieContext(origin, tabId) {
    globalThis.__cookieContextReads++;
    return { origin, tabId };
  }
  export async function readLimitedResponseText(response) { return response.text(); }
`);
const pawchiveUrl = asModuleUrl(`
  export function isCompletePawchivePost(post) { return post && post.has_full === true; }
  export async function fetchPawchivePost() { throw new Error('unexpected post request'); }
  export function buildPawchiveDownloadTasks(post) {
    if (!isCompletePawchivePost(post)) return [];
    return globalThis.__pawMediaTasks || [{ url: 'https://file.pawchive.pw/data/mock.jpg', fileName: 'mock.jpg', type: 'file' }];
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
    getManifest() { return { version: '3.3.0' }; },
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

test('automatic cloud resolution keeps failures manual and forwards no site credentials', async () => {
  globalThis.__backendConfig = { enabled: true, autoResolve: true, backendType: 'abdm', protocol: 'http', host: '127.0.0.1', port: 15151, apiKey: 'k'.repeat(32) };
  const accepted = 'https://drive.google.com/file/d/accepted/view';
  const failed = 'https://www.dropbox.com/s/id/failed.zip';
  const manual = 'https://mega.nz/file/no-key';
  const calls = [];
  globalThis.__fetchImplementation = async (url, options) => {
    calls.push({ url, options });
    const { link } = JSON.parse(options.body);
    return new Response(JSON.stringify({ protocol: 'kdownloader.resolve', version: 1, link, accepted: link === accepted, module: 'google-drive', taskIds: link === accepted ? [1] : [] }));
  };
  const result = await download.resolveExternalLinks([accepted, failed, manual, accepted]);
  assert.deepEqual(result.externalLinks, [failed, manual]);
  assert.deepEqual(result.dispatchedExternalLinks, [accepted]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.url.endsWith('/integrations/kdownloader/v1/resolve'));
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.deepEqual(Object.keys(JSON.parse(call.options.body)), ['link']);
    assert.equal(call.options.headers.Cookie, undefined);
    assert.equal(call.options.headers.Referer, undefined);
  }
  globalThis.__backendConfig.backendType = 'gopeed';
  assert.deepEqual((await download.resolveExternalLinks([accepted])).externalLinks, [accepted]);
  assert.equal(calls.length, 2);
});
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
  globalThis.__cookieContextReads = 0;
  globalThis.__cookieLookups = [];
  globalThis.__cookieFailureUrl = '';
  globalThis.__pawMediaTasks = null;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36' } });
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

test('Pawchive media hand-off identifies the downloader and does not reuse JSON Accept', async () => {
  let payload;
  globalThis.__fetchImplementation = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, async text() { return ''; } };
  };
  const result = await download.startPawchiveDownload('fanbox', '2131660', '9809891', undefined, { id: '9809891', has_full: true });
  assert.equal(result.success, true);
  assert.equal(payload.downloadSource.headers['User-Agent'], 'KDownloader/3.3.0 (+https://github.com/truewayd/KDownloader)');
  assert.equal(payload.downloadSource.headers.Accept, '*/*');
  assert.equal(payload.downloadSource.headers.Referer, 'https://pawchive.pw/fanbox/user/2131660/post/9809891');
  assert.equal(payload.startDownload, true);
  assert.equal(nativeDownloadCalls, 0);
});

test('Pawchive Gopeed hand-off uses the same identifiable media headers', async () => {
  globalThis.__backendConfig = { ...globalThis.__backendConfig, backendType: 'gopeed', gopeedProtocol: 'http', gopeedHost: '127.0.0.1', gopeedPort: 9999 };
  let payload;
  globalThis.__fetchImplementation = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, async text() { return '{"code":0}'; } };
  };
  await download.startPawchiveDownload('fanbox', '2131660', '9809891', undefined, { id: '9809891', has_full: true });
  assert.equal(payload.req.extra.header['User-Agent'], 'KDownloader/3.3.0 (+https://github.com/truewayd/KDownloader)');
  assert.equal(payload.req.extra.header.Accept, '*/*');
});

for (const backendType of ['abdm', 'gopeed']) {
  for (const [userAgentMode, forwardCookies] of [['browser', false], ['backend', true]]) {
    test(`${backendType} ${userAgentMode} UA keeps the cookie choice independent`, async () => {
      globalThis.__backendConfig = { ...globalThis.__backendConfig, backendType, userAgentMode, forwardCookies, gopeedProtocol: 'http', gopeedHost: '127.0.0.1', gopeedPort: 9999 };
      globalThis.__cookieString = 'session=fixture';
      let payload;
      globalThis.__fetchImplementation = async (_url, options) => {
        payload = JSON.parse(options.body);
        return { ok: true, status: 200, async text() { return '{"code":0}'; } };
      };
      await download.startPawchiveDownload('fanbox', '2131660', '9809891', undefined, { id: '9809891', has_full: true });
      const headers = backendType === 'abdm' ? payload.downloadSource.headers : payload.req.extra.header;
      assert.equal(headers['User-Agent'], userAgentMode === 'browser' ? navigator.userAgent : undefined);
      assert.equal(headers.Cookie, forwardCookies ? 'session=fixture' : undefined);
      assert.equal(globalThis.__cookieReads, forwardCookies ? 1 : 0);
    });
  }
  test(`${backendType} browser UA mode forwards the original UA and URL-scoped cookies`, async () => {
    globalThis.__backendConfig = { ...globalThis.__backendConfig, backendType, userAgentMode: 'browser', gopeedProtocol: 'http', gopeedHost: '127.0.0.1', gopeedPort: 9999 };
    globalThis.__cookieString = 'cf_clearance=fixture; session=fixture';
    let payload;
    globalThis.__fetchImplementation = async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200, async text() { return '{"code":0}'; } };
    };
    await download.startPawchiveDownload('fanbox', '2131660', '9809891', 27, { id: '9809891', has_full: true });
    const headers = backendType === 'abdm' ? payload.downloadSource.headers : payload.req.extra.header;
    assert.equal(headers['User-Agent'], navigator.userAgent);
    assert.equal(headers.Cookie, globalThis.__cookieString);
    assert.deepEqual(globalThis.__cookieLookups, [{ url: 'https://file.pawchive.pw/data/mock.jpg', context: { origin: 'https://pawchive.pw', tabId: 27 } }]);
  });

  test(`${backendType} backend UA and disabled cookies add neither header nor cookie reads`, async () => {
    globalThis.__backendConfig = { ...globalThis.__backendConfig, backendType, userAgentMode: 'backend', forwardCookies: false, gopeedProtocol: 'http', gopeedHost: '127.0.0.1', gopeedPort: 9999 };
    let payload;
    globalThis.__fetchImplementation = async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200, async text() { return '{"code":0}'; } };
    };
    await download.startPawchiveDownload('fanbox', '2131660', '9809891', undefined, { id: '9809891', has_full: true });
    const headers = backendType === 'abdm' ? payload.downloadSource.headers : payload.req.extra.header;
    assert.equal(Object.hasOwn(headers, 'User-Agent'), false);
    assert.equal(Object.hasOwn(headers, 'Cookie'), false);
    assert.equal(globalThis.__cookieReads, 0);
    assert.equal(globalThis.__cookieContextReads, 0);
  });
}

test('a later Gopeed cookie-read failure preserves the earlier file dispatch result', async () => {
  globalThis.__backendConfig = { ...globalThis.__backendConfig, backendType: 'gopeed', gopeedProtocol: 'http', gopeedHost: '127.0.0.1', gopeedPort: 9999 };
  globalThis.__cookieFailureUrl = 'https://file.pawchive.pw/data/second.jpg';
  globalThis.__pawMediaTasks = [
    { url: 'https://file.pawchive.pw/data/first.jpg', fileName: 'first.jpg' },
    { url: globalThis.__cookieFailureUrl, fileName: 'second.jpg' },
  ];
  globalThis.__fetchImplementation = async () => ({ ok: true, status: 200, async text() { return '{"code":0}'; } });
  const result = await download.startPawchiveDownload('fanbox', '2131660', '9809891', undefined, { id: '9809891', has_full: true });
  assert.equal(result.successCount, 1);
  assert.deepEqual(result.results.map(value => value.success), [true, false]);
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
  assert.equal(backendPayload.downloadSource.type, 'http');
  assert.equal(backendPayload.startDownload, true);
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

test('restored site filter excludes project media before backend dispatch', async () => {
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
  assert.equal(result.skippedByFilter, true);
  assert.equal(result.filteredCount, 1);
  assert.equal(backendPayload, undefined);
});

for (const host of ['kemono.cr', 'coomer.st']) {
  test(`${host} filters only excluded files and retains allowed backend media`, async () => {
    globalThis.__downloadRulesConfig = { enabled: true, filterMode: 'project', projectExtensions: ['.psd'] };
    globalThis.__apiResponse = { post: { title: 'mixed files' }, videos: [
      { url: `https://${host}/data/source.psd` }, { url: `https://${host}/data/photo.jpg` },
    ] };
    const links = [];
    globalThis.__fetchImplementation = async (_url, options) => {
      links.push(JSON.parse(options.body).downloadSource.link);
      return { ok: true, status: 200, async text() { return ''; } };
    };
    const result = await download.startFullDownload('patreon', 'creator-1', 'post-1', '', `https://${host}/post-1`);
    assert.equal(result.success, true);
    assert.deepEqual(links, [`https://${host}/data/photo.jpg`]);
  });
}

test('Pawchive filtered-only posts retain external links without dispatch or cookies', async () => {
  globalThis.__downloadRulesConfig = { enabled: true, excludedExtensions: ['.psd'] };
  globalThis.__pawMediaTasks = [{ url: 'https://file.pawchive.pw/data/source.psd', fileName: 'source.psd', type: 'file' }];
  const result = await download.startPawchiveDownload('fanbox', 'creator-1', 'post-1', undefined,
    { has_full: true, content: 'https://mega.nz/file/id#key' });
  assert.equal(result.skippedByFilter, true);
  assert.deepEqual(result.externalLinks, ['https://mega.nz/file/id#key']);
  assert.equal(globalThis.__cookieReads, 0);
  assert.equal(nativeDownloadCalls, 0);
});

test('CoomerFans applies the same suffix filter before media dispatch', async () => {
  globalThis.__downloadRulesConfig = { enabled: true, excludedExtensions: ['.jpg'] };
  globalThis.__fetchImplementation = async (_url, options) => {
    assert.notEqual(options?.method, 'POST');
    return { ok: true, status: 200, async text() { return '<a href="https://coomerfans.com/storage/source.jpg">source</a>'; } };
  };
  const result = await download.startCoomerFansDownload('onlyfans', 'creator-1', 'post-1', 'creator');
  assert.equal(result.skippedByFilter, true);
  assert.equal(nativeDownloadCalls, 0);
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
