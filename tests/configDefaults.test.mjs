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
  saveBackendConfig,
  saveGistConfig,
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

test("backend and token settings are bounded and restricted to loopback", async () => {
  const backend = await saveBackendConfig({
    enabled: true,
    host: "api.github.com",
    port: "99999",
    concurrency: 99,
    retryCount: -4,
    perPostFileLimit: 50000,
    gopeedHost: "localhost",
    gopeedToken: " token-value ",
    unknown: "discarded",
  });
  assert.deepEqual(backend, {
    ...getDefaultBackendConfig(),
    enabled: true,
    port: 65535,
    concurrency: 6,
    retryCount: 0,
    perPostFileLimit: 1000,
    gopeedHost: "localhost",
    gopeedToken: "token-value",
  });
  assert.equal(Object.hasOwn(backend, "unknown"), false);

  const gist = await saveGistConfig({ token: "unsafe\r\nheader", gistId: "  gist-id  " });
  assert.deepEqual(gist, { enabled: false, token: "", gistId: "gist-id" });
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
