import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dashboardSource } from "./helpers/truedownSource.mjs";

function declarations(...names) {
  return names.map(name => dashboardSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]).join("\n");
}

test("BT identity controls gate old engines and retain unsaved values on engine refresh", () => {
  const context = vm.createContext({
    els: { btClientIdentity: {}, cfgBtUserAgent: { value: "draft" }, cfgBtPeerIdPrefix: { value: "-TD1000-" } },
    KNOWN_NEXT_LIBTORRENT_VERSIONS: { "2.6.6": "2.1.1" },
  });
  vm.runInContext(declarations("supportsBitTorrentIdentity", "bitTorrentIdentityDescription", "aria2NextPeerFingerprint", "renderBitTorrentIdentity"), context);
  for (const [engine, engineVersion, supported] of [["stable", "1.37.0", false], ["next", "", false], ["next", "2.6.6", false], ["next", "2.6.7", true], ["next", "2.8.3", true]]) {
    context.renderBitTorrentIdentity({ engine, engineVersion });
    assert.equal(context.els.cfgBtUserAgent.disabled, !supported);
    assert.equal(context.els.cfgBtPeerIdPrefix.disabled, !supported);
    assert.equal(context.els.cfgBtUserAgent.value, "draft");
    if (supported) assert.doesNotMatch(context.els.btClientIdentity.textContent, /固定|A2/);
  }
});

test("engine identity save captures both fields before awaiting and does not overwrite HTTP concurrency", async () => {
  let finishRules;
  const writes = [];
  const fields = new Map();
  const els = new Proxy({}, { get(_target, key) {
    if (!fields.has(key)) fields.set(key, { value: "", checked: false });
    return fields.get(key);
  } });
  els.cfgBtUserAgent.value = " Custom/1.0 ";
  els.cfgBtPeerIdPrefix.value = "-TD1000-";
  const context = vm.createContext({
    els, document: {}, currentPage: "settings", currentSettingsPage: "engine",
    settingsReady: new Set(["engine"]), settingsMessages: new Map(), settingsDirtyControls: new Map(),
    EDITABLE_SETTINGS_PAGES: new Set(["engine"]), settingsPanels: () => [],
    taskDefaultsRevision: 1, downloadSettings: { userAgent: "HTTP-client" },
    invalidateSettingRead() {}, readDropboxCustomSuffixes: () => [],
    normalizeServerDownloadRules: value => value, normalizeServerRuntimeSettings: value => value,
    renderDropboxFilter() {}, applyTaskDefaults() {}, renderSettingsCategory() {}, showToast() {},
    requestJSON: (path, options) => {
      const value = JSON.parse(options.body);
      writes.push({ path, value });
      if (path === "/settings/download-rules") return new Promise(resolve => { finishRules = resolve; });
      return Promise.resolve(value);
    },
  });
  vm.runInContext(declarations("saveDownloadSettings"), context);
  const pending = context.saveDownloadSettings({ preventDefault() {} });
  els.cfgBtUserAgent.value = "later value";
  finishRules({});
  await pending;
  assert.deepEqual(writes.find(write => write.path === "/settings/runtime").value,
    { btUserAgent: "Custom/1.0", btPeerIdPrefix: "-TD1000-" });
  assert.equal(writes.find(write => write.path === "/settings/task-defaults").value.values.userAgent, "HTTP-client");
});
