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
  });
  assert.deepEqual(stored.downloadRulesConfig, value);
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
