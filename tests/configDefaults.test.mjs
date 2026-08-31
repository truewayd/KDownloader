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
  getDefaultExternalLinkFilterConfig,
  getDefaultGistConfig,
  getDefaultWatchConfig,
  loadBackendConfig,
  loadGistConfig,
  restoreDefaultConfigs,
  saveBackendConfig,
  saveGistConfig,
} = await import("../background/config.js");

test("legacy synced secrets migrate to local storage on first read", async () => {
  syncWrites.length = 0;
  localWrites.length = 0;
  const originalSyncGet = chrome.storage.sync.get;
  const originalLocalGet = chrome.storage.local.get;
  chrome.storage.sync.get = async (key) => {
    if (key === "backendConfig") {
      return { backendConfig: { enabled: true, apiKey: "a".repeat(32), gopeedToken: "gopeed-secret" } };
    }
    if (key === "gistConfig") return { gistConfig: { enabled: true, gistId: "gist-id", token: "gist-secret" } };
    return {};
  };
  chrome.storage.local.get = async () => ({});
  try {
    const backend = await loadBackendConfig();
    const gist = await loadGistConfig();
    assert.equal(backend.apiKey, "a".repeat(32));
    assert.equal(gist.token, "gist-secret");
    assert.equal(Object.hasOwn(syncWrites.find((write) => write.backendConfig).backendConfig, "apiKey"), false);
    assert.equal(Object.hasOwn(syncWrites.find((write) => write.gistConfig).gistConfig, "token"), false);
    assert.deepEqual(localWrites.find((write) => write.backendSecrets).backendSecrets, {
      apiKey: "a".repeat(32),
      gopeedToken: "gopeed-secret",
    });
    assert.deepEqual(localWrites.find((write) => write.gistSecrets).gistSecrets, { token: "gist-secret" });
  } finally {
    chrome.storage.sync.get = originalSyncGet;
    chrome.storage.local.get = originalLocalGet;
  }
});

test("legacy secret migration never clears sync before the local write succeeds", async () => {
  syncWrites.length = 0;
  localWrites.length = 0;
  const originalSyncGet = chrome.storage.sync.get;
  const originalLocalGet = chrome.storage.local.get;
  const originalLocalSet = chrome.storage.local.set;
  chrome.storage.sync.get = async () => ({
    backendConfig: { enabled: true, apiKey: "a".repeat(32) },
  });
  chrome.storage.local.get = async () => ({});
  chrome.storage.local.set = async () => {
    throw new Error("local unavailable");
  };
  try {
    await assert.rejects(loadBackendConfig(), /local unavailable/);
    assert.equal(syncWrites.some((write) => write.backendConfig), false);
  } finally {
    chrome.storage.sync.get = originalSyncGet;
    chrome.storage.local.get = originalLocalGet;
    chrome.storage.local.set = originalLocalSet;
  }
});

test("default config restoration batches every sync value into one write", async () => {
  syncWrites.length = 0;
  const configs = await restoreDefaultConfigs();

  assert.deepEqual(configs, {
    backend: getDefaultBackendConfig(),
    downloadRules: getDefaultDownloadRulesConfig(),
    externalLinkFilter: getDefaultExternalLinkFilterConfig(),
    watch: getDefaultWatchConfig(),
    gist: getDefaultGistConfig(),
  });
  assert.equal(syncWrites.length, 1);
  assert.deepEqual(Object.keys(syncWrites[0]).sort(), [
    "backendConfig",
    "downloadRulesConfig",
    "externalLinkFilterConfig",
    "gistConfig",
    "watchConfig",
  ]);
});

test("default restoration never publishes defaults before local secrets are cleared", async () => {
  syncWrites.length = 0;
  const originalLocalSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => {
    throw new Error("local unavailable");
  };
  try {
    await assert.rejects(restoreDefaultConfigs(), /local unavailable/);
    assert.equal(syncWrites.length, 0);
  } finally {
    chrome.storage.local.set = originalLocalSet;
  }
});

test("backend and token settings are bounded and restricted to loopback", async () => {
  syncWrites.length = 0;
  localWrites.length = 0;
  const backend = await saveBackendConfig({
    enabled: true,
    host: "api.github.com",
    port: "99999",
    concurrency: 99,
    retryCount: -4,
    perPostFileLimit: 50000,
    gopeedHost: "localhost",
    apiKey: ` ${"t".repeat(32)} `,
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
    apiKey: "t".repeat(32),
    gopeedToken: "token-value",
  });
  assert.equal(Object.hasOwn(backend, "unknown"), false);
  const backendSyncWrite = syncWrites.find((write) => write.backendConfig);
  const backendLocalWrite = localWrites.find((write) => write.backendSecrets);
  assert.equal(Object.hasOwn(backendSyncWrite.backendConfig, "apiKey"), false);
  assert.equal(Object.hasOwn(backendSyncWrite.backendConfig, "gopeedToken"), false);
  assert.equal(backendLocalWrite.backendSecrets.apiKey, "t".repeat(32));
  assert.equal(backendLocalWrite.backendSecrets.gopeedToken, "token-value");

  await assert.rejects(
    saveGistConfig({ token: "unsafe\r\nheader", gistId: "  gist-id  " }),
    /printable ASCII/
  );
  const gist = await saveGistConfig({ token: "safe-token", gistId: "  gist-id  " });
  assert.deepEqual(gist, { enabled: false, token: "safe-token", gistId: "gist-id" });
  await assert.rejects(saveGistConfig({ gistId: "bad\ud800id" }), /Gist ID/);
});

test("API keys use the same printable-ASCII bounds as TrueDown", async () => {
  const unicodeKey = "é".repeat(32);
  await assert.rejects(saveBackendConfig({ apiKey: unicodeKey }), /printable ASCII/);
  assert.equal((await saveBackendConfig({ apiKey: `${"a".repeat(16)} ${"b".repeat(15)}` })).apiKey.length, 32);
  await assert.rejects(saveBackendConfig({ apiKey: `a\tb${"c".repeat(30)}` }), /printable ASCII/);
  await assert.rejects(saveBackendConfig({ apiKey: "😀".repeat(65) }), /printable ASCII/);
  assert.equal((await saveBackendConfig({ apiKey: "~".repeat(256) })).apiKey.length, 256);
  await assert.rejects(saveBackendConfig({ apiKey: "~".repeat(257) }), /printable ASCII/);
});

test("Bearer and Gopeed tokens reject values that Fetch headers cannot encode", async () => {
  await assert.rejects(saveBackendConfig({ gopeedToken: "tøkén" }), /printable ASCII/);
  assert.equal((await saveBackendConfig({ gopeedToken: "inside space" })).gopeedToken, "inside space");
  await assert.rejects(saveGistConfig({ token: "令牌" }), /printable ASCII/);
  assert.equal((await saveGistConfig({ token: "gist token" })).token, "gist token");
});

test("content-script config reads are redacted and cannot mutate settings", async () => {
  const originalSyncGet = chrome.storage.sync.get;
  const originalLocalGet = chrome.storage.local.get;
  chrome.storage.sync.get = async (key) => {
    if (key === "backendConfig") return { backendConfig: { enabled: true } };
    if (key === "gistConfig") return { gistConfig: { enabled: true, gistId: "gist-id" } };
    return {};
  };
  chrome.storage.local.get = async (key) => {
    if (key === "backendSecrets") {
      return { backendSecrets: { apiKey: "t".repeat(32), gopeedToken: "gopeed-secret" } };
    }
    if (key === "gistSecrets") return { gistSecrets: { token: "gist-secret" } };
    return {};
  };
  try {
    const { createConfigHandlers } = await import("../background/handlers/configHandlers.js");
    const handlers = createConfigHandlers();
    const contentSender = { tab: { id: 1 }, url: "https://kemono.cr/post" };
    const backend = await new Promise((resolve) => handlers["backend.getConfig"]({ sender: contentSender, sendResponse: resolve }));
    const gist = await new Promise((resolve) => handlers["gist.getConfig"]({ sender: contentSender, sendResponse: resolve }));
    assert.equal(backend.config.apiKey, "");
    assert.equal(backend.config.gopeedToken, "");
    assert.equal(gist.config.token, "");
    const extensionTab = {
      tab: { id: 2, url: "https://kemono.cr/stale-tab-url" },
      url: "chrome-extension://test/settings.html",
    };
    const extensionBackend = await new Promise((resolve) =>
      handlers["backend.getConfig"]({ sender: extensionTab, sendResponse: resolve }));
    assert.equal(extensionBackend.config.apiKey, "t".repeat(32));
    assert.throws(
      () => handlers["backend.setConfig"]({ message: { config: {} }, sender: contentSender, sendResponse() {} }),
      /restricted to extension pages/
    );
  } finally {
    chrome.storage.sync.get = originalSyncGet;
    chrome.storage.local.get = originalLocalGet;
  }
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
  assert.deepEqual(localWrites, [
    {
      backendSecrets: { apiKey: "", gopeedToken: "" },
      gistSecrets: { token: "" },
    },
    { creatorsOverrideEnabled: false },
  ]);
  assert.deepEqual(alarmCreates, [{
    name: "pawchiveWatchCheck",
    options: { delayInMinutes: 30, periodInMinutes: 30 },
  }]);
});
