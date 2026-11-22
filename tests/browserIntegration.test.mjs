import test from 'node:test';
import assert from 'node:assert/strict';

let config = {}, menus = [], fetches = [];
globalThis.chrome = {
  runtime: {}, i18n: { getMessage: key => key },
  storage: {
    sync: { get: async key => ({ [key]: config }), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  contextMenus: {
    removeAll: async () => { menus = []; },
    create: (menu, done) => { menus.push(menu); done(); },
  },
};
const { browserDownloadLinks, refreshBrowserMenus, sendBrowserDownloads, LINK_MENU, SELECTION_MENU } = await import('../background/browserIntegration.js');

test('browser links reject credentials and unsafe protocols and preserve MEGA fragments', () => {
  assert.deepEqual(browserDownloadLinks({ menuItemId: LINK_MENU, linkUrl: 'javascript:alert(1)' }), []);
  assert.deepEqual(browserDownloadLinks({ menuItemId: LINK_MENU, linkUrl: 'https://user:secret@example.test/file' }), []);
  assert.deepEqual(browserDownloadLinks({ menuItemId: SELECTION_MENU,
    selectionText: 'https://mega.nz/file/id#secret https://mega.nz/file/id#secret\nhttps://example.test/file' }),
  ['https://mega.nz/file/id#secret', 'https://example.test/file']);
  assert.throws(() => browserDownloadLinks({ menuItemId: SELECTION_MENU,
    selectionText: Array.from({ length: 257 }, (_, n) => `https://example.test/${n}`).join(' ') }), RangeError);
});

test('menus follow persisted backend settings and reject stale disabled clicks', async () => {
  config = { enabled: true, contextMenuEnabled: true };
  await Promise.all([refreshBrowserMenus(), refreshBrowserMenus()]);
  assert.deepEqual(menus.map(menu => menu.id), [LINK_MENU, SELECTION_MENU]);
  for (const value of [{ enabled: false, contextMenuEnabled: true }, { enabled: true, contextMenuEnabled: false },
    { enabled: true, contextMenuEnabled: true, backendType: 'gopeed' }]) {
    config = value;
    await refreshBrowserMenus();
    assert.equal(menus.length, 0);
    assert.equal(await sendBrowserDownloads({ menuItemId: LINK_MENU, linkUrl: 'https://example.test/file' }), false);
  }
});

test('browser handoff uses bounded authenticated ABDM batches without page credentials', async t => {
  config = { enabled: true, contextMenuEnabled: true, apiKey: 'a'.repeat(32) };
  fetches = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { fetches.push({ url, ...options }); return new Response('OK'); });
  assert.equal(await sendBrowserDownloads({ menuItemId: LINK_MENU, linkUrl: 'https://example.test/file', pageUrl: 'https://private.test/page' }), true);
  assert.equal(fetches[0].url, 'http://127.0.0.1:15151/add');
  assert.equal(fetches[0].headers['X-Api-Key'], 'a'.repeat(32));
  assert.equal(fetches[0].credentials, 'omit');
  assert.equal(fetches[0].redirect, 'error');
  assert.deepEqual(JSON.parse(fetches[0].body), { items: [{ type: 'http', link: 'https://example.test/file' }], options: { silentAdd: true, silentStart: true } });
  t.mock.method(globalThis, 'fetch', async () => new Response('private error', { status: 503 }));
  await assert.rejects(sendBrowserDownloads({ menuItemId: LINK_MENU, linkUrl: 'https://example.test/file' }), /did not accept/);
});

test('selected anchors target the clicked frame and merge validated links with selected URL text', async t => {
  config = { enabled: true, contextMenuEnabled: true };
  const info = { menuItemId: SELECTION_MENU, frameId: 7, pageUrl: 'https://outer.test/', frameUrl: 'https://frame.test/',
    selectionText: 'Manual https://files.test/text' };
  let mode = 'anchors';
  chrome.scripting = { async executeScript({ target, args }) {
    assert.deepEqual(target, { tabId: 42, frameIds: [7] });
    assert.deepEqual(args, [info.frameUrl, info.selectionText]);
    if (mode === 'restricted') throw new Error('Cannot access frame');
    if (mode === 'disabled') config.enabled = false;
    return [{ result: mode === 'large' ? null : ['https://files.test/manual#part', 'javascript:void(0)', 'https://files.test/text'] }];
  } };
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    sent.push(JSON.parse(body).items.map(item => item.link));
    return new Response('OK');
  });
  await sendBrowserDownloads(info, { id: 42 });
  mode = 'restricted';
  await sendBrowserDownloads(info, { id: 42 });
  mode = 'large';
  await assert.rejects(sendBrowserDownloads(info, { id: 42 }), RangeError);
  mode = 'disabled';
  assert.equal(await sendBrowserDownloads(info, { id: 42 }), false);
  assert.deepEqual(sent, [['https://files.test/manual#part', 'https://files.test/text'], ['https://files.test/text']]);
});
