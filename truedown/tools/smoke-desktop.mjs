import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const executable=path.resolve(process.argv[2] || "");
if(!process.argv[2])throw new Error("usage: node smoke-desktop.mjs /path/to/truedown-core [/path/to/truedown-cli]");
const root=await fs.mkdtemp(path.join(os.tmpdir(),"truedown-native-smoke-"));
const listener=net.createServer();
await new Promise(resolve=>listener.listen(0,"127.0.0.1",resolve));
const port=listener.address().port;
await new Promise(resolve=>listener.close(resolve));
const endpoint=`http://127.0.0.1:${port}`;
async function checkCLI(){
 if(!process.argv[3])return;
 const {stdout}=await promisify(execFile)(path.resolve(process.argv[3]),["--endpoint",endpoint,"--data-dir",root,"--json","status"],{
  windowsHide:true,timeout:15000,maxBuffer:64*1024,env:{...process.env,TRUEDOWN_API_TOKEN:""},
 });
 assert.equal(JSON.parse(stdout).core.product,"TrueDown");
}
const children=[];
function launch(desktop, attachOnly=false){
 const child=spawn(executable,[...(desktop?["--desktop-stdio"]:[]),...(attachOnly?["--desktop-attach-only"]:[]),"--data-dir",root],{windowsHide:true,stdio:["pipe","pipe","pipe"],env:{...process.env,TRUEDOWN_ADDR:`127.0.0.1:${port}`,TRUEDOWN_API_TOKEN:"",TRUEDOWN_REQUIRE_TOKEN:"",TRUEDOWN_NO_BROWSER:"1"}});
 children.push(child);
 child.stderr.resume();
 child.done=new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
 return child;
}
function rpc(child){
 let id=0;
 const pending=new Map();
 let readyResolve;
 const ready=new Promise(resolve=>{readyResolve=resolve;});
 readline.createInterface({input:child.stdout}).on("line",line=>{
  const frame=JSON.parse(line);
  if(frame.event==="ready")readyResolve(frame);
  else {pending.get(frame.id)?.(frame);pending.delete(frame.id);}
 });
 return {ready,send(method,path,body=""){
  const request={id:++id,method,path,body};
  const response=new Promise(resolve=>pending.set(request.id,resolve));
  child.stdin.write(JSON.stringify(request)+"\n");
  return bounded(response);
 }};
}
async function bounded(promise){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("native smoke timeout")),30000)})]);}
 finally{clearTimeout(timer);}
}
try{
 const service=launch(false);
 for(let i=0;i<100;i++){
  try{const response=await fetch(endpoint+"/system/info");if(response.ok)break;}catch{}
  if(service.exitCode!==null)throw new Error("core exited during startup");
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 for(const resource of ["/","/index.html","/app.js","/api.js","/styles.css","/icons.svg"]){
  const response=await fetch(endpoint+resource,{signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,404,resource);
  assert.equal(response.headers.get("set-cookie"),null,resource);
 }
 await checkCLI();
 const attached=launch(true),attachedRPC=rpc(attached);
 assert.equal((await bounded(attachedRPC.ready)).owned,false);
 assert.equal((await attachedRPC.send("GET","/tasks?limit=1")).status,200);
 assert.equal((await attachedRPC.send("POST","/system/exit")).status,202);
 assert.equal((await fetch(endpoint+"/system/info")).status,200);
 attached.stdin.end();
 assert.equal((await bounded(attached.done)).code,0);
 await fetch(endpoint+"/system/exit",{method:"POST"});
 assert.equal((await bounded(service.done)).code,0);
 const reconnect=launch(true,true);
 reconnect.stdout.resume();
 assert.equal((await bounded(reconnect.done)).code,1);
 await assert.rejects(fetch(endpoint+"/system/info"));

 const owned=launch(true),ownedRPC=rpc(owned);
 assert.equal((await bounded(ownedRPC.ready)).owned,true);
 assert.equal((await ownedRPC.send("GET","/settings/task-defaults")).status,200);
 const enabled=await ownedRPC.send("POST","/auth/settings",JSON.stringify({enabled:true}));
 assert.equal(enabled.status,200);
 const token=JSON.parse(enabled.body).token;
 assert.ok(token);
 const rootResponse=await fetch(endpoint+"/",{signal:AbortSignal.timeout(5000)});
 assert.equal(rootResponse.status,404);
 assert.equal(rootResponse.headers.get("set-cookie"),null);
 assert.equal((await fetch(endpoint+"/tasks?limit=1",{headers:{"Cookie":"truedown_session="+Buffer.from(token).toString("base64url")}})).status,401);
 assert.equal((await fetch(endpoint+"/tasks?limit=1",{headers:{"X-Api-Key":token}})).status,200);
 assert.equal((await fetch(endpoint+"/ping",{method:"POST",headers:{"X-Api-Key":token}})).status,200);
 await checkCLI();
 assert.equal((await fetch(endpoint+"/tasks?limit=1")).status,401);
 assert.equal((await ownedRPC.send("GET","/tasks?limit=1")).status,200);
 owned.stdin.end();
 assert.equal((await bounded(owned.done)).code,0);
 for(const mode of ["http","pipe"]){
  const stopping=launch(true),stoppingRPC=rpc(stopping);
  assert.equal((await bounded(stoppingRPC.ready)).owned,true);
  assert.equal((await stoppingRPC.send("POST","/auth/settings",JSON.stringify({enabled:false}))).status,200);
  if(mode==="http"){
   const response=await fetch(endpoint+"/system/exit",{method:"POST",signal:AbortSignal.timeout(5000)});
   assert.equal(response.status,202);
  }else{
   assert.equal((await stoppingRPC.send("POST","/system/exit")).status,202);
  }
  // The shell retains its writer until the core exits. Shutdown must cancel
  // the inherited stdin read without relying on EOF from that parent.
  assert.equal(stopping.stdin.writableEnded,false);
  assert.equal((await bounded(stopping.done)).code,0);
  await assert.rejects(fetch(endpoint+"/system/info",{signal:AbortSignal.timeout(5000)}));
 }
 console.log("native_pipe=ok attach_preserves_service=ok private_auth=ok api_only=ok owner_eof_exit=ok http_exit=ok pipe_exit=ok");
}finally{
 for(const child of children){
  if(child.exitCode===null && child.signalCode===null){child.stdin.end();await bounded(child.done).catch(()=>child.kill());}
 }
 // Retain the isolated profile for diagnosing a failed test; it contains no user data.
 console.log(`profile=${root}`);
}
