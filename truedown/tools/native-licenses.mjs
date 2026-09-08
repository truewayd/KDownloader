import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { licenseInventory, readBoundedLicenseResponse } from "./native-license-bounds.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(project, "desktop");
const licenseDirectory = path.join(desktop, "licenses");
const indexPath = path.join(licenseDirectory, "index.json");
let overrides = {};
try { overrides = JSON.parse(await fs.readFile(indexPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const vendor = process.argv.includes("--vendor-missing");
const licenseName = /^(licen[sc]e|copying|copyright|notice)([-._].*)?$/i;
const digest = data => createHash("sha256").update(data).digest("hex");
const gitDigest = data => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const cachedBlobs = new Map();
for (const item of Object.values(overrides)) {
  for (const entry of item.files) {
    if (!/^[a-f0-9]{64}\.txt$/.test(entry.file)) throw new Error("Invalid vendored license filename");
    const data = await fs.readFile(path.join(licenseDirectory, entry.file));
    if (digest(data) !== entry.sha256) throw new Error("Invalid vendored license checksum");
    cachedBlobs.set(gitDigest(data), data);
  }
}
async function fetchBounded(url, json = false) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url, { headers: { "User-Agent": "TrueDown-license-inventory", "Accept": json ? "application/vnd.github+json" : "text/plain" }, signal: AbortSignal.timeout(30000) });
      break;
    } catch (error) {
      if (attempt === 2) throw new Error(`Cannot read pinned license source ${url}: ${error.message}`, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Cannot read pinned license source ${url}: ${response.status}`);
  }
  const data = await readBoundedLicenseResponse(response);
  return json ? JSON.parse(data.toString("utf8")) : data;
}
async function supplementalLicenses(pkg, directory) {
  const key = `${pkg.name}@${pkg.version}`;
  if (!overrides[key] && vendor) {
    const vcs = JSON.parse(await fs.readFile(path.join(directory, ".cargo_vcs_info.json"), "utf8"));
    const revision = vcs.git?.sha1;
    // This published sys crate omits repository metadata. Its exact VCS
    // revision was verified against the upstream repository before vendoring.
    let sourceRepository = pkg.repository || ({ "libappindicator-sys@0.9.0": "https://github.com/tauri-apps/libappindicator-rs" })[key];
    if (!sourceRepository) {
      for (const candidate of metadata.packages.filter(value => value.repository && active.has(value.id))) {
        try {
          const sibling = JSON.parse(await fs.readFile(path.join(path.dirname(candidate.manifest_path), ".cargo_vcs_info.json"), "utf8"));
          if (sibling.git?.sha1 === revision) { sourceRepository = candidate.repository; break; }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    const match = sourceRepository?.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/);
    if (!match || !/^[a-f0-9]{40}$/.test(revision)) throw new Error(`Cannot pin a supplemental license for ${key}`);
    const repository = `${match[1]}/${match[2].replace(/\.git$/, "")}`;
    const sibling = Object.values(overrides).find(value => value.revision === revision && (value.sourceRepository || value.repository) === sourceRepository);
    if (sibling) {
      overrides[key] = { ...sibling, repository: pkg.repository, sourceRepository };
      await fs.writeFile(indexPath, JSON.stringify(overrides, null, 2) + "\n");
      return supplementalLicenses(pkg, directory);
    }
    const tree = await fetchBounded(`https://api.github.com/repos/${repository}/git/trees/${revision}`, true);
    const entries = tree.tree.filter(entry => entry.type === "blob" && licenseName.test(entry.path));
    if ((!entries.length && pkg.name !== "selectors") || entries.length > 12) throw new Error(`No bounded root license set for ${key}`);
    await fs.mkdir(licenseDirectory, { recursive: true });
    const files = [];
    if (!entries.length && pkg.name === "selectors" && pkg.license === "MPL-2.0") {
      // Stylo carries the MPL notice in source headers, without a root license
      // file. Include the same full MPL text packaged by its locked cssparser
      // dependency, and keep the selectors source revision in this index.
      const parser = metadata.packages.find(value => value.name === "cssparser" && active.has(value.id) && value.license === "MPL-2.0");
      if (!parser) throw new Error("Cannot locate the canonical packaged MPL text");
      const parserDirectory = path.dirname(parser.manifest_path);
      const data = await fs.readFile(path.join(parserDirectory, "LICENSE"));
      if (!data.toString("utf8").includes("Mozilla Public License Version 2.0")) throw new Error("Unexpected packaged MPL text");
      const parserVcs = JSON.parse(await fs.readFile(path.join(parserDirectory, ".cargo_vcs_info.json"), "utf8"));
      const sha256 = digest(data), file = `${sha256}.txt`;
      await fs.writeFile(path.join(licenseDirectory, file), data);
      files.push({ file, sha256, source: `${parser.repository.replace(/\/$/, "")}/blob/${parserVcs.git.sha1}/LICENSE` });
    }
    for (const entry of entries) {
      const source = `https://raw.githubusercontent.com/${repository}/${revision}/${encodeURIComponent(entry.path)}`;
      let data = cachedBlobs.get(entry.sha);
      if (!data) {
        const blob = await fetchBounded(`https://api.github.com/repos/${repository}/git/blobs/${entry.sha}`, true);
        if (blob.encoding !== "base64") throw new Error(`Unexpected Git license encoding for ${key}`);
        data = Buffer.from(blob.content, "base64");
      }
      if (data.length > 1 << 20) throw new Error(`Oversized license for ${key}`);
      const gitHash = gitDigest(data);
      if (gitHash !== entry.sha) throw new Error(`Pinned Git license checksum failed for ${key}`);
      const sha256 = digest(data), file = `${sha256}.txt`;
      await fs.writeFile(path.join(licenseDirectory, file), data);
      cachedBlobs.set(gitHash, data);
      files.push({ file, sha256, source });
    }
    overrides[key] = { revision, repository: pkg.repository, sourceRepository, files };
    await fs.writeFile(indexPath, JSON.stringify(overrides, null, 2) + "\n");
  }
  const item = overrides[key];
  if (!item) return [];
  const vcs = JSON.parse(await fs.readFile(path.join(directory, ".cargo_vcs_info.json"), "utf8"));
  if (item.repository !== pkg.repository || item.revision !== vcs.git?.sha1) throw new Error(`Supplemental license identity changed for ${key}`);
  const text = [];
  for (const entry of item.files) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || entry.file !== `${entry.sha256}.txt`) throw new Error(`Invalid supplemental license path for ${key}`);
    const data = await fs.readFile(path.join(licenseDirectory, entry.file));
    if (digest(data) !== entry.sha256) throw new Error(`Supplemental license checksum failed for ${key}`);
    text.push(`${entry.source}\n${data.toString("utf8")}`);
  }
  return text;
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktop, encoding: "utf8", maxBuffer: 32 << 20, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
  return result.stdout;
}
const target = process.env.CARGO_BUILD_TARGET || run("rustc", ["-vV"]).match(/^host: (.+)$/m)?.[1];
if (!target) throw new Error("Cannot resolve the native license target");
const metadata = JSON.parse(run("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", target]));
const active = new Set(metadata.resolve.nodes.map(node => node.id));
const packages = metadata.packages.filter(pkg => pkg.source && active.has(pkg.id)).sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en"));
if (!packages.length || packages.length > 2048) throw new Error("Invalid native dependency inventory");
const output = licenseInventory();
output.push(`TrueDown native dependency licenses (${target})`, "Generated from the locked dependency graph and packaged or pinned upstream license notices.");
const missing = [];
for (const pkg of packages) {
  const directory = path.resolve(path.dirname(pkg.manifest_path));
  const names = (await fs.readdir(directory)).filter(name => licenseName.test(name));
  if (pkg.license_file) names.push(path.relative(directory, pkg.license_file));
  const files = [...new Set(names)].sort();
  let included = false;
  output.push("", `${pkg.name} ${pkg.version}`, `License: ${pkg.license || "see original text"}`, `Authors: ${pkg.authors.join(", ") || "see source contributors"}`, `Source: ${pkg.repository || pkg.source}`, `Exact source package: https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`);
  for (const name of files) {
    const file = path.resolve(directory, name);
    if (!file.startsWith(directory + path.sep)) throw new Error(`License path escaped ${pkg.name}`);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1 << 20) throw new Error(`Invalid license file for ${pkg.name}`);
    output.push(`${name}\n${await fs.readFile(file, "utf8")}`);
    included = true;
  }
  if (!included) {
    const text = await supplementalLicenses(pkg, directory);
    output.push(...text);
    included = text.length > 0;
  }
  if (!included) missing.push(`${pkg.name}@${pkg.version} (${pkg.license || "unspecified"})`);
}
if (missing.length) throw new Error(`Dependencies omitted their license text:\n${missing.join("\n")}`);
const webview = packages.find(pkg => pkg.name === "webview2-com-sys");
if (webview) {
  const sdk = JSON.parse(await fs.readFile(path.join(licenseDirectory, "webview2-sdk.json"), "utf8"));
  const arch = { x86_64: "x64", aarch64: "arm64", i686: "x86" }[target.split("-")[0]];
  if (webview.version !== sdk.crateVersion || !arch || sdk.file !== `${sdk.sha256}.txt` || !/^[a-f0-9]{64}$/.test(sdk.sha256)) throw new Error("Review the WebView2 SDK notice for the new native dependency");
  const loader = await fs.readFile(path.join(path.dirname(webview.manifest_path), arch, "WebView2LoaderStatic.lib"));
  if (digest(loader) !== sdk.loaders[arch]) throw new Error("WebView2 loader differs from the reviewed SDK");
  const notice = await fs.readFile(path.join(licenseDirectory, sdk.file));
  if (digest(notice) !== sdk.sha256) throw new Error("WebView2 SDK license checksum failed");
  output.push("", `Microsoft WebView2 SDK ${sdk.version} loader`, `Source: ${sdk.source}`, notice.toString("utf8"));
}
const text = output.text();
const directory = path.join(project, "dist");
await fs.mkdir(directory, { recursive: true });
const stat = await fs.lstat(directory);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe generated license directory");
const destination = path.join(directory, "NATIVE_LICENSES.txt");
try { const stat = await fs.lstat(destination); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe generated license file"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await fs.writeFile(destination, text);
console.log(`Collected original licenses for ${packages.length} native dependencies`);
