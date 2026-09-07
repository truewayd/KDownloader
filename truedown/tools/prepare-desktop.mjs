import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(project, "desktop");
const repository = path.dirname(project);
function run(command,args,options={}) {
  const result=spawnSync(command,args,{cwd:project,encoding:"utf8",...options});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}
async function directory(relative) {
  const destination=path.resolve(project,relative);
  if(!destination.startsWith(project+path.sep))throw new Error("Output escaped the project");
  let current=project;
  for(const part of path.relative(project,destination).split(path.sep)){
    current=path.join(current,part);
    try {const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("Unsafe generated directory");}
    catch(error){if(error.code!=="ENOENT")throw error;await fs.mkdir(current);}
  }
  return destination;
}
async function regularOutput(file){
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Unsafe generated file");}
  catch(error){if(error.code!=="ENOENT")throw error;}
}
const canonical=await fs.readFile(path.join(repository,"shared/components.js"));
if(!canonical.equals(await fs.readFile(path.join(project,"web/components.js"))))throw new Error("Run npm run ui:sync before building TrueDown");
const target=process.env.CARGO_BUILD_TARGET || run("rustc",["-vV"]).match(/^host: (.+)$/m)?.[1];
const platform={
  "x86_64-pc-windows-msvc":["windows","amd64",".exe"],
  "aarch64-pc-windows-msvc":["windows","arm64",".exe"],
  "x86_64-unknown-linux-gnu":["linux","amd64",""],
  "aarch64-unknown-linux-gnu":["linux","arm64",""],
  "x86_64-apple-darwin":["darwin","amd64",""],
  "aarch64-apple-darwin":["darwin","arm64",""],
}[target];
if(!platform)throw new Error("Unsupported desktop target");
const [goos,goarch,suffix]=platform;
const binaries=await directory("desktop/binaries");
for(const [name,entry] of [["truedown-core","./cmd/truedown-core"],["truedown-cli","./cmd/truedown"]]){
  const output=path.join(binaries,`${name}-${target}${suffix}`);
  await regularOutput(output);
  run("go",["build","-trimpath","-o",output,entry],{env:{...process.env,CGO_ENABLED:"0",GOOS:goos,GOARCH:goarch}});
}
const web=await directory("dist/desktop-web");
const sources=(await fs.readdir(path.join(project,"web"))).filter(name=>/\.(html|css|js|svg)$/.test(name));
for(const name of await fs.readdir(web)){
  const output=path.join(web,name);await regularOutput(output);
  if(!sources.includes(name))await fs.unlink(output);
}
for(const name of sources){const output=path.join(web,name);await regularOutput(output);await fs.copyFile(path.join(project,"web",name),output);}
console.log(`Desktop core and web resources prepared for ${target}`);
