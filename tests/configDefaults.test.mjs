import assert from "node:assert/strict";
import test from "node:test";

const syncWrites = [];
const localWrites = [];
const alarmCreates = [];

globalThis.chrome = {
  alarms: {
    async clear() { return true; },
    create(name, options) { alarmCreates.push({ name, options }); },
  },
  storage: {
    local: {
      async get() { return {}; },
      async set(value) { localWrites.push(value); },
    },
    sync: {
      async get() { return {}; },
      async set(value) { syncWrites.push(value); },
    },
  },
};

const {
  getDefaultBackendConfig,
  getDefaultDownloadRulesConfig,
  getDefaultGistConfig,
  getDefaultWatchConfig,
  restoreDefaultConfigs,
} = await import("../background/config.js");

test("default config restoration batches every sync value into one write", async () => {
  syncWrites.length = 0;
  const configs = await restoreDefaultConfigs();

  assert.deepEqual(configs, {
    backend: getDefaultBackendConfig(),
    downloadRules: getDefaultDownloadRulesConfig(),
    watch: getDefaultWatchConfig(),
    gist: getDefaultGistConfig(),
  });
  assert.equal(syncWrites.length, 1);
  assert.deepEqual(Object.keys(syncWrites[0]).sort(), [
    "backendConfig",
    "downloadRulesConfig",
    "gistConfig",
    "watchConfig",
  ]);
});

test("settings restore RPC resets config, search override, and watch schedule", async () => {
  syncWrites.length = 0;
  localWrites.length = 0;
  alarmCreates.length = 0;
  const { createConfigHandlers } = await import("../background/handlers/configHandlers.js");
  const handler = createConfigHandlers()["settings.restoreDefaults"];
  const response = await new Promise((resolve) => handler({ sendResponse: resolve }));

  assert.equal(response.success, true);
  assert.equal(syncWrites.length, 1);
  assert.deepEqual(localWrites, [{ creatorsOverrideEnabled: false }]);
  assert.deepEqual(alarmCreates, [{
    name: "pawchiveWatchCheck",
    options: { delayInMinutes: 30, periodInMinutes: 30 },
  }]);
});
