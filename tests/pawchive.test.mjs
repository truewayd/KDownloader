import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const asModuleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const notifications = [];

const pawchiveChrome = {
  cookies: {
    async get() {
      return { name: 'cf_clearance', value: 'test-clearance' };
    },
  },
  i18n: {
    getMessage(key) {
      return key;
    },
    getUILanguage() {
      return 'zh-CN';
    },
  },
  notifications: {
    create(id, options, callback) {
      notifications.push({ id, options });
      callback(id);
    },
  },
  runtime: {
    lastError: null,
    getURL(value) {
      return `chrome-extension://test/${value}`;
    },
  },
};
globalThis.chrome = pawchiveChrome;
globalThis.__pawchiveTestChrome = pawchiveChrome;

function mockHeaders(values = {}) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => normalized.get(String(name).toLowerCase()) || null };
}

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    headers: mockHeaders({ 'content-type': 'application/json' }),
    async text() {
      return JSON.stringify(value);
    },
  };
}

const constantsSource = await readFile(path.join(root, 'background', 'constants.js'), 'utf8');
const constantsUrl = asModuleUrl(constantsSource);
const networkSource = (`const chrome = globalThis.__pawchiveTestChrome;\n${await readFile(path.join(root, 'background', 'network.js'), 'utf8')}`)
  .replaceAll('globalThis.chrome', 'globalThis.__pawchiveTestChrome')
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`);
const networkUrl = asModuleUrl(networkSource);
const network = await import(networkUrl);
const utilSource = (await readFile(path.join(root, 'background', 'util.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`);
const utilUrl = asModuleUrl(utilSource);
const pawchiveSource = (await readFile(path.join(root, 'background', 'pawchive.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`)
  .replace(/from\s+['"]\.\/network\.js['"]/, `from '${networkUrl}'`)
  .replace(/from\s+['"]\.\/util\.js['"]/, `from '${utilUrl}'`);
const pawchive = await import(asModuleUrl(pawchiveSource));

test('builds Pawchive creator and single-post API URLs', () => {
  assert.equal(
    pawchive.pawchiveCreatorApiUrl('patreon', 'creator-1', 73),
    'https://pawchive.pw/api/v1/patreon/user/creator-1?o=50'
  );
  assert.equal(
    pawchive.pawchivePostApiUrl('patreon', 'creator-1', 'post-1'),
    'https://pawchive.pw/api/v1/patreon/user/creator-1/post/post-1'
  );
  assert.equal(
    pawchive.pawchiveDmsUrl('patreon', 'creator-1'),
    'https://pawchive.pw/patreon/user/creator-1/dms'
  );
});

test('extracts Pawchive DM dates, readable text, and link targets from HTML', () => {
  const html = `
    <main>
      <article class="dm-card ">
        <section class="dm-card__body" tabindex="0">
          <div class="dm-card__content"><p>Links renewed &amp; ready</p>
            <p><a href="https://example.com/file?a=1&amp;b=2" rel="nofollow">Open pack</a></p>
          </div>
        </section>
        <footer class="dm-card__footer"><div class="dm-card__added"> Published: 2026-07 </div></footer>
      </article>
      <article class='dm-card featured'>
        <div class='dm-card__content'><p>Second message<br>next line</p></div>
        <div class='dm-card__added'>Published: 2026-06-30</div>
      </article>
    </main>`;

  const messages = pawchive.parsePawchiveDmsHtml(html);
  assert.deepEqual(messages, [
    {
      published: '2026-07',
      text: 'Links renewed & ready\n\nOpen pack (https://example.com/file?a=1&b=2)',
    },
    { published: '2026-06-30', text: 'Second message\nnext line' },
  ]);
  assert.equal(pawchive.formatPawchiveDmsText(messages, {
    service: 'patreon',
    userId: 'creator-1',
    sourceUrl: pawchive.pawchiveDmsUrl('patreon', 'creator-1'),
  }), [
    'Pawchive DMs',
    'Service: patreon',
    'User: creator-1',
    'Source: https://pawchive.pw/patreon/user/creator-1/dms',
    'Messages: 2',
    '',
    '[2026-07]',
    'Links renewed & ready',
    '',
    'Open pack (https://example.com/file?a=1&b=2)',
    '',
    '---',
    '',
    '[2026-06-30]',
    'Second message',
    'next line',
    '',
  ].join('\n'));
});

test('fetches only the fixed Pawchive creator DMs HTML page with browser credentials', async () => {
  const requested = [];
  globalThis.fetch = async (url, options) => {
    requested.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: mockHeaders({ 'content-type': 'text/html' }),
      async text() {
        return '<article class="dm-card"><div class="dm-card__content">Hello</div></article>';
      },
    };
  };

  const result = await pawchive.fetchPawchiveDms('fanbox', 'creator-2');
  assert.equal(result.url, 'https://pawchive.pw/fanbox/user/creator-2/dms');
  assert.deepEqual(result.messages, [{ published: '', text: 'Hello' }]);
  assert.equal(requested[0].options.credentials, 'include');
  assert.match(requested[0].options.headers.Accept, /^text\/html/);
  await assert.rejects(
    network.fetchPawchiveDmsHtml('https://pawchive.pw/fanbox/user/creator-2/posts'),
    /unexpected Pawchive HTML URL/
  );
});

test('builds only file.pawchive.pw data tasks and preserves API names', () => {
  const tasks = pawchive.buildPawchiveDownloadTasks({
    id: 'post-1',
    has_full: true,
    file: { name: 'cover.jpeg', path: '/4b/81/cover.jpeg' },
    attachments: [
      { name: 'audio.mp3', path: '/aa/bb/audio.mp3' },
      { name: 'duplicate.jpeg', path: '/4b/81/cover.jpeg' },
    ],
  });

  assert.deepEqual(tasks, [
    {
      url: 'https://file.pawchive.pw/data/4b/81/cover.jpeg',
      fileName: 'cover.jpeg',
      type: 'file',
    },
    {
      url: 'https://file.pawchive.pw/data/aa/bb/audio.mp3',
      fileName: 'audio.mp3',
      type: 'attachment',
    },
  ]);
});

test('skips incomplete Pawchive posts before creating download tasks', () => {
  assert.equal(pawchive.isCompletePawchivePost({ has_full: false }), false);
  assert.deepEqual(pawchive.buildPawchiveDownloadTasks({
    has_full: false,
    file: { name: 'partial.jpg', path: '/partial.jpg' },
  }), []);
});

test('parses an object for single posts and an array for creator pages', async () => {
  const requested = [];
  globalThis.fetch = async (url, options) => {
    requested.push({ url, options });
    if (url.includes('/post/')) {
      return jsonResponse({ id: 'post-1', has_full: true, attachments: [] });
    }
    return jsonResponse([{ id: 'post-1', has_full: true }, { id: 'post-2', has_full: false }]);
  };

  assert.equal((await pawchive.fetchPawchivePost('patreon', 'creator-1', 'post-1')).id, 'post-1');
  assert.equal((await pawchive.fetchPawchiveCreatorPage('patreon', 'creator-1', 50)).length, 2);
  assert.deepEqual(requested.map(({ url }) => url), [
    'https://pawchive.pw/api/v1/patreon/user/creator-1/post/post-1',
    'https://pawchive.pw/api/v1/patreon/user/creator-1?o=50',
  ]);
  for (const { options } of requested) {
    assert.equal(options.credentials, 'include');
    assert.equal(options.mode, 'cors');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'follow');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers['Accept-Language'], 'zh-CN');
    assert.equal(Object.hasOwn(options.headers, 'Cookie'), false);
  }
});

test('fetches every Pawchive creator page in 50-post offsets and deduplicates posts', async () => {
  const requested = [];
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    id: `post-${index + 1}`,
    has_full: true,
  }));
  globalThis.fetch = async (url) => {
    requested.push(url);
    if (url.endsWith('?o=50')) {
      return jsonResponse([
        { id: 'post-50', has_full: true },
        { id: 'post-51', has_full: true },
      ]);
    }
    return jsonResponse(firstPage);
  };

  const posts = await pawchive.fetchAllPawchiveCreatorPosts('patreon', 'creator-1');
  assert.equal(posts.length, 51);
  assert.equal(posts.at(-1).id, 'post-51');
  assert.deepEqual(requested, [
    'https://pawchive.pw/api/v1/patreon/user/creator-1',
    'https://pawchive.pw/api/v1/patreon/user/creator-1?o=50',
  ]);
});

test('prefers a verified Pawchive tab for same-origin API requests', async () => {
  const messages = [];
  pawchiveChrome.tabs = {
    async query(query) {
      assert.deepEqual(query, { url: 'https://pawchive.pw/*' });
      return [
        { id: 7, active: false, lastAccessed: 10 },
        { id: 9, active: true, lastAccessed: 5 },
      ];
    },
    async sendMessage(tabId, message) {
      messages.push({ tabId, message });
      return {
        success: true,
        response: {
          ok: true,
          status: 200,
          url: message.url,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([{ id: 'post-from-tab', has_full: true }]),
        },
      };
    },
  };
  globalThis.fetch = async () => {
    throw new Error('background fetch should not run when a Pawchive tab is available');
  };

  try {
    const posts = await pawchive.fetchPawchiveCreatorPage('patreon', 'creator-1', 0);
    assert.equal(posts[0].id, 'post-from-tab');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].tabId, 9);
    assert.equal(messages[0].message.action, 'pawchive.api.fetch');
    assert.equal(messages[0].message.headers.Accept, 'application/json');
    assert.equal(Object.hasOwn(messages[0].message.headers, 'Cookie'), false);
  } finally {
    delete pawchiveChrome.tabs;
  }
});

test('opens Pawchive from the Cloudflare notification action', async () => {
  const created = [];
  pawchiveChrome.tabs = {
    async create(options) {
      created.push(options);
      return { id: 11, ...options };
    },
  };

  try {
    await network.openPawchiveForVerification();
    assert.deepEqual(created, [{ url: 'https://pawchive.pw', active: true }]);
  } finally {
    delete pawchiveChrome.tabs;
  }
});

test('failed scheduled probe silently opens a pinned background Pawchive tab', async () => {
  const created = [];
  const messages = [];
  notifications.length = 0;
  pawchiveChrome.tabs = {
    async query() {
      return [];
    },
    async create(options) {
      created.push(options);
      return { id: 21, ...options };
    },
    async sendMessage(tabId, message) {
      messages.push({ tabId, message });
      return { ready: message.action === 'pawchive.api.ping' };
    },
  };
  globalThis.fetch = async () => {
    throw new Error('scheduled direct probe failed');
  };

  try {
    const result = await network.preparePawchiveWatchRequest(
      'https://pawchive.pw/api/v1/patreon/user/creator-1/profile'
    );
    assert.equal(result.opened, true);
    assert.equal(result.tabAvailable, true);
    assert.equal(result.hasPrefetched, false);
    assert.deepEqual(created, [{
      url: 'https://pawchive.pw',
      active: false,
      pinned: true,
    }]);
    assert.deepEqual(messages, [{
      tabId: 21,
      message: { action: 'pawchive.api.ping' },
    }]);
    assert.equal(notifications.length, 0);
  } finally {
    delete pawchiveChrome.tabs;
  }
});

test('detects a Cloudflare challenge and creates one actionable notification', async () => {
  notifications.length = 0;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    url: 'https://pawchive.pw/api/v1/patreon/user/creator-1',
    headers: mockHeaders({
      'cf-mitigated': 'challenge',
      'cf-ray': 'test-ray',
      'content-type': 'text/html',
      server: 'cloudflare',
    }),
    async text() {
      return '<!doctype html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/test"></script>';
    },
  });

  await assert.rejects(
    pawchive.fetchPawchiveCreatorPage('patreon', 'creator-1', 0),
    (error) => error.code === 'PAWCHIVE_CLOUDFLARE_BLOCKED' && /HTTP 403/.test(error.message)
  );
  await assert.rejects(
    pawchive.fetchPawchiveCreatorPage('patreon', 'creator-1', 0),
    (error) => error.code === 'PAWCHIVE_CLOUDFLARE_BLOCKED'
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].id, 'pawchive-cloudflare-blocked');
  assert.equal(notifications[0].options.requireInteraction, true);
  assert.equal(notifications[0].options.title, 'pawchiveCloudflareTitle');
  assert.equal(notifications[0].options.buttons[0].title, 'openPawchiveAction');
});
