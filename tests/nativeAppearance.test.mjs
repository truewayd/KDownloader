import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../truedown/web/native-appearance.js", import.meta.url), "utf8");
const darkQuery = "(prefers-color-scheme: dark)";
const contrastQuery = "(forced-colors: active)";
const transparencyQuery = "(prefers-reduced-transparency: reduce)";

function appearance(platform = "windows", dark = false) {
  const calls = [], queries = new Map(), events = new Map(), dataset = {};
  const window = {
    __TRUEDOWN_PLATFORM__: platform,
    __TAURI__: { core: { invoke(command, args) {
      return new Promise((resolve, reject) => calls.push({ command, args: { ...args }, resolve, reject }));
    } } },
    addEventListener(name, listener) { events.set(name, listener); },
    removeEventListener(name) { events.delete(name); },
  };
  vm.runInNewContext(source, {
    window,
    document: { documentElement: { dataset } },
    matchMedia(query) {
      const media = { matches: query === darkQuery && dark, listeners: [] };
      media.addEventListener = (_, listener) => media.listeners.push(listener);
      media.removeEventListener = (_, listener) => { media.listeners = media.listeners.filter(value => value !== listener); };
      queries.set(query, media);
      return media;
    },
  });
  return { calls, dataset, queries,
    change(query, matches) {
      const media = queries.get(query);
      media.matches = matches;
      media.listeners.forEach(listener => listener({ matches }));
    },
    focus() { events.get("focus")(); },
    dispose() { events.get("pagehide")(); },
  };
}

test("native material follows the web color scheme while browser dashboards stay independent", async () => {
  const browser = appearance(null);
  assert.equal(browser.calls.length, 0);
  assert.equal(browser.queries.size, 0);
  assert.deepEqual(browser.dataset, {});

  for (const dark of [false, true]) {
    const app = appearance("windows", dark);
    assert.equal(app.dataset.platform, "windows");
    assert.equal(app.calls[0].command, "apply_material");
    assert.deepEqual(app.calls[0].args, { enabled: true, dark });
    app.calls[0].resolve(true);
    await setImmediate();
    assert.equal(app.dataset.material, "native");
    app.change(darkQuery, !dark);
    assert.deepEqual(app.calls[1].args, { enabled: true, dark: !dark });
    app.calls[1].resolve(true);
    await setImmediate();
    assert.equal(app.dataset.material, "native");
  }
});

test("closing a page releases material listeners and ignores an in-flight result", async () => {
  const app = appearance();
  app.change(darkQuery, true);
  app.dispose();
  app.calls[0].resolve(true);
  await setImmediate();
  assert.equal(app.calls.length, 1);
  assert.equal(app.dataset.material, undefined);
  for (const media of app.queries.values()) assert.equal(media.listeners.length, 0);
});

test("material changes coalesce behind one native call and stale results cannot restore transparency", async () => {
  const app = appearance();
  app.change(darkQuery, true);
  app.change(contrastQuery, true);
  app.change(darkQuery, false);
  assert.equal(app.calls.length, 1);
  assert.equal(app.dataset.material, "solid");
  app.calls[0].resolve(true);
  await setImmediate();
  assert.equal(app.calls.length, 2);
  assert.deepEqual(app.calls[1].args, { enabled: false, dark: false });
  assert.equal(app.dataset.material, "solid");

  app.change(contrastQuery, false);
  app.calls[1].resolve(false);
  await setImmediate();
  assert.equal(app.calls.length, 3);
  assert.deepEqual(app.calls[2].args, { enabled: true, dark: false });
  assert.equal(app.dataset.material, "solid");
  app.calls[2].resolve(true);
  await setImmediate();
  assert.equal(app.dataset.material, "native");
});

test("reduced transparency becomes solid immediately and native failures recover on focus", async () => {
  const app = appearance();
  app.calls[0].resolve(true);
  await setImmediate();
  app.change(transparencyQuery, true);
  assert.equal(app.dataset.material, "solid");
  assert.deepEqual(app.calls[1].args, { enabled: false, dark: false });
  app.calls[1].reject(new Error("Native material unavailable"));
  await setImmediate();
  assert.equal(app.dataset.material, "solid");
  app.change(transparencyQuery, false);
  app.calls[2].reject(new Error("Native material unavailable"));
  await setImmediate();
  assert.equal(app.dataset.material, "solid");
  app.focus();
  assert.deepEqual(app.calls[3].args, { enabled: true, dark: false });
  app.calls[3].resolve(true);
  await setImmediate();
  assert.equal(app.dataset.material, "native");
});
