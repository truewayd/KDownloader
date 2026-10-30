import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../popup/popup.js", import.meta.url), "utf8");
function panel() {
  const classes = new Set();
  return { classes, classList: {
    toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
    add(name) { classes.add(name); },
  } };
}
for (const oldFails of [false, true]) test(`popup ignores older ${oldFails ? "failed" : "successful"} reads across all resources`, async () => {
  const pending = [], renders = [], warnings = [];
  const context = vm.createContext({
    backendReadRevision: 0, featureReadRevision: 0, statsReadRevision: 0,
    safeSendMessage: ({ action }) => new Promise((resolve, reject) => pending.push({ action, resolve, reject })),
    setCreatorFetchAvailability: config => renders.push(config?.enabled),
    searchCachePanel: panel(), gistPanel: panel(), storageUsed: {},
    t: key => key, console: { warn: (...args) => warnings.push(args) },
  });
  for (const name of ["loadBackendState", "loadFeatureVisibility", "loadStats"]) {
    vm.runInContext(source.match(new RegExp(`async function ${name}\\([^]*?\\n\\}`))[0], context);
  }
  const start = () => Promise.all([context.loadBackendState(), context.loadFeatureVisibility(), context.loadStats()]);
  const old = start(), newer = start();
  const respond = (request, enabled, records) => request.resolve({ enabled, config: { enabled }, stats: { bytes: 2048, records } });
  pending.slice(4).forEach(request => respond(request, true, 22));
  await newer;
  pending.slice(0, 4).forEach(request => oldFails ? request.reject(new Error("old read")) : respond(request, false, 1));
  await old;
  assert.deepEqual(renders, [true]);
  assert.equal(context.searchCachePanel.classes.has("kd-hidden"), false);
  assert.equal(context.gistPanel.classes.has("kd-hidden"), false);
  assert.match(context.storageUsed.textContent, /22$/);
  assert.deepEqual(warnings, []);
  const latest = start();
  pending.slice(8).forEach(request => request.reject(new Error("current read")));
  await latest;
  assert.deepEqual(renders, [true, undefined]);
  assert.equal(context.searchCachePanel.classes.has("kd-hidden"), true);
  assert.equal(context.gistPanel.classes.has("kd-hidden"), true);
  assert.equal(context.storageUsed.textContent, "statusError");
});
