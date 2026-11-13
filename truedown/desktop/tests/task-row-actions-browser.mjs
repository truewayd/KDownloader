import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = process.env.TRUEDOWN_PLAYWRIGHT_MODULE ? require(process.env.TRUEDOWN_PLAYWRIGHT_MODULE) : await import("playwright");
const source = (await readFile(new URL("../../web/app.js", import.meta.url), "utf8")).replace(/\r\n?/g, "\n");
const names = ["taskRow", "actionButton", "onTaskAction", "setTaskActionBusy"];
const declarations = names.map(name => {
 const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
 assert.ok(match, name); return match[0];
}).join("\n");
let browser;
try {
 browser = await chromium.launch({headless:true,...(process.env.TRUEDOWN_CHROME_PATH ? {executablePath:process.env.TRUEDOWN_CHROME_PATH}: {})});
 const page = await browser.newPage(); const errors=[];page.on("pageerror",error=>errors.push(error.message));
 await page.setContent('<table class="tasks-table"><colgroup><col><col><col><col><col><col><col><col class="col-actions"></colgroup><tbody id="tasks"></tbody></table>');
 for (const file of ["styles.css", "workspace.css"]) await page.addStyleTag({content: await readFile(new URL(`../../web/${file}`, import.meta.url), "utf8")});
 await page.evaluate(() => {
  window.calls=[]; window.activeTaskActions=new Set();window.updateTaskIDs=new Set();window.taskDetailData=null;window.selectedTaskIDs=new Set();
  window.statusMeta=Object.fromEntries(["done","queued","downloading","paused","error"].map(status=>[status,{label:status}]));
  window.els={tasksContainer:document.getElementById("tasks")};
  window.esc=value=>String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  window.iconMarkup=name=>`<svg class="icon" aria-hidden="true" data-icon="${name}"></svg>`;
  window.taskCategoryMeta=()=>({icon:"file",label:"文件"});
  for(const name of ["taskProgressLabel","taskProgressPercent","taskBytes","taskSpeed","taskRemaining","taskDate","formatTaskError"]) window[name]=()=>"";
  window.KDComponents={setBusyState:(button,busy)=>{button.disabled=busy;}};
  window.invokeNative=async(command,args)=>{calls.push({action:command,id:args.id});};
  window.openTaskDetails=async id=>{calls.push({action:"details",id});};
  window.showToast=()=>{};
 });
 await page.addScriptTag({content:declarations});
 await page.evaluate(()=>{
  window.renderRows=()=>{els.tasksContainer.innerHTML=["done","downloading","queued","paused","error"].map((status,i)=>taskRow({id:i+1,status,outputName:i===0?'<sample> "archive".zip':`${status}.bin`})).join("");};
  renderRows();els.tasksContainer.addEventListener("click",onTaskAction);
 });
 const expected={1:["preview","open-file","open-folder","details","remove"],2:["open-folder","pause","remove"],3:["open-folder","pause","remove"],4:["open-folder","resume","remove"],5:["open-folder","requeue","remove"]};
 for(const [id,actions] of Object.entries(expected)) {
  const row=page.locator(`[data-task-id="${id}"]`);
  assert.deepEqual(await row.locator('.row-actions button').evaluateAll(buttons=>buttons.map(button=>button.dataset.action)),actions);
  await row.locator('.task-name-button').click();
  assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{action:id==='1'?'open_task_preview':'details',id:Number(id)});
 }
 const done=page.locator('[data-task-id="1"]');
 assert.ok(await done.locator('.row-actions').evaluate(element => element.scrollWidth <= element.clientWidth), 'completed actions fit the column');
 for (const button of await done.locator('.row-actions button').all()) assert.ok((await button.boundingBox()).width >= 29, 'action buttons retain their hit area');
 assert.equal(await done.locator('.task-name-button').textContent(),'<sample> "archive".zip');
 assert.equal(await done.locator('.task-name-button').getAttribute('aria-label'),'预览文件：<sample> "archive".zip');
 for(const [selector,action] of [['.row-actions [data-action="preview"]','open_task_preview'],['.row-actions [data-action="details"]','details']]) {
  await done.locator(selector).click();assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{action,id:1});
 }
 await done.locator('.task-name-button').focus();await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{action:'open_task_preview',id:1});
 await done.locator('.row-actions [data-action="details"]').focus();await page.keyboard.press('Space');assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{action:'details',id:1});
 // A task becoming complete must change its primary action on the next row render.
 await page.evaluate(()=>{els.tasksContainer.innerHTML=taskRow({id:2,status:'done',outputName:'now-complete.zip'});});
 await page.locator('.task-name-button').click();assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{action:'open_task_preview',id:2});
 assert.deepEqual(errors,[]);console.log('Task list actions: all statuses, completed action order, name clicks, explicit preview/details, keyboard activation and completion transition passed');
} finally {await browser?.close();}

