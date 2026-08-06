import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

const [
  popupHtml,
  settingsHtml,
  popupCss,
  settingsCss,
  sharedCss,
  sharedUiSource,
  contentCss,
  manifestSource,
  actionsSource,
  pawActionsSource,
  coomerFansActionsSource,
  flagSource,
  trueDownHtml,
  trueDownCss,
] = await Promise.all([
  read("popup/popup.html"),
  read("settings.html"),
  read("popup/popup.css"),
  read("settings.css"),
  read("shared/ui.css"),
  read("shared/ui.js"),
  read("content.css"),
  read("manifest.json"),
  read("content/actions.js"),
  read("content/paw_actions.js"),
  read("content/coomerfans_actions.js"),
  read("content/flag/index.js"),
  read("truedown/web/index.html"),
  read("truedown/web/styles.css"),
]);

test("extension pages use one component and icon layer", () => {
  assert.match(popupHtml, /\.\.\/shared\/ui\.css/);
  assert.match(popupHtml, /\.\.\/shared\/ui\.js/);
  assert.match(settingsHtml, /shared\/ui\.css/);
  assert.match(settingsHtml, /shared\/ui\.js/);
  assert.doesNotMatch(popupHtml, /<symbol\b/);
  assert.doesNotMatch(settingsHtml, /<symbol\b/);

  for (const html of [popupHtml, settingsHtml]) {
    assert.match(html, /class="kd-panel/);
    assert.match(html, /class="kd-button/);
    assert.match(html, /shared\/icons\.svg#icon-/);
  }
  for (const pageCss of [popupCss, settingsCss]) {
    assert.doesNotMatch(pageCss, /:root\s*\{/);
    assert.doesNotMatch(pageCss, /@keyframes\b/);
  }
  assert.match(sharedCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test("injected UI is scoped and site scripts reuse shared renderers", () => {
  assert.match(contentCss, /\.kd-action-button/);
  assert.match(contentCss, /\.kd-modal-overlay/);
  assert.match(contentCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(contentCss, /@keyframes\s+(?:spin|fadeIn)\b/);
  assert.doesNotMatch(contentCss, /transition:\s*all\b/);

  const siteSources = [actionsSource, pawActionsSource, coomerFansActionsSource];
  for (const source of siteSources) {
    assert.match(source, /renderPostDownloadButton/);
    assert.match(source, /renderCreatorDownloadButtons/);
    assert.match(source, /ensurePageFetchButton/);
    assert.doesNotMatch(source, /_button_[a-f0-9]+/i);
    assert.doesNotMatch(source, /\.style\.(?:margin|padding|position|transform)/);
  }
  assert.doesNotMatch(flagSource, /\.style\.|cssText/);
});

test("favorites injection preserves shared script order and styles", () => {
  const manifest = JSON.parse(manifestSource);
  const entry = manifest.content_scripts.find((item) =>
    item.matches.some((pattern) => pattern.includes("favorites/artists"))
  );
  assert.deepEqual(entry.js, [
    "content/helpers.js",
    "shared/i18n.js",
    "content/ui.js",
    "content/router.js",
    "content/flag/index.js",
  ]);
  assert.deepEqual(entry.css, ["content.css"]);
});

test("shared busy state restores the prior button state", async () => {
  const runtime = {
    lastError: null,
    sendMessage(message, callback) {
      callback({ success: true, echo: message.action });
    },
  };
  const context = vm.createContext({
    chrome: { runtime },
    clearTimeout,
    console,
    document: {},
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
  });
  vm.runInContext(sharedUiSource, context);

  const response = await context.KDUI.sendMessage({ action: "ping" }, 50, { retries: 0 });
  assert.equal(response.echo, "ping");

  const attributes = new Map();
  const button = {
    disabled: false,
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
    setAttribute: (name, value) => attributes.set(name, value),
  };
  await context.KDUI.withBusyButton(button, async () => {
    assert.equal(button.disabled, true);
    assert.equal(attributes.get("aria-busy"), "true");
  });
  assert.equal(button.disabled, false);
  assert.equal(attributes.has("aria-busy"), false);
});

function kdTokens(css) {
  return [...css.matchAll(/^\s*(--kd-[\w-]+):\s*([^;]+);/gm)].map((match) => [
    match[1],
    match[2].trim(),
  ]);
}

test("TrueDown keeps KDownloader's shared light and dark design tokens", () => {
  assert.deepEqual(kdTokens(trueDownCss), kdTokens(sharedCss));
});

test("TrueDown markup uses the shared KDownloader component vocabulary", () => {
  assert.match(trueDownHtml, /class="kd-panel task-panel"/);
  assert.match(trueDownHtml, /class="kd-button primary"/);
  assert.match(trueDownHtml, /class="kd-button secondary"/);
  assert.match(trueDownHtml, /class="kd-icon-button"/);
  assert.match(trueDownHtml, /class="kd-toast"/);
  assert.doesNotMatch(trueDownHtml, /class="(?:button|panel|icon-button|toast)(?:\s|\")/);
});
