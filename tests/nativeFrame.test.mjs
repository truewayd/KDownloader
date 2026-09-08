import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../truedown/web/native-frame.js", import.meta.url), "utf8");

class Node {
  constructor(tag = "") {
    this.tag = tag; this.children = []; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.classList = { add() {} };
  }
  append(node) { this.children.push(node); }
  prepend(node) { this.children.unshift(node); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  emit(type, properties = {}) {
    const event = { prevented: false, preventDefault() { this.prevented = true; }, ...properties };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
}

function setup(platform = "windows", readState = async () => ({ maximized: false, decorated: false })) {
  const calls = [], timers = new Map(), observers = [];
  let timerID = 0;
  const document = new Node(), window = new Node();
  const title = new Node("title");
  Object.assign(document, {
    documentElement: new Node("html"), body: new Node("body"), title: "TrueDown",
    createElement: tag => new Node(tag),
    createElementNS: (namespaceURI, tag) => Object.assign(new Node(tag), { namespaceURI }),
    querySelector: selector => selector === "title" ? title : null,
  });
  if (platform) Object.assign(window, {
    __TRUEDOWN_PLATFORM__: platform,
    __TAURI__: { core: { invoke: async (command, args) => {
      calls.push({ command, args });
      return command === "frame_state" ? readState() : undefined;
    } } },
  });
  vm.runInNewContext(source, {
    window, document, console,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {} disconnect() { this.disconnected = true; }
    },
    setTimeout(callback) { timers.set(++timerID, callback); return timerID; },
    clearTimeout(id) { timers.delete(id); },
  });
  const frame = document.body.children[0];
  return { window, document, calls, timers, observers, frame,
    drag: frame?.children[0], buttons: frame?.children[1]?.children || [],
    runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
  };
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

test("native capabilities permit event subscriptions and window inspection without filesystem or shell mutations", async () => {
  const capability = JSON.parse(await readFile(new URL("../truedown/desktop/capabilities/main.json", import.meta.url), "utf8"));
  const config = JSON.parse(await readFile(new URL("../truedown/desktop/tauri.conf.json", import.meta.url), "utf8"));
  assert.deepEqual(config.app.security.capabilities, [capability.identifier]);
  assert.deepEqual([...capability.windows].sort(), ["batch-task", "main", "new-task", "settings"]);
  assert.equal(capability.remote, undefined, "Remote documents must never acquire native commands");
  // core:default also grants image reads from arbitrary paths and tray/menu
  // mutations. Keep a closed list so a default group cannot restore them.
  assert.deepEqual([...capability.permissions].sort(), [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "core:window:allow-available-monitors",
    "core:window:allow-get-all-windows",
    "core:window:allow-is-visible",
    "core:window:allow-outer-position",
    "core:window:allow-outer-size",
    "core:window:allow-title",
  ]);
});

test("HTTP dashboards leave the browser frame alone; macOS retains native traffic lights", async () => {
  assert.equal(setup(null).document.body.children.length, 0);
  const mac = setup("macos");
  await flush();
  assert.equal(mac.document.documentElement.dataset.nativeFrame, "overlay");
  assert.equal(mac.buttons.length, 0);
});

test("Windows and Linux retain native captions and bound application titles", async () => {
  for (const platform of ["windows", "linux"]) {
    const view = setup(platform, async () => ({ maximized: true, decorated: true }));
    await flush();
    assert.equal(view.document.body.children.length, 0);
    assert.equal(view.document.documentElement.dataset.nativeFrame, "native");
    assert.equal(view.document.documentElement.dataset.maximized, "true");
    assert.equal(view.calls.find(call => call.command === "frame_title").args.title, "TrueDown");
    view.document.title = "x".repeat(200);
    view.observers[0].callback();
    await flush();
    assert.equal(view.calls.at(-1).args.title.length, 160);
    assert.equal(view.calls.filter(call => call.command === "frame_action").length, 0);
  }
});

test("resize bursts coalesce and page cleanup rejects late state and detaches observers", async () => {
  let complete;
  let reads = 0;
  const view = setup("windows", () => ++reads === 1 ? Promise.resolve({ maximized: false }) : new Promise(resolve => { complete = resolve; }));
  await flush();
  for (let count = 0; count < 40; count++) view.window.emit("resize");
  assert.equal(view.timers.size, 1);
  view.runTimers();
  assert.equal(reads, 2);
  view.window.emit("pagehide");
  complete({ maximized: true });
  await flush();
  assert.equal(view.document.documentElement.dataset.maximized, "false");
  assert.ok(view.observers.every(observer => observer.disconnected));
  assert.equal(view.window.listeners.get("resize").size, 0);
  assert.equal(view.window.listeners.get("focus").size, 0);
  assert.equal(view.document.listeners.get("keydown")?.size || 0, 0);
});
