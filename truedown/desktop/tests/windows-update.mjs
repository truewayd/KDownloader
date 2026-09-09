import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

if (process.platform !== "win32") throw new Error("Native bundle acceptance requires Windows");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-bundle-review-"));
console.log(`fixture=${fixture}`);
const names = ["truedown-core.exe", "truedown-cli.exe", "THIRD_PARTY_NOTICES.md", "NATIVE_LICENSES.txt", "TrueDown.exe"];
let previous = process.argv[2], next = process.argv[3];
if (previous === "--build") {
  for (const build of [1, 2]) {
    const env = { ...process.env, TRUEDOWN_VERSION: `truedown-build-${build}`, TRUEDOWN_BUILD_NUMBER: String(build), TRUEDOWN_COMMIT: String(build).repeat(40) };
    for (const [command, args] of [[process.execPath, ["../tools/prepare-desktop.mjs"]], ["cargo", ["build", "--locked"]]]) {
      const result = spawnSync(command, args, { cwd: desktop, env, stdio: "inherit", windowsHide: true });
      if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed`);
    }
    const output = path.join(fixture, `build-${build}`);
    await fs.mkdir(output);
    for (const name of ["truedown-core.exe", "truedown-cli.exe", "TrueDown.exe"]) {
      await fs.copyFile(path.join(desktop, "target/debug", name === "TrueDown.exe" ? "truedown-desktop.exe" : name), path.join(output, name));
    }
    await fs.copyFile(path.join(desktop, "../THIRD_PARTY_NOTICES.md"), path.join(output, "THIRD_PARTY_NOTICES.md"));
    // This sentinel belongs only to disposable test packages; production
    // packaging must generate the actual third-party license inventory.
    await fs.writeFile(path.join(output, "NATIVE_LICENSES.txt"), `Native acceptance fixture ${build}\n`);
    if (build === 1) previous = output; else next = output;
  }
}
if (!previous || !next) throw new Error("Pass previous/next fixture packages, or --build");
async function metadata(directory, name) {
  const data = await fs.readFile(path.join(directory, name));
  return { name, size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function until(check, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error("Native bundle acceptance timed out");
}
async function exists(file) { return fs.stat(file).then(() => true, () => false); }

const modes = ["update", "automatic-update", "health-rollback", "interrupted-rollback"];
if (process.argv[4] && !modes.includes(process.argv[4])) throw new Error("Unknown acceptance mode");
for (const mode of process.argv[4] ? [process.argv[4]] : modes) {
  const directory = path.join(fixture, mode, "Application with spaces");
  const profile = path.join(fixture, mode, "Profile with spaces");
  await fs.mkdir(directory, { recursive: true });
  for (const name of names) await fs.copyFile(path.join(previous, name), path.join(directory, name));
  await fs.copyFile(path.join(desktop, "../aria2/aria2c.exe"), path.join(directory, "aria2c.exe"));
  const engine = await metadata(directory, "aria2c.exe");
  const apiPort = await port(), debugPort = await port();
  const origin = `http://127.0.0.1:${apiPort}`;
  const env = { ...process.env, TRUEDOWN_DESKTOP_TEST: "1", TRUEDOWN_ADDR: `127.0.0.1:${apiPort}`,
    TRUEDOWN_DESKTOP_TEST_DEBUG_PORT: String(debugPort), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "",
    TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "" };
  const launch = () => {
    const child = spawn(path.join(directory, "TrueDown.exe"), ["--background", "--data-dir", profile], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume(); child.stderr.resume(); return child;
  };
  const request = async (route, method = "GET", body) => {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(method === "GET" ? 3000 : 30000), ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }).catch(error => { throw new Error(`${mode}: ${method} ${route}: ${error.message}`); });
    const text = await response.text(); assert.ok(response.ok, text); return text ? JSON.parse(text) : null;
  };
  const build = () => request("/system/info").then(info => info.buildNumber, () => null);
  let browser;
  try {
    const initial = launch();
    await until(async () => await build() === "1");
    await request("/settings/updates", "POST", { autoUpdateTrueDown: false });
    await request("/system/exit", "POST");
    await until(() => initial.exitCode !== null);
    const stateDirectory = path.join(profile, "state"), updates = path.join(stateDirectory, "updates");
    const targetBuild = mode === "health-rollback" ? 3 : 2;
    const stage = path.join(updates, `native-build-${targetBuild}-fixture`);
    await fs.mkdir(stage, { recursive: true });
    for (const name of names) await fs.copyFile(path.join(next, name), path.join(stage, name));
    const files = await Promise.all(names.map(name => metadata(stage, name)));
    const statePath = path.join(stateDirectory, "truedown.updates.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.autoUpdateTrueDown = mode === "automatic-update";
    state.pendingUpdate = { version: `truedown-build-${targetBuild}`, build: targetBuild, file: path.basename(stage), sha256: "a".repeat(64), nativeFiles: files };
    await fs.writeFile(statePath, JSON.stringify(state));
    const markerPath = path.join(directory, "TrueDown.update.json");
    if (mode === "interrupted-rollback") {
      const token = randomBytes(24).toString("hex");
      const transactionPath = path.join(updates, `native-apply-${token}.json`);
      const helper = path.join(updates, `TrueDown-native-updater-${token}.exe`);
      await fs.copyFile(path.join(directory, "truedown-core.exe"), helper);
      const replacements = [];
      for (const file of files) {
        replacements.push({ old: await metadata(directory, file.name), new: file });
        await fs.copyFile(path.join(directory, file.name), path.join(directory, file.name + ".previous"));
      }
      await fs.copyFile(path.join(stage, "truedown-core.exe"), path.join(directory, "truedown-core.exe"));
      await fs.writeFile(transactionPath, JSON.stringify({ schemaVersion: 1, build: targetBuild, directory, stage, statePath,
        healthPath: path.join(updates, `native-health-${token}`), token, arguments: ["--background", "--data-dir", profile], files: replacements }));
      await fs.writeFile(markerPath, JSON.stringify({ schemaVersion: 1, transaction: transactionPath, helper, sha256: (await metadata(updates, path.basename(helper))).sha256, token }));
      launch();
    } else {
      launch();
      await until(async () => await build() === "1");
      const pending = await request("/system/update");
      assert.equal(pending.trueDown.pendingBuild, targetBuild);
      if (mode !== "automatic-update") await request("/system/update/restart", "POST");
      await until(() => exists(markerPath));
    }
    await until(async () => !(await exists(markerPath)));
    const wanted = ["update", "automatic-update"].includes(mode) ? "2" : "1";
    await until(async () => await build() === wanted);
    for (const name of names) assert.deepEqual(await metadata(directory, name), await metadata(["update", "automatic-update"].includes(mode) ? next : previous, name));
    assert.deepEqual(await metadata(directory, "aria2c.exe"), engine);
    const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(saved.autoUpdateTrueDown, mode === "automatic-update");
    assert.equal(saved.pendingUpdate, undefined);
    if (!["update", "automatic-update"].includes(mode)) assert.match(saved.lastUpdateError, /restored the complete previous version/);
    await until(() => fetch(`http://127.0.0.1:${debugPort}/json/version`).then(response => response.ok, () => false));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes("tauri.localhost")));
    await until(() => page.evaluate(() => Boolean(window.__TAURI__?.window?.getCurrentWindow)).catch(() => false));
    assert.equal(await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().isVisible()), false);
    console.log(`${mode}=ok native_health=ok complete_file_set=ok engine_preserved=ok all_windows_hidden=ok`);
  } finally {
    await browser?.close();
    await request("/system/exit", "POST").catch(() => {});
    await until(async () => (await build()) === null, 20000).catch(() => {});
  }
}
