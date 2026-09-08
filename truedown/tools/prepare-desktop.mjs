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
console.log(run(process.execPath,[path.join(project,"tools/generate-icons.mjs"),"--check"]));
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
console.log(run(process.execPath,[path.join(project,"tools/native-licenses.mjs")],{env:{...process.env,CARGO_BUILD_TARGET:target}}));
const version=process.env.TRUEDOWN_VERSION || "dev";
const productVersion=JSON.parse(await fs.readFile(path.join(repository,"manifest.json"),"utf8")).version;
if(!/^\d+\.\d+\.\d+$/.test(productVersion))throw new Error("Invalid product version");
const buildNumber=process.env.TRUEDOWN_BUILD_NUMBER || "0";
const commit=process.env.TRUEDOWN_COMMIT || "unknown";
if(!/^(0|[1-9][0-9]{0,12})$/.test(buildNumber) ||
   (buildNumber!=="0" && (version!==`truedown-build-${buildNumber}` || !/^[a-f0-9]{40}$/.test(commit))) ||
   (buildNumber==="0" && (version!=="dev" || commit!=="unknown")))throw new Error("Invalid native release identity");
const metadataOutput=path.join(await directory("dist"),"desktop-build.json");
await regularOutput(metadataOutput);
await fs.writeFile(metadataOutput,JSON.stringify({product:"TrueDown",protocolVersion:1,productVersion,version,buildNumber,commit})+"\n");
const ldflags=["-s","-w",...["Version","BuildNumber","Commit","ProductVersion"].map((name,index)=>
  `-X=truedown/internal/buildinfo.${name}=${[version,buildNumber,commit,productVersion][index]}`)].join(" ");
const binaries=await directory("desktop/binaries");
// Linux packaging needs a PNG. Reuse the canonical ICO's exact 256px PNG
// frame, so all native packages retain the same source artwork.
const ico=await fs.readFile(path.join(project,"windows/truedown.ico"));
let nativeIcon;
for(let entry=6;entry<6+ico.readUInt16LE(4)*16;entry+=16){
  if(ico[entry]===0 && ico[entry+1]===0){
    const size=ico.readUInt32LE(entry+8),offset=ico.readUInt32LE(entry+12);
    if(offset+size>ico.length)throw new Error("Invalid canonical icon frame");
    nativeIcon=ico.subarray(offset,offset+size);
  }
}
if(!nativeIcon || nativeIcon.subarray(0,8).toString("hex")!=="89504e470d0a1a0a")throw new Error("Canonical icon requires a 256px PNG frame");
const iconOutput=path.join(await directory("dist"),"desktop-icon.png");
await regularOutput(iconOutput);
await fs.writeFile(iconOutput,nativeIcon);
for(const [name,entry] of [["truedown-core","./cmd/truedown-core"],["truedown-cli","./cmd/truedown"]]){
  const output=path.join(binaries,`${name}-${target}${suffix}`);
  await regularOutput(output);
  run("go",["build","-trimpath","-ldflags",ldflags,"-o",output,entry],{env:{...process.env,CGO_ENABLED:"0",GOOS:goos,GOARCH:goarch}});
}
const web=await directory("dist/desktop-web");
const sources=(await fs.readdir(path.join(project,"web"))).filter(name=>/\.(html|css|js|svg)$/.test(name));
for(const name of await fs.readdir(web)){
  const output=path.join(web,name);await regularOutput(output);
  if(!sources.includes(name))await fs.unlink(output);
}
for(const name of sources){const output=path.join(web,name);await regularOutput(output);await fs.copyFile(path.join(project,"web",name),output);}
console.log(`Desktop core and web resources prepared for ${target}`);
