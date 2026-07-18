import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeMessages = [];
const snapshots = [];
const progressChrome = {
  runtime: {
    lastError: null,
    sendMessage(message, callback) {
      runtimeMessages.push(structuredClone(message));
      callback?.();
    },
  },
  storage: {
    local: {
      set(value, callback) {
        snapshots.push(structuredClone(value));
        callback?.();
      },
    },
  },
};

const source = await readFile(new URL("../background/progress.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const progress = await import(moduleUrl);

test("global progress aggregates in O(1) state and throttles hot updates", async () => {
  globalThis.chrome = progressChrome;
  progress.registerBatch("first", 1000);
  assert.deepEqual(progress.getGlobalProgress(), { total: 1000, processed: 0, acked: 0 });
  assert.equal(runtimeMessages.length, 1);

  for (let index = 0; index < 1000; index++) {
    progress.updateProcessed("first");
    if (index % 2 === 0) progress.updateAcked("first");
  }
  assert.deepEqual(progress.getGlobalProgress(), { total: 1000, processed: 1000, acked: 500 });
  assert.equal(runtimeMessages.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(runtimeMessages.length, 2);
  assert.deepEqual(runtimeMessages.at(-1), {
    action: "globalProgress",
    total: 1000,
    processed: 1000,
    acked: 500,
  });

  progress.completeBatch("first");
  assert.deepEqual(progress.getGlobalProgress(), { total: 0, processed: 0, acked: 0 });
  assert.equal(runtimeMessages.length, 3);
  assert.equal(snapshots.at(-1).globalProgressSnapshot.total, 0);
});

test("registering an existing batch replaces its aggregate contribution", () => {
  globalThis.chrome = progressChrome;
  progress.registerBatch("replacement", 10);
  progress.updateProcessed("replacement", 4);
  progress.registerBatch("replacement", 20);
  assert.deepEqual(progress.getGlobalProgress(), { total: 20, processed: 0, acked: 0 });
  progress.completeBatch("replacement");
});
