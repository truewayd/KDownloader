import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";

if (process.platform !== "linux" || !process.env.DISPLAY) throw new Error("Run this test inside xvfb-run and dbus-run-session");
const application = path.resolve(process.argv[2] || "target/debug/TrueDown");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-webkit-"));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(check, milliseconds = 30000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("WebKit acceptance timed out");
}
const port = await freePort(), nativePort = await freePort(), corePort = await freePort();
const endpoint = `http://127.0.0.1:${port}`;
const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(nativePort)], {
  stdio: ["ignore", "pipe", "pipe"],
  // WebKit never allocates a usable viewport for a never-mapped GTK window.
  // Map only inside this required Xvfb display, then verify close-to-hide below.
  env: { ...process.env, GDK_BACKEND: "x11", TRUEDOWN_DESKTOP_TEST: "", TRUEDOWN_ADDR: `127.0.0.1:${corePort}`, TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "", TAURI_WEBVIEW_AUTOMATION: "true" },
});
let diagnostic = "", session, downloadFixture;
for (const stream of [driver.stdout, driver.stderr]) stream.on("data", data => { diagnostic = (diagnostic + data.toString()).slice(-8192); });
async function request(method, route, body) {
  const response = await fetch(endpoint + route, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(route.endsWith("/screenshot") ? 5000 : 45000) });
  const value = await response.json();
  if (!response.ok || value.value?.error) throw new Error(value.value?.message || JSON.stringify(value));
  return value.value;
}
const command = (method, route, body) => request(method, `/session/${session}${route}`, body);
async function evaluate(script, args = []) {
  const result = await command("POST", "/execute/async", { script: `const done=arguments[arguments.length-1]; (async()=>{${script}})().then(value=>done({value}),error=>done({error:String(error)}));`, args });
  if (result.error) throw new Error(result.error);
  return result.value;
}
try {
  await until(() => fetch(endpoint + "/status").then(response => response.ok, () => false));
  const created = await request("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, args: ["--data-dir", profile] } } } });
  session = created.sessionId;
  await command("POST", "/timeouts", { script: 15000, pageLoad: 30000, implicit: 0 });
  await until(() => evaluate("return Boolean(window.__TAURI__ && document.querySelector('#task-count'))"));
  // Require the native ACL rejection; reaching a missing-file error is a failure.
  await assert.rejects(evaluate("return window.__TAURI__.core.invoke('plugin:image|from_path',{path:arguments[0]})", [path.join(profile, "__acl_image_must_not_exist__.png")]),
    /image\.from_path not allowed\. Permissions associated with this command: [^\r\n]*core:image:allow-from-path|Command plugin:image\|from_path not allowed by ACL/);
  assert.equal(await evaluate("return window.__TRUEDOWN_PLATFORM__"), "linux");
  const info = await evaluate("return window.__TAURI__.core.invoke('core_request',{request:{method:'GET',path:'/system/info'}})");
  assert.equal(JSON.parse(info.body).product, "TrueDown");
  for (const kind of ["settings", "logs", "about", "new-task", "batch-task"]) await evaluate("return window.__TAURI__.core.invoke('open_auxiliary',{kind:arguments[0]})", [kind]);
  const handles = await until(async () => { const handles = await command("GET", "/window/handles"); return handles.length === 4 && handles; });
  let settings, main;
  const forms = {};
  for (const handle of handles) {
    await command("POST", "/window", { handle });
    const role = await evaluate("return document.documentElement.dataset.nativeWindow || 'main'");
    if (role === "settings") settings = handle;
    if (role === "main") main = handle;
    if (role === "new-task" || role === "batch-task") forms[role] = handle;
    assert.equal(await evaluate("return document.querySelectorAll('.native-titlebar').length"), 0);
    assert.equal(await evaluate("return document.querySelectorAll('[data-window-action]').length"), 0);
    assert.equal((await evaluate("return window.__TAURI__.core.invoke('frame_state')")).decorated, true);
    await evaluate("showToast('Native title clearance '.repeat(12),'error');return true");
    await until(() => evaluate("const toast=document.querySelector('#toast');return toast.classList.contains('is-visible') && toast.getAnimations().every(animation=>animation.playState==='finished')"));
    const toast = await evaluate("const element=document.querySelector('#toast');const {x,y,width,right,bottom}=element.getBoundingClientRect();return {x,y,width,right,bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,textFits:element.scrollWidth<=element.clientWidth}");
    assert.ok(Math.abs(toast.x+toast.width/2-toast.viewportWidth/2)<1 && Math.abs(toast.y-16)<1 && toast.x>=16 && toast.right<=toast.viewportWidth-16 && toast.bottom<=toast.viewportHeight-24 && toast.textFits, JSON.stringify(toast));
  }
  assert.ok(settings && main);
  await command("POST", "/window", { handle: settings });
  await evaluate("document.querySelector('[data-settings-link=general]').click(); return true");
  await until(() => evaluate("return !document.querySelector('[data-settings-page=general]').inert"));
  await evaluate("const control=document.querySelector('#cfg-conns');control.value='9';control.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#settings-save-btn').click();return true");
  await until(() => evaluate("return document.querySelector('#settings-save-status').textContent==='本页设置已保存。'"));
  const saved = await evaluate("return window.__TAURI__.core.invoke('core_request',{request:{method:'GET',path:'/settings/task-defaults'}})");
  assert.equal(JSON.parse(saved.body).values.connections, 9);
  assert.equal(await evaluate("return innerWidth >= 320 && innerHeight >= 240 && document.documentElement.scrollWidth <= innerWidth"), true);
  downloadFixture = http.createServer((_request, response) => response.end("TrueDown WebKit native form acceptance\n"));
  await new Promise(resolve => downloadFixture.listen(0, "127.0.0.1", resolve));
  const downloadOrigin = `http://127.0.0.1:${downloadFixture.address().port}`;
  for (const [kind, filenames, total] of [["new-task", ["single.txt"], 1], ["batch-task", ["batch-a.txt", "batch-b.txt"], 3]]) {
    assert.ok(forms[kind]);
    await command("POST", "/window", { handle: forms[kind] });
    await until(() => evaluate("return nativeTaskFormReady"));
    assert.equal(await evaluate("return document.querySelector('#overlay [role=main]')!==null && document.querySelector('#overlay [aria-modal]')===null"), true);
    await evaluate("document.querySelector('#m-link').value='http://127.0.0.1/draft';document.querySelector('#m-headers').value='{\"X-Draft\":\"retained\"}';return window.__TAURI__.core.invoke('close_auxiliary')");
    await command("POST", "/window", { handle: main });
    await evaluate("return window.__TAURI__.core.invoke('open_auxiliary',{kind:arguments[0]})", [kind]);
    await command("POST", "/window", { handle: forms[kind] });
    assert.equal(await evaluate("return document.querySelector('#m-link').value"), "http://127.0.0.1/draft");
    assert.equal(await evaluate("return document.querySelector('#m-headers').value"), '{"X-Draft":"retained"}');
    if (kind === "new-task") {
      const reopenWithDropbox = async (installed) => {
        await evaluate("return window.__TAURI__.core.invoke('close_auxiliary')");
        await command("POST", "/window", { handle: settings });
        await evaluate("return requestJSON('/settings/download-rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true,dropboxMode:'expand',excludedExtensions:[]})})");
        await evaluate("return requestJSON('/modules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'dropbox',installed:arguments[0]})})", [installed]);
        await command("POST", "/window", { handle: main });
        await evaluate("return window.__TAURI__.core.invoke('open_auxiliary',{kind:'new-task'})");
        await command("POST", "/window", { handle: forms[kind] });
        await until(() => evaluate("return !nativeTaskPreferences.pending && downloadRules.dropboxMode==='expand' && downloadRules.enabled && isModuleInstalled('dropbox')===arguments[0]", [installed]));
      };
      await reopenWithDropbox(true);
      assert.deepEqual(await evaluate("return buildModuleOptions().dropbox"), { mode: "expand", applyFilter: true });
      assert.equal(await evaluate("return document.querySelector('#m-resolver-options')===null"), true);
      await reopenWithDropbox(false);
      assert.equal(await evaluate("return 'dropbox' in buildModuleOptions()"), false);
      await reopenWithDropbox(true);
      assert.deepEqual(await evaluate("return buildModuleOptions().dropbox"), { mode: "expand", applyFilter: true });
      assert.equal(await evaluate("return els.mLink.value==='http://127.0.0.1/draft' && els.mHeaders.value==='{\"X-Draft\":\"retained\"}'"), true);
    }
    assert.equal(await evaluate("await refreshAndSchedule(true);return pollTimer===0 && currentPage===arguments[0]", [kind]), true);
    await assert.rejects(evaluate("return window.__TAURI__.core.invoke('core_request',{request:{method:'GET',path:'/tasks?limit=1'}})"));
    await assert.rejects(evaluate("return window.__TAURI__.core.invoke('core_request',{request:{method:'POST',path:'/settings/task-defaults',body:'{}'}})"));
    const layout = await evaluate("const footer=document.querySelector('#overlay .modal-footer').getBoundingClientRect();const frame={bottom:0};const form=document.querySelector('#overlay').getBoundingClientRect();return {footer:footer.bottom,frame:frame.bottom,form:form.top,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight}");
    assert.ok(layout.width >= 320 && layout.height >= 240 && layout.footer <= layout.height && layout.form >= layout.frame && layout.scrollWidth <= layout.width, JSON.stringify(layout));
    await evaluate("document.querySelector('#m-link').value=arguments[0];document.querySelector('#submit-task-btn').click();return true", [filenames.map(name => `${downloadOrigin}/${name}`).join("\n")]);
    await until(() => evaluate("return !document.querySelector('#download-form').inert && document.querySelector('#m-link').value===''") );
    assert.equal(await evaluate("return downloadSettings.connections"), 9);
    await command("POST", "/window", { handle: main });
    await until(() => evaluate("return Number(document.querySelector('#task-count').textContent)===arguments[0]", [total]));
    assert.equal(await evaluate("return document.querySelector('#toast').textContent"), "下载任务已添加");
  }
  for (const handle of handles) {
    await command("POST", "/window", { handle });
    await evaluate("return window.__TAURI__.core.invoke('frame_action',{action:'close'})");
  }
  await command("POST", "/window", { handle: main });
  const windows = await evaluate("return Promise.all((await window.__TAURI__.window.getAllWindows()).map(async entry=>({label:entry.label,visible:await entry.isVisible()})))");
  assert.equal(windows.length, 4);
  assert.ok(windows.every(window => !window.visible));
  console.log("webkit_windows=ok native_frame=ok native_task_forms=ok retained_drafts=ok live_form_preferences=ok form_permissions=ok creation_refresh=ok shared_settings=ok xvfb_layout=ok close_hides_windows=ok");
} catch (error) {
  await fs.writeFile(path.join(profile, "webdriver.log"), diagnostic);
  if (session) await command("GET", "/screenshot").then(image => fs.writeFile(path.join(profile, "failure.png"), Buffer.from(image, "base64"))).catch(() => {});
  throw error;
} finally {
  await fetch(`http://127.0.0.1:${corePort}/system/exit`, { method: "POST" }).catch(() => {});
  if (session) await command("DELETE", "").catch(() => {});
  driver.kill();
  if (downloadFixture) await new Promise(resolve => downloadFixture.close(resolve));
  console.log(`profile=${profile}`);
}
