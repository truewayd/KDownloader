import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const asModuleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const stored = {};

globalThis.chrome = {
  storage: {
    sync: {
      async get(key) {
        return Object.hasOwn(stored, key) ? { [key]: structuredClone(stored[key]) } : {};
      },
      async set(values) {
        Object.assign(stored, structuredClone(values));
      },
    },
  },
};

const constantsUrl = asModuleUrl(await readFile(path.join(root, 'background', 'constants.js'), 'utf8'));
const utilSource = (await readFile(path.join(root, 'background', 'util.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`);
const configSource = (await readFile(path.join(root, 'background', 'config.js'), 'utf8'))
  .replace(/from\s+['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`);
const util = (await import(asModuleUrl(utilSource))).default;
const config = await import(asModuleUrl(configSource));

beforeEach(() => {
  for (const key of Object.keys(stored)) delete stored[key];
});

test('download extension filtering is disabled by default', async () => {
  const value = await config.loadDownloadRulesConfig();
  assert.equal(value.enabled, false);
  assert.equal(value.syncToTrueDown, true);
  assert.ok(value.excludedExtensions.includes('.psd'));
  assert.ok(value.excludedExtensions.includes('.clip'));
});

test('download rules normalize suffixes and reject invalid values', async () => {
  const value = await config.saveDownloadRulesConfig({
    enabled: true,
    excludedExtensions: ['PSD', '.clip', '.PSD', '.procreate', '../pyc', ''],
  });
  assert.deepEqual(value, {
    enabled: true,
    excludedExtensions: ['.psd', '.clip', '.procreate'],
    syncToTrueDown: true,
  });
  assert.deepEqual(stored.downloadRulesConfig, value);

  const syncDisabled = await config.saveDownloadRulesConfig({
    enabled: false,
    excludedExtensions: [],
    syncToTrueDown: false,
  });
  assert.equal(syncDisabled.syncToTrueDown, false);
});

test('external link filtering defaults to a user-editable Patreon domain blacklist', async () => {
  assert.deepEqual(await config.loadExternalLinkFilterConfig(), {
    mode: 'blacklist',
    blacklist: ['patreon.com'],
  });

  const saved = await config.saveExternalLinkFilterConfig({
    mode: 'blacklist',
    blacklist: [' Example.com ', '*.FILES.EXAMPLE.com', 'example.com', 'https://invalid.example/path', ''],
  });
  assert.deepEqual(saved, {
    mode: 'blacklist',
    blacklist: ['example.com', 'files.example.com'],
  });
  assert.deepEqual(stored.externalLinkFilterConfig, saved);
});

test('normalizes Creator Fetch modes and preserves legacy fullMode compatibility', () => {
  assert.equal(util.normalizeCreatorFetchMode('default'), 'default');
  assert.equal(util.normalizeCreatorFetchMode('full'), 'full');
  assert.equal(util.normalizeCreatorFetchMode('links'), 'links');
  assert.equal(util.normalizeCreatorFetchMode('dms'), 'dms');
  assert.equal(util.normalizeCreatorFetchMode('unexpected'), 'default');
  assert.equal(util.normalizeCreatorFetchMode(undefined, true), 'full');
});

test('builds a generic UTF-8 text download task', () => {
  const task = util.buildTextDownloadTask('Published: 2026-07\nHello & goodbye\n', 'patreon_creator_dms.txt', 'pawchive_dms_txt');
  assert.equal(task.fileName, 'patreon_creator_dms.txt');
  assert.equal(task.type, 'pawchive_dms_txt');
  assert.equal(decodeURIComponent(task.url.split(',', 2)[1]), 'Published: 2026-07\nHello & goodbye\n');
});

test('filters case-insensitive project suffixes using file names then URLs', () => {
  const tasks = [
    { url: 'https://files.invalid/a', fileName: 'drawing.PSD' },
    { url: 'https://files.invalid/source.clip?download=1', fileName: 'Untitled' },
    { url: 'https://files.invalid/a', fileName: 'canvas.procreate' },
    { url: 'https://files.invalid/photo.jpg', fileName: 'photo.jpg' },
    { url: 'https://files.invalid/no-extension', fileName: 'notes' },
  ];
  const filtered = util.filterDownloadTasks(tasks, {
    enabled: true,
    excludedExtensions: ['.psd', '.clip', '.procreate'],
  });
  assert.deepEqual(filtered, [tasks[3], tasks[4]]);
  assert.deepEqual(util.filterDownloadTasks(tasks, { enabled: false }), tasks);
});

test('extracts all HTTP links without dropping query strings or MEGA keys', () => {
  const links = util.extractExternalLinks(`
    <a href="https://example.invalid/custom?id=1#part">custom</a>
    https://mega.nz/file/abc#secret-key
    https://mega.nz/file/abc
    https://example.invalid/custom?id=1#part
  `);
  assert.deepEqual(links, [
    'https://example.invalid/custom?id=1#part',
    'https://mega.nz/file/abc#secret-key',
    'https://mega.nz/file/abc',
  ]);
});

test('extracts provider links from flat and wrapped post embeds', () => {
  const dropboxUrl = 'https://www.dropbox.com/scl/fo/ibju6f6q1ohywlbu1f1em/APvTAy3vnHQip_vEOt-0w1s?rlkey=vaw05ep4cio2051ph3of0paxu&st=buynhedk&dl=0';
  const post = {
    id: '15583',
    content: '<p>Thank you! <a href="https://example.invalid/help">Help</a></p>',
    embed: {
      url: dropboxUrl,
      provider: 'Dropbox',
      provider_url: 'Dropbox',
    },
  };

  assert.deepEqual(util.extractPostExternalLinks(post), [
    'https://example.invalid/help',
    dropboxUrl,
  ]);
  assert.deepEqual(util.extractPostExternalLinks({ post }), [
    'https://example.invalid/help',
    dropboxUrl,
  ]);
});

test('deduplicates extracted links and filters blacklisted domains and subdomains', () => {
  const links = [
    'https://www.patreon.com/posts/1',
    'https://patreon.com/posts/2',
    'https://notpatreon.com/file',
    'https://dropbox.com/file?id=1',
    'https://dropbox.com/file?id=1',
  ];
  assert.deepEqual(util.filterExternalLinks(links, {
    mode: 'blacklist',
    blacklist: ['patreon.com'],
  }), [
    'https://notpatreon.com/file',
    'https://dropbox.com/file?id=1',
  ]);
  assert.deepEqual(util.filterExternalLinks(links, { mode: 'disabled', blacklist: ['patreon.com'] }), links.slice(0, 4));
});

test('builds a sorted deduplicated TXT task and adds source posts for keyless MEGA links', () => {
  const task = util.buildExternalLinksTextTask([
    { url: 'https://z.example/file', sourceUrl: 'https://site.example/post/2' },
    { url: 'https://mega.nz/file/no-key', sourceUrl: 'https://site.example/post/1' },
    { url: 'https://mega.nz/file/with-key#secret', sourceUrl: 'https://site.example/post/3' },
    { url: 'https://z.example/file', sourceUrl: 'https://site.example/post/4' },
  ], 'creator-links.txt');

  assert.equal(task.fileName, 'creator-links.txt');
  assert.equal(task.type, 'external_links_txt');
  const text = decodeURIComponent(task.url.split(',', 2)[1]);
  assert.equal(text, [
    'https://mega.nz/file/no-key',
    'https://mega.nz/file/with-key#secret',
    'https://site.example/post/1',
    'https://z.example/file',
    '',
  ].join('\n'));
});
