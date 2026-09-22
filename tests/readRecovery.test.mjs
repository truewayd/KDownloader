import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dashboardSource } from "./helpers/truedownSource.mjs";

const source = await readFile(new URL("../truedown/web/read-recovery.js", import.meta.url), "utf8");
function harness() {
  const timers = new Map(), events = new Map();
  let sequence = 0;
  const context = vm.createContext({
    document: { hidden: false, addEventListener: (name, callback) => events.set(name, callback) },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    setTimeout: (callback, delay) => { timers.set(++sequence, { callback, delay }); return sequence; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source, context);
  const tick = async () => {
    assert.equal(timers.size, 1);
    const [id, timer] = [...timers][0];
    timers.delete(id);
    await timer.callback();
    return timer.delay;
  };
  return { context, timers, events, tick };
}

test("failed reads back off, coalesce by view and stop after recovery", async () => {
  const { context, timers, tick } = harness();
  let attempts = 0, recovered = false;
  const read = async () => {
    attempts++;
    if (recovered) context.cancelReadRetry("settings");
    else context.scheduleReadRetry("settings", read, () => true);
  };
  context.scheduleReadRetry("settings", read, () => true);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) assert.equal(await tick(), delay);
  assert.equal(attempts, 7);
  recovered = true;
  await tick();
  assert.equal(timers.size, 0);
  context.scheduleReadRetry("settings", read, () => true);
  assert.equal(await tick(), 1000, "a new outage starts with the short delay");
});

test("hidden views suspend recovery; connectivity resumes it without overlapping a read", async () => {
  const { context, timers, events, tick } = harness();
  let finish, reads = 0;
  context.scheduleReadRetry("form", () => { reads++; return new Promise(resolve => { finish = resolve; }); }, () => true);
  context.document.hidden = true;
  events.get("visibilitychange")();
  assert.equal(timers.size, 0);
  context.document.hidden = false;
  events.get("visibilitychange")();
  events.get("online")();
  const pending = tick();
  events.get("online")();
  await tick();
  assert.equal(reads, 1);
  finish();
  assert.equal(await pending, 0);
  events.get("pagehide")();
  context.scheduleReadRetry("form", assert.fail, () => true);
  assert.equal(timers.size, 0);
});

test("route cancellation and stale guards prevent a hidden category from reloading", async () => {
  const { context, timers, tick } = harness();
  let current = true;
  context.scheduleReadRetry("settings", assert.fail, () => current);
  current = false;
  await tick();
  assert.equal(timers.size, 0);
  context.scheduleReadRetry("about", assert.fail, () => true);
  context.cancelReadRetries();
  assert.equal(timers.size, 0);
});

test("recovered revisions retain local edits and adopt untouched remote values", () => {
  const { context } = harness();
  assert.deepEqual(JSON.parse(JSON.stringify(context.reconcileReadDraft(
    { connections: "16", maxTries: "5" }, { connections: "8", maxTries: "5" },
    { connections: "32", maxTries: "9" },
  ))), { connections: "8", maxTries: "9" });
  vm.runInContext(dashboardSource.match(/function reconcileFileGroups\([^]*?\n\}/)[0], context);
  const base = [{ id: "a", name: "A", extensions: [".zip"] }, { id: "b", name: "B" }, { id: "other", name: "Other" }];
  const draft = [{ ...base[0], name: "Local" }, { id: "new", name: "New" }, base[2]];
  const latest = [{ ...base[0], extensions: [".rar"] }, base[1], { id: "remote", name: "Remote" }, base[2]];
  assert.deepEqual(JSON.parse(JSON.stringify(context.reconcileFileGroups(base, draft, latest))), [
    { id: "a", name: "Local", extensions: [".rar"] }, { id: "remote", name: "Remote" },
    { id: "new", name: "New" }, base[2],
  ]);
});
