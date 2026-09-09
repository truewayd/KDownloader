import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { spawn } from "node:child_process";
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

test("Linux driver cleanup stops descendants that retain pipes after the driver exits", { skip: process.platform !== "linux" }, async () => {
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
