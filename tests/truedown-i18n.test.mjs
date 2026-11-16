import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function runtime() {
  const listeners = new Map();
  let observer;
  const context = vm.createContext({
    window: { addEventListener() {} },
    document: { addEventListener: (name, callback) => listeners.set(name, callback), documentElement: {}, body: null, querySelector: () => null, getElementById: () => null },
    localStorage: { getItem: () => 'en' }, navigator: { language: 'en' },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
  });
  vm.runInContext(readFileSync(new URL('../truedown/web/i18n-en.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../truedown/web/i18n.js', import.meta.url), 'utf8'), context);
  listeners.get('DOMContentLoaded')();
  return { t: context.window.TrueDownI18n.t, mutate: records => observer(records) };
}

test('MediaFire description translates whole sentences without mixed Chinese', () => {
  const { t } = runtime();
  const source = '下载公开文件，或将公开目录展开为独立任务。受密码、登录或验证码保护的链接需手动处理。';
  const expected = 'Downloads public files or expands public folders into individual tasks. Links protected by passwords, login or CAPTCHA require manual handling.';
  assert.equal(t(source, true), expected);
  assert.equal(t(source, true), expected, 'cached translation is identical');
  assert.equal(t('  ' + source + '\n', true), '  ' + expected + '\n');
});

test('attribute changes translate only that attribute, without scanning descendants', () => {
  const { mutate } = runtime();
  let value = '检查更新';
  const node = {
    closest: () => null, hasAttribute: () => true,
    getAttribute: () => value, setAttribute: (_, next) => { value = next; },
    get childNodes() { throw new Error('attribute update must not traverse descendants'); },
  };
  mutate([{ type: 'attributes', target: node, attributeName: 'aria-label' }]);
  assert.equal(value, 'Check for updates');
  mutate([{ type: 'attributes', target: node, attributeName: 'aria-label' }]);
  assert.equal(value, 'Check for updates', 'self-generated mutation settles');
});
