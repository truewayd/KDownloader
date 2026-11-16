import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function runtime(language = 'en') {
  const context = vm.createContext({
    window: { addEventListener() {}, dispatchEvent() {} },
    localStorage: { getItem: () => language, setItem() {} },
    navigator: { language }, document: { addEventListener() {} },
  });
  for (const file of ['i18n-en.js', 'i18n.js']) vm.runInContext(readFileSync(new URL(`../truedown/web/${file}`, import.meta.url), 'utf8'), context);
  return context.window.TrueDownI18n;
}

test('nested tracker status translates complete messages without mixed fragments', () => {
  const i18n = runtime();
  const status = [i18n.t('研究模块需要 Aria2 Next v2.5.7 或更高版本及 aria2.replaceBtTrackers；请安装并选择 NEXT'), i18n.t('模块已关闭'), i18n.t('the active engine does not support aria2.replaceBtTrackers')].join('; ');
  assert.doesNotMatch(status, /[\u4e00-\u9fff]/);
  assert.match(status, /v2\.5\.7 or later/);
  assert.match(status, /Module disabled/);
  assert.equal(i18n.t('保存子目录', true), 'Subfolder');
});

test('explicit system text localizes inside protected data surfaces', () => {
  const i18n = runtime();
  const node = { nodeType: 1, tagName: 'SPAN', textContent: '', hasAttribute: name => name === 'data-i18n-text', getAttribute: () => 'BSD-2-Clause，含 GPL 例外' };
  i18n.localize(node);
  assert.equal(node.textContent, 'BSD-2-Clause, with GPL exceptions');
  assert.equal(runtime('zh-CN').t('the active engine does not support aria2.replaceBtTrackers'), '当前引擎不支持替换 Tracker。');
});
