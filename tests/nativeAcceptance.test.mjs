import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { readToastPlacement, assertToastBounds } from "../truedown/desktop/tests/toast-layout.mjs";
import { stopProcessGroup } from "../truedown/desktop/tests/process-group.mjs";

function toastFixture() {
  const state = { visible: true, opacity: "1", y: 16, height: 96, pending: false, laidOut: false };
  const element = {
    classList: { contains: () => state.visible },
    clientWidth: 480, scrollWidth: 480,
    getBoundingClientRect() {
      state.laidOut = true;
      return { x: 90, y: state.y, width: 480, height: state.height, right: 570, bottom: state.y + state.height };
    },
    getAnimations() {
      return state.laidOut && state.pending ? [{ playState: "running" }] : [];
    },
  };
  const context = vm.createContext({
    document: { querySelector: () => element, documentElement: {} },
    getComputedStyle: node => node === element ? { opacity: state.opacity, top: "16px" }
      : { getPropertyValue: () => "0px" },
    innerWidth: 660, innerHeight: 560,
  });
  return { state, element, read: () => vm.runInContext(`(${readToastPlacement.toString()})()`, context) };
}

test("toast readiness flushes pending layout before observing animations", () => {
  const { state, element, read } = toastFixture();
  state.pending = true;
  assert.deepEqual(element.getAnimations(), [], "WebKit can initially expose an empty animation list");
  assert.equal(read(), null);
  state.pending = false;
  assertToastBounds(read());
});

test("toast readiness rejects the reported animation offset and unpainted surfaces", () => {
  const { state, read } = toastFixture();
  state.y = 11.21654987335205;
  assert.equal(read(), null, "An empty animation list must not accept an intermediate transform");
  state.y = 16;
  state.opacity = "0";
  assert.equal(read(), null);
  state.opacity = "1";
  state.height = 0;
  assert.equal(read(), null);
  state.height = 96;
  state.visible = false;
  assert.equal(read(), null);
  state.visible = true;
  assertToastBounds(read());
});

test("settled toast bounds still reject clipping and incorrect placement", () => {
  const { read } = toastFixture();
  const bounds = read();
  for (const invalid of [{ ...bounds, y: 10 }, { ...bounds, x: 0 }, { ...bounds, bottom: 560 }, { ...bounds, textFits: false }]) {
    assert.throws(() => assertToastBounds(invalid), assert.AssertionError);
  }
});

test("Unix driver cleanup stops descendants that retain pipes after the driver exits", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => process.exit(0));
    require('node:child_process').spawn(process.execPath, ['-e',
      "process.on('SIGTERM',()=>{}); console.log('descendant ready'); setInterval(()=>{},1000);"
    ], {stdio:['ignore','inherit','inherit']});
    setInterval(()=>{},1000);
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture startup timed out")), 5000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("driver did not exit")), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
    assert.equal(child.stdout.destroyed, false, "stopping only the driver must reproduce the retained pipe");
    await stopProcessGroup(child, 1000);
    assert.equal(child.exitCode, 0, "driver must exit before its stubborn descendant");
    assert.equal(child.stdout.destroyed, true, "descendant must release inherited output");
  } finally {
    await stopProcessGroup(child, 1000);
  }
});

test("macOS acceptance stays debug-only and uses public bounded native operations", async () => {
  const [main, fixture, driver, workflow, manifest] = await Promise.all([
    "truedown/desktop/src/main.rs", "truedown/desktop/src/macos_acceptance.rs",
    "truedown/desktop/tests/macos-smoke.mjs", ".github/workflows/test-native-desktop.yml",
    "truedown/desktop/package.json",
  ].map(file => readFile(new URL(`../${file}`, import.meta.url), "utf8")));
  for (const hook of ["mod macos_acceptance;", "macos_acceptance::start(app.handle());"]) {
    assert.ok(main.includes(`#[cfg(all(debug_assertions, target_os = "macos"))]\n${hook}`)
      || new RegExp(`#\\[cfg\\(all\\(debug_assertions, target_os = "macos"\\)\\)\\]\\s+${hook.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(main), hook);
  }
  assert.match(fixture, /TRUEDOWN_MACOS_ACCEPTANCE/);
  assert.match(fixture, /sync_channel\(1\)/);
  assert.match(fixture, /try_send/);
  assert.match(fixture, /recv_timeout\(remaining\.min/);
  assert.match(fixture, /r\?\.id===\{id\}/);
  assert.match(fixture, /eval_with_callback/);
  assert.match(fixture, /self\.deadline\.min/);
  assert.match(fixture, /from_secs\(120\)/);
  assert.match(fixture, /\.close\(\)/);
  assert.match(fixture, /\.is_visible\(\)/);
  assert.match(fixture, /__acceptanceDocument === true/);
  assert.match(fixture, /settingsRendered\.has\('general'\)/);
  assert.match(fixture, /nativeTaskFormReady && !nativeTaskPreferences\.pending/);
  assert.doesNotMatch(fixture, /#\[tauri::command\]|unmanage|TcpListener/);
  assert.doesNotMatch(fixture + driver, /objc_msgSend|WKInspector|_evaluateJavaScript|osascript|safaridriver|requestAnimationFrame|setInterval|pkill|killall/);
  assert.match(driver, /detached: true/);
  assert.match(driver, /\["--background", "--data-dir", profile\]/);
  assert.match(driver, /150000/);
  assert.match(driver, /AbortSignal\.timeout\(5000\)/);
  assert.match(driver, /await stopProcessGroup\(child\)/);
  assert.match(driver, /assert\.equal\(child\.exitCode, 0/);
  assert.match(driver, /assert\.equal\(await fs\.realpath\(\(await storage\.json\(\)\)\.dataDirectory\), profile\)/);
  assert.match(driver, /assert\.equal\(exit\.status, 202\)/);
  assert.match(workflow, /if: runner\.os == 'macOS'\s+timeout-minutes: 5\s+run: npm run test:macos/);
  assert.equal(JSON.parse(manifest).scripts["test:macos"], "node tests/macos-smoke.mjs");
});

test("macOS evaluation rejects stale completions and handles failed or replaced documents", async () => {
  const source = await readFile(new URL("../truedown/desktop/tests/macos-evaluate.js", import.meta.url), "utf8");
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  let resolveOld;
  context.beginMacosEvaluation(1, () => new Promise(resolve => { resolveOld = resolve; }));
  await flush();
  assert.equal(context.window.__acceptanceResult.done, false);
  context.beginMacosEvaluation(2, () => true);
  await flush();
  resolveOld(false);
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.__acceptanceResult)), { id: 2, done: true, ok: true });
  context.beginMacosEvaluation(3, () => { throw new Error("navigation not ready"); });
  await flush();
  assert.equal(context.window.__acceptanceResult.ok, false);
  context.beginMacosEvaluation(4, () => new Promise(resolve => { resolveOld = resolve; }));
  await flush();
  context.window = {};
  resolveOld(true);
  await flush();
  assert.equal(context.window.__acceptanceResult, undefined, "an abandoned document must not report readiness");
  context.beginMacosEvaluation(5, () => true);
  await flush();
  assert.equal(context.window.__acceptanceResult.ok, true);
});

test("process-group cleanup still kills descendants after parent pipes have closed", async () => {
  const source = await readFile(new URL("../truedown/desktop/tests/process-group.mjs", import.meta.url), "utf8");
  const signals = [];
  const context = vm.createContext({ process: { kill: (pid, signal) => signals.push([pid, signal]) }, setTimeout, clearTimeout });
  vm.runInContext(source.replace("export async function", "async function"), context);
  const child = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: 0, signalCode: null, stdout: { destroyed: true }, stderr: { destroyed: true },
  });
  await context.stopProcessGroup(child, 10);
  assert.deepEqual(signals, [[-123, "SIGTERM"], [-123, 0], [-123, "SIGKILL"]]);
  assert.equal(child.listenerCount("close"), 0);
});

test("process-group cleanup bounds a failed kill and releases local pipe handles", async () => {
  const source = await readFile(new URL("../truedown/desktop/tests/process-group.mjs", import.meta.url), "utf8");
  const context = vm.createContext({ process: { kill() {} }, setTimeout, clearTimeout });
  vm.runInContext(source.replace("export async function", "async function"), context);
  const stream = () => ({ destroyed: false, destroy() { this.destroyed = true; } });
  const child = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null, signalCode: null, stdout: stream(), stderr: stream(),
    unref() { this.unreferenced = true; },
  });
  await assert.rejects(context.stopProcessGroup(child, 10), /did not close after SIGKILL/);
  assert.ok(child.stdout.destroyed && child.stderr.destroyed && child.unreferenced);
  assert.equal(child.listenerCount("close"), 0);
});
