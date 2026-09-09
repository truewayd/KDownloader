import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../desktop/vendor");
const sha256 = data => createHash("sha256").update(data).digest("hex");

export async function verifyNativePatches(root = defaultRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "patches.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages) || manifest.packages.length !== 4) {
    throw new Error("Invalid native patch inventory");
  }
  const verified = new Map();
  for (const pkg of manifest.packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (!/^[a-z][a-z0-9-]*$/.test(pkg.name) || !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
        pkg.directory !== `${pkg.name}-${pkg.version}` || !/^[a-f0-9]{64}$/.test(pkg.archiveSha256) ||
        pkg.source !== `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download` || verified.has(key)) {
      throw new Error("Invalid native patch identity");
    }
    const directory = path.join(root, pkg.directory);
    const files = new Set();
    async function visit(current) {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlink in native patch ${key}`);
      if (stat.isDirectory()) {
        for (const name of await fs.readdir(current)) await visit(path.join(current, name));
        return;
      }
      const relative = path.relative(directory, current).split(path.sep).join("/");
      if (!stat.isFile() || stat.size > 4 << 20 || files.size >= 1024 ||
          sha256(await fs.readFile(current)) !== pkg.files[relative]) {
        throw new Error(`Native patch source changed: ${key}/${relative}`);
      }
      files.add(relative);
    }
    await visit(directory);
    if (files.size !== Object.keys(pkg.files).length) throw new Error(`Native patch files missing: ${key}`);
    for (const [name, change] of Object.entries(pkg.changes)) {
      if (!/^[a-f0-9]{64}$/.test(change.before) || change.before === change.after || change.after !== pkg.files[name]) {
        throw new Error(`Invalid native patch change record: ${key}/${name}`);
      }
    }
    verified.set(key, { ...pkg, path: path.resolve(directory) });
  }
  return verified;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Verified ${(await verifyNativePatches()).size} native dependency source patches`);
}
