import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(args, options = {}) {
  const result = spawnSync("go", args, { cwd: project, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "MEGA module build failed");
  return result.stdout.trim();
}
const baseline = JSON.parse(await fs.readFile(path.join(project, "internal/downloader/module_baselines/mega.json"), "utf8"));
if (baseline.id !== "mega" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(baseline.version)) {
  throw new Error("Invalid MEGA baseline version");
}
const [goos, goarch] = run(["env", "GOOS", "GOARCH"]).split(/\r?\n/);
if (![goos, goarch].every(value => /^[a-z0-9]+$/.test(value))) throw new Error("Invalid MEGA target");
let directory = project;
for (const component of ["internal", "modulebundle", "assets"]) {
  directory = path.join(directory, component);
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe module output directory");
}
const output = path.join(directory, `mega-${goos}-${goarch}.bin`);
try {
  const info = await fs.lstat(output);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe module output file");
} catch (error) { if (error.code !== "ENOENT") throw error; }
run(["build", "-trimpath", "-ldflags", `-s -w -X main.version=${baseline.version}`, "-o", output, "./modules/mega"], {
  env: { ...process.env, CGO_ENABLED: "0" },
});
console.log(`Prepared MEGA ${baseline.version} for ${goos}/${goarch}`);
