import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

if (process.platform !== "linux" || !process.env.DISPLAY) throw new Error("Run this test inside xvfb-run and dbus-run-session");
const application = path.resolve(process.argv[2] || "target/debug/truedown-desktop");
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
  env: { ...process.env, GDK_BACKEND: "x11", TRUEDOWN_DESKTOP_TEST: "1", TRUEDOWN_ADDR: `127.0.0.1:${corePort}`, TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "", TAURI_WEBVIEW_AUTOMATION: "true" },
});
let diagnostic = "", session;
for (const stream of [driver.stdout, driver.stderr]) stream.on("data", data => { diagnostic = (diagnostic + data.toString()).slice(-8192); });
async function request(method, route, body) {
  const response = await fetch(endpoint + route, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) });
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
  const created = await request("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, args: ["--background", "--data-dir", profile] } } } });
  session = created.sessionId;
  await command("POST", "/timeouts", { script: 15000, pageLoad: 30000, implicit: 0 });
  await until(() => evaluate("return Boolean(window.__TAURI__ && document.querySelector('#task-count'))"));
  assert.equal(await evaluate("return window.__TRUEDOWN_PLATFORM__"), "linux");
  const info = await evaluate("return window.__TAURI__.core.invoke('core_request',{request:{method:'GET',path:'/system/info'}})");
  assert.equal(JSON.parse(info.body).product, "TrueDown");
  for (const kind of ["settings", "logs", "about"]) await evaluate("return window.__TAURI__.core.invoke('open_auxiliary',{kind:arguments[0]})", [kind]);
  const handles = await until(async () => { const handles = await command("GET", "/window/handles"); return handles.length === 4 && handles; });
  let settings, main;
  for (const handle of handles) {
    await command("POST", "/window", { handle });
    const role = await evaluate("return document.documentElement.dataset.nativeWindow || (location.pathname.endsWith('about.html')?'about':'main')");
    if (role === "settings") settings = handle;
    if (role === "main") main = handle;
  }
  assert.ok(settings && main);
  await command("POST", "/window", { handle: settings });
  await evaluate("document.querySelector('[data-settings-link=general]').click(); return true");
  await until(() => evaluate("return !document.querySelector('[data-settings-page=general]').inert"));
  await evaluate("const control=document.querySelector('#cfg-conns');control.value='9';control.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#settings-save-btn').click();return true");
  await until(() => evaluate("return document.querySelector('#settings-save-status').textContent==='本页设置已保存。'"));
  const saved = await evaluate("return window.__TAURI__.core.invoke('core_request',{request:{method:'GET',path:'/settings/task-defaults'}})");
  assert.equal(JSON.parse(saved.body).values.connections, 9);
  assert.equal(await evaluate("return document.documentElement.scrollWidth <= innerWidth"), true);
  await command("POST", "/window", { handle: main });
  const windows = await evaluate("return Promise.all((await window.__TAURI__.window.getAllWindows()).map(async entry=>({label:entry.label,visible:await entry.isVisible()})))");
  assert.equal(windows.length, 4);
  assert.ok(windows.every(window => !window.visible));
  console.log("webkit_windows=ok shared_settings=ok layout=ok all_windows_hidden=ok");
} catch (error) {
  await fs.writeFile(path.join(profile, "webdriver.log"), diagnostic);
  throw error;
} finally {
  await fetch(`http://127.0.0.1:${corePort}/system/exit`, { method: "POST" }).catch(() => {});
  if (session) await command("DELETE", "").catch(() => {});
  driver.kill();
  console.log(`profile=${profile}`);
}
