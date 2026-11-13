import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire(import.meta.url);
const { chromium } = process.env.TRUEDOWN_PLAYWRIGHT_MODULE ? require(process.env.TRUEDOWN_PLAYWRIGHT_MODULE) : await import('playwright');
const assets = new URL('../../web/', import.meta.url);
const server = http.createServer(async (req,res) => {
 const name = new URL(req.url,'http://localhost').pathname.slice(1);
 if (!/^[a-z0-9-]+\.(html|css|js|svg)$/.test(name)) {res.writeHead(404).end();return;}
 try {res.setHeader('Content-Type', {html:'text/html',css:'text/css',js:'text/javascript',svg:'image/svg+xml'}[name.split('.').at(-1)]);res.end(await readFile(new URL(name,assets)));}catch {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({headless:true,...(process.env.TRUEDOWN_CHROME_PATH ? {executablePath:process.env.TRUEDOWN_CHROME_PATH}: {})});
 const page=await browser.newPage({viewport:{width:1000,height:760}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.__TRUEDOWN_PLATFORM__='windows'; window.events={}; window.requests=[]; window.mode='normal';
  window.__TAURI__={event:{listen:async (name,cb)=>{events[name]=cb;return ()=>{};}}, core:{invoke:async (command,args)=>{
   if(command==='task_preview_state')return {id:1,revision:1,open:true};
   if(command==='frame_state')return {maximized:false};if(command==='frame_tooltip')return 1;
   if(command!=='core_request')return false;
   requests.push(args.request.path);const u=new URL(args.request.path,location.origin);
   if(u.pathname!=='/tasks/archive-preview')throw new Error('Unexpected fallback: '+u.pathname);
   const cursor=Number(u.searchParams.get('cursor'));const id=Number(u.searchParams.get('id'));
   if(cursor>0&&mode==='retry'){window.mode='normal';return {status:500,body:'temporary failure'};}
   if(cursor>0&&mode==='changed')return {status:400,body:'Archive changed during preview; reopen the preview'};
   if(cursor>0&&mode==='slow')await new Promise(resolve=>{window.releasePage=resolve;});
   if(mode==='malicious')return {status:400,body:'Archive contains duplicate entry names'};
   const total=id===2?1:451;const entries=Array.from({length:Math.min(200,total-cursor)},(_,i)=>({name:cursor===0&&i===0?'<img src=x onerror="window.injected=true">.txt':`folder/file-${cursor+i}.txt`,directory:false,declaredSize:1024}));
   return {status:200,body:JSON.stringify({name:id===2?'other.zip':'pages.zip',format:'zip',size:1024**3,files:total,directories:0,cursor,version:'a'.repeat(64),entries,...(cursor+200<total?{nextCursor:cursor+200}:{})})};
  }}};
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/task-preview.html?window=task-preview`);
 const count=()=>page.locator('.archive-entry').count();await page.waitForFunction(()=>document.querySelectorAll('.archive-entry').length===200);
 assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);
 await page.getByRole('button',{name:'加载更多',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.archive-entry').length===400);
 assert.equal(await page.getByRole('button',{name:'加载更多',exact:true}).isEnabled(),true);
 await page.getByRole('button',{name:'加载更多',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.archive-entry').length===451);
 assert.equal(await page.locator('.archive-more').isVisible(),false);assert.equal(await count(),451);
 assert.ok(await page.evaluate(()=>requests.some(s=>s.includes('cursor=400&version='))));
 let revision=1;
 const open=async(id=1)=>{revision++;await page.evaluate(({id,revision})=>events['truedown:task-preview']({payload:{id,revision,open:true}}),{id,revision});await page.waitForFunction(()=>document.querySelectorAll('.archive-entry').length===200);};
 await open();await page.evaluate(()=>window.mode='retry');await page.locator('.archive-more').click();await page.waitForFunction(()=>document.querySelector('#preview-status').textContent.includes('temporary failure'));assert.equal(await count(),200);
 await page.locator('.archive-more').click();await page.waitForFunction(()=>document.querySelectorAll('.archive-entry').length===400);
 await page.evaluate(()=>window.mode='changed');await page.locator('.archive-more').click();await page.waitForFunction(()=>document.querySelector('#preview-status').textContent.includes('Archive changed'));assert.equal(await count(),400);
 await page.evaluate(()=>window.mode='normal');await open();await page.evaluate(()=>window.mode='slow');await page.locator('.archive-more').click();await page.waitForFunction(()=>Boolean(window.releasePage));
 revision++;await page.evaluate(revision=>events['truedown:task-preview']({payload:{id:2,revision,open:true}}),revision);await page.waitForFunction(()=>document.querySelector('#preview-info').textContent.includes('other.zip'));
 await page.evaluate(()=>releasePage());await page.waitForTimeout(100);assert.equal(await count(),1);assert.equal(await page.locator('#preview-status').textContent(),'已显示 1 个条目');
 for(const width of [1000,360]) {await page.setViewportSize({width,height:480});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 revision++;await page.evaluate(revision=>{window.mode='malicious';events['truedown:task-preview']({payload:{id:3,revision,open:true}});},revision);await page.waitForFunction(()=>document.querySelector('#preview-status').textContent.includes('duplicate'));assert.equal(await count(),0);
 assert.deepEqual(errors,[]);console.log('Archive browser: 3 pages, retry, changed file, stale completion, inert names, large metadata and responsive layout passed');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
