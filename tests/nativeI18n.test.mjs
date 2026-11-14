import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const web = new URL('../truedown/web/', import.meta.url);
function runtime(saved = null, system = 'en-US') {
 const events = {}, storage = new Map(saved ? [['truedown-language-v1', saved]] : []);
 const context = vm.createContext({ navigator: {language:system}, document:{body:null, documentElement:{}, getElementById:()=>null, addEventListener(){}}, localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}, CustomEvent:class {}, MutationObserver:class {} });
 context.window=context; context.addEventListener=(k,v)=>{events[k]=v};context.dispatchEvent=()=>{};
 for(const file of ['i18n-en.js','i18n.js']) vm.runInContext(readFileSync(new URL(file,web),'utf8'),context);
 return {api:context.TrueDownI18n, context, events, storage};
}
test('language defaults, persistence, invalid preferences and cross-window changes',()=>{
 const {api, events, storage}=runtime();assert.equal(api.language,'en');assert.equal(api.t('下载中'),'Downloading');assert.equal(api.t('已创建 12 个任务'),'Created 12 tasks');assert.equal(api.t('保存失败：opaque error'),'Save failed: opaque error');
 api.setLanguage('zh-CN');assert.equal(api.t('下载中'),'下载中');assert.equal(storage.get('truedown-language-v1'),'zh-CN');
 events.storage({key:'truedown-language-v1',newValue:'en'});assert.equal(api.language,'en');
 assert.equal(runtime('invalid','zh-CN').api.language,'zh-CN');assert.equal(runtime('en','zh-CN').api.language,'en');
});
test('all static HTML UI text has an English message',()=>{
 const {context}=runtime();
 for(const name of readdirSync(web).filter(n=>n.endsWith('.html'))) {
  const source=readFileSync(new URL(name,web),'utf8');
  assert.match(source,/i18n-en.js/);assert.match(source,/i18n.js/);
  for(const match of source.matchAll(/>([^<>]*[\u4e00-\u9fff][^<>]*)</g)) {
   const value=match[1].trim();if(value==='简体中文')continue;
   assert.ok(context.TrueDownEnglish[value],`${name}: ${value}`);
  }
 }
});
test('missing messages and user-supplied values remain literal',()=>{
 const {api}=runtime();for(const text of ['https://example.test/下载中','客户文件.png','<script>alert(1)</script>']) assert.equal(api.t(text),text);
});
test('group labels and menu wording follow language changes',()=>{
 const {api}=runtime('zh-CN');
 assert.equal(api.t('调整此分组'),'编辑分组');
 assert.equal(api.t('恢复整个队列'),'继续全部下载');
 api.setLanguage('en');
 assert.equal(api.t('分组名称'),'Group name');
 assert.equal(api.t('编辑分组'),'Edit group');
 api.setLanguage('zh-CN');
 assert.equal(api.t('调整此分组'),'编辑分组');
});
