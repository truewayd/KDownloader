import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n?/g, "\n");

const [
  popupHtml,
  settingsHtml,
  popupCss,
  settingsCss,
  sharedCss,
  sharedComponentsSource,
  sharedUiSource,
  settingsSource,
  englishMessagesSource,
  chineseMessagesSource,
  contentCss,
  contentUiSource,
  helpersSource,
  manifestSource,
  actionsSource,
  pawActionsSource,
  coomerFansActionsSource,
  flagSource,
  trueDownHtml,
  trueDownCss,
  trueDownComponentsSource,
  trueDownApp,
  kdownloaderLogo,
  trueDownLogo,
] = await Promise.all([
  read("popup/popup.html"),
  read("settings.html"),
  read("popup/popup.css"),
  read("settings.css"),
  read("shared/ui.css"),
  read("shared/components.js"),
  read("shared/ui.js"),
  read("settings.js"),
  read("_locales/en/messages.json"),
  read("_locales/zh_CN/messages.json"),
  read("content.css"),
  read("content/ui.js"),
  read("content/helpers.js"),
  read("manifest.json"),
  read("content/actions.js"),
  read("content/paw_actions.js"),
  read("content/coomerfans_actions.js"),
  read("content/flag/index.js"),
  read("truedown/web/index.html"),
  read("truedown/web/styles.css"),
  read("truedown/web/components.js"),
  read("truedown/web/app.js"),
  read("icons/kdownloader-logo.svg"),
  read("truedown/web/truedown-logo.svg"),
]);

test("extension pages use one component and icon layer", () => {
  assert.match(popupHtml, /\.\.\/shared\/ui\.css/);
  assert.match(popupHtml, /\.\.\/shared\/components\.js/);
  assert.match(popupHtml, /\.\.\/shared\/ui\.js/);
  assert.match(settingsHtml, /shared\/ui\.css/);
  assert.match(settingsHtml, /shared\/components\.js/);
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
  assert.match(settingsHtml, /class="settings-logo" src="icons\/kdownloader-logo\.svg"/);
  assert.match(kdownloaderLogo, /viewBox="0 0 1024 1024"/);
  assert.match(kdownloaderLogo, /<linearGradient\b/);
  assert.doesNotMatch(kdownloaderLogo, /<image\b/);
});

test("TrueDown branding stays standalone and uses the production SVG mark", () => {
  assert.match(trueDownHtml, /rel="icon" href="\/truedown-logo\.svg"/);
  assert.match(trueDownHtml, /class="brand-mark"[\s\S]*src="\/truedown-logo\.svg"/);
  assert.match(trueDownLogo, /viewBox="0 0 1024 1024"/);
  assert.match(trueDownLogo, /<linearGradient\b/);
  assert.doesNotMatch(trueDownLogo, /<image\b/);

  for (const source of [trueDownHtml, trueDownCss, trueDownApp]) {
    assert.doesNotMatch(source, /KDownloader/i);
  }
});

test("injected UI is scoped and site scripts reuse shared renderers", () => {
  assert.match(contentCss, /Host-page layout only/);
  assert.match(contentCss, /kd-ui-action/);
  assert.doesNotMatch(contentCss, /background:|border:|color:/);
  assert.match(sharedComponentsSource, /attachShadow\(\{ mode: "open", delegatesFocus: true \}\)/);
  assert.match(sharedComponentsSource, /adoptedStyleSheets/);
  assert.match(sharedComponentsSource, /kd-ui-action/);
  assert.match(sharedComponentsSource, /kd-ui-links-dialog/);
  assert.match(sharedComponentsSource, /function createActionElement\(ownerDocument = document\)/);
  assert.match(sharedComponentsSource, /function ensureActionElement\(element\)/);
  assert.match(sharedComponentsSource, /function initializeManualActionElement\(element\)/);
  assert.match(sharedComponentsSource, /function createLinksDialogElement\(ownerDocument = document\)/);
  assert.match(sharedComponentsSource, /function ensureLinksDialogElement\(element\)/);
  assert.match(sharedComponentsSource, /function initializeLinksDialogElement\(element\)/);
  assert.match(
    sharedComponentsSource,
    /element\.shadowRoot\?\.querySelector\("button"\)\s*\|\| initializeManualActionElement\(element\)/
  );
  assert.doesNotMatch(sharedComponentsSource, /failed to initialize/);
  assert.match(sharedComponentsSource, /style\[data-kd-action-fallback\]/);
  assert.match(
    sharedComponentsSource,
    /background:\s*var\(--kd-content-surface\);\s*background:\s*color-mix\(/
  );
  assert.match(sharedComponentsSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(contentCss, /@keyframes\s+(?:spin|fadeIn)\b/);
  assert.doesNotMatch(contentCss, /transition:\s*all\b/);
  assert.match(
    contentCss,
    /kd-ui-action\[variant="creator"\][\s\S]*?position:\s*absolute\s*!important;[\s\S]*?right:\s*8px\s*!important;[\s\S]*?bottom:\s*8px\s*!important;[\s\S]*?pointer-events:\s*auto\s*!important;[\s\S]*?cursor:\s*pointer\s*!important;/
  );
  assert.match(contentCss, /\.kd-overlay-container\s*\{[^}]*isolation:\s*isolate\s*!important;/s);
  assert.match(
    contentCss,
    /kd-ui-action\s*\{[^}]*pointer-events:\s*auto\s*!important;[^}]*cursor:\s*pointer\s*!important;/s
  );
  assert.match(sharedComponentsSource, /const expectedCursor = status === "SCANNING"/);
  assert.match(contentUiSource, /KDComponents\.createLinksDialogElement\(\)/);
  assert.match(contentUiSource, /if \(!dialog\.isConnected\) \{\s*dialog\.close\(\);\s*finish\(\);/);
  assert.doesNotMatch(contentUiSource, /document\.createElement\(KDComponents\.LINKS_DIALOG_TAG\)/);
  assert.match(contentUiSource, /getComputedStyle\(element\)\.position/);
  assert.match(contentUiSource, /function releasePositionContext\(element\)/);
  assert.match(contentUiSource, /function removeKdElements\(selector\)/);
  assert.match(
    contentUiSource,
    /function ensureCreatorDownloadButton\([\s\S]{0,320}ensurePositionContext\(container\);[\s\S]{0,160}container\.appendChild\(button\)/
  );
  assert.match(contentUiSource, /if \(options\.decorateContainer\)[^\n]+\n\s*if \(isActiveDownloadButton\(button\)\) continue;/);
  assert.match(helpersSource, /btn\.remove\(\);\s*if \(typeof releasePositionContext/);
  assert.doesNotMatch(contentUiSource, /document\.createElement\(KD_ACTION_TAG\)/);
  assert.match(flagSource, /KDComponents\.createActionElement\(\)/);

  const siteSources = [actionsSource, pawActionsSource, coomerFansActionsSource];
  for (const source of siteSources) {
    assert.match(source, /renderPostDownloadButton/);
    assert.match(source, /renderCreatorDownloadButtons/);
    assert.match(source, /ensurePageFetchButton/);
    assert.match(source, /removeKdElements/);
    assert.doesNotMatch(source, /_button_[a-f0-9]+/i);
    assert.doesNotMatch(source, /\.style\.(?:margin|padding|position|transform)/);
  }
  assert.doesNotMatch(flagSource, /\.style\.|cssText/);
});

test("settings segmented controls can shrink without horizontal overflow", () => {
  assert.match(sharedCss, /\.kd-segmented\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
  assert.match(sharedCss, /\.kd-segment\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(settingsCss, /\.settings-grid\s*\{[^}]*min-width:\s*0;/s);
  assert.match(settingsCss, /\.kd-panel\s*\{[^}]*min-width:\s*0;/s);
});

test("favorites injection preserves shared script order and styles", () => {
  const manifest = JSON.parse(manifestSource);
  const entry = manifest.content_scripts.find((item) =>
    item.matches.some((pattern) => pattern.includes("favorites/artists"))
  );
  assert.deepEqual(entry.js, [
    "content/helpers.js",
    "shared/i18n.js",
    "shared/components.js",
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
  vm.runInContext(sharedComponentsSource, context);
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

test("Watch exports use a bounded compact format that the importer can accept", () => {
  assert.match(settingsSource, /const MAX_WATCH_STORAGE_BYTES = 4 \* 1024 \* 1024/);
  assert.match(
    settingsSource,
    /const MAX_WATCH_IMPORT_FILE_BYTES = MAX_WATCH_STORAGE_BYTES \+ 1024/
  );
  const exportFunction = settingsSource.match(
    /async function exportWatchList\(\) \{[\s\S]*?\n\}/
  )?.[0];
  const importFunction = settingsSource.match(
    /async function importWatchList\(file\) \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(exportFunction);
  assert.ok(importFunction);
  assert.match(exportFunction, /new Blob\(\[JSON\.stringify\(data\)\]/);
  assert.doesNotMatch(exportFunction, /JSON\.stringify\(data, null, 2\)/);
  assert.match(exportFunction, /blob\.size > MAX_WATCH_IMPORT_FILE_BYTES/);
  assert.match(importFunction, /file\.size > MAX_WATCH_IMPORT_FILE_BYTES/);
});

test("shared busy state remains active until overlapping tasks both settle", async () => {
  const context = vm.createContext({
    chrome: { runtime: { lastError: null, sendMessage() {} } },
    clearTimeout,
    console,
    document: {},
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
  });
  vm.runInContext(sharedComponentsSource, context);
  vm.runInContext(sharedUiSource, context);

  const attributes = new Map();
  const button = {
    disabled: false,
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
    setAttribute: (name, value) => attributes.set(name, value),
  };
  let resolveFirst;
  let resolveSecond;
  const first = context.KDUI.withBusyButton(button, () => new Promise((resolve) => { resolveFirst = resolve; }));
  const second = context.KDUI.withBusyButton(button, () => new Promise((resolve) => { resolveSecond = resolve; }));

  resolveFirst();
  await first;
  assert.equal(button.disabled, true);
  assert.equal(attributes.get("aria-busy"), "true");

  resolveSecond();
  await second;
  assert.equal(button.disabled, false);
  assert.equal(attributes.has("aria-busy"), false);
});

test("shared messaging never retries an ambiguous timeout", async () => {
  let sendCount = 0;
  const context = vm.createContext({
    chrome: {
      runtime: {
        lastError: null,
        sendMessage() { sendCount += 1; },
      },
    },
    clearTimeout,
    console,
    document: {},
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
  });
  vm.runInContext(sharedComponentsSource, context);
  vm.runInContext(sharedUiSource, context);

  await assert.rejects(
    context.KDUI.sendMessage({ action: "mutating.action" }, 5, { retries: 3, retryDelay: 0 }),
    /timed out/i
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sendCount, 1);
});

test("settings validates backend API Keys as 32 to 256 printable ASCII characters", () => {
  const declaration = settingsSource.match(/function backendApiKeyValue\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(declaration, "backendApiKeyValue should remain a focused validator");
  const input = { value: "" };
  const context = vm.createContext({
    input,
    $: () => input,
    t: (_key, _substitutions, fallback) => fallback,
  });
  vm.runInContext(`${declaration}\nglobalThis.backendApiKeyValue = backendApiKeyValue;`, context);
  const validate = (value) => {
    input.value = value;
    return context.backendApiKeyValue();
  };

  assert.equal(validate(""), "");
  assert.equal(validate(`  ${"a".repeat(32)}  `), "a".repeat(32));
  assert.equal(validate(`${"a".repeat(16)} ${"b".repeat(15)}`), `${"a".repeat(16)} ${"b".repeat(15)}`);
  assert.equal(validate("~".repeat(256)), "~".repeat(256));
  assert.throws(() => validate("a".repeat(31)), /32 to 256 printable ASCII characters/);
  assert.throws(() => validate("a".repeat(257)), /32 to 256 printable ASCII characters/);
  assert.throws(() => validate("a".repeat(31) + "界"), /32 to 256 printable ASCII characters/);
  for (const control of ["\0", "\t", "\n", "\x1f", "\x7f"]) {
    assert.throws(
      () => validate(`${"a".repeat(16)}${control}${"b".repeat(16)}`),
      /32 to 256 printable ASCII characters/
    );
  }

  assert.match(JSON.parse(englishMessagesSource).backendApiKeyInvalid.message, /printable ASCII/);
  assert.match(JSON.parse(chineseMessagesSource).backendApiKeyInvalid.message, /可打印 ASCII/);
});

test("settings validates every token used in a Fetch header", () => {
  const declaration = settingsSource.match(/function headerSecretValue\(id\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(declaration, "headerSecretValue should remain a focused validator");
  const input = { value: "" };
  const context = vm.createContext({
    input,
    $: () => input,
    t: (_key, _substitutions, fallback) => fallback,
  });
  vm.runInContext(`${declaration}\nglobalThis.headerSecretValue = headerSecretValue;`, context);
  const validate = (value) => {
    input.value = value;
    return context.headerSecretValue("token");
  };

  assert.equal(validate(""), "");
  assert.equal(validate("  token with space  "), "token with space");
  assert.equal(validate("~".repeat(4096)).length, 4096);
  assert.throws(() => validate("~".repeat(4097)), /4096 printable ASCII/);
  assert.throws(() => validate("令牌"), /4096 printable ASCII/);
  assert.throws(() => validate("line\nbreak"), /4096 printable ASCII/);
  assert.match(JSON.parse(englishMessagesSource).headerSecretInvalid.message, /4096 printable ASCII/);
  assert.match(JSON.parse(chineseMessagesSource).headerSecretInvalid.message, /4096 个可打印 ASCII/);
});

test("extension icon-only controls expose localized accessible names", () => {
  for (const id of ["watch-check", "creators-update-coomer", "creators-update-kemono"]) {
    assert.match(
      settingsHtml,
      new RegExp(`<button[^>]+id="${id}"[^>]+aria-label="[^"]+"[^>]+data-i18n-aria-label=`)
    );
  }
  assert.match(popupHtml, /id="creator-url"[^>]+data-i18n-aria-label=/);
  assert.match(popupHtml, /id="global-progress-track"[^>]+aria-labelledby="global-progress-label"/);
});

function kdTokens(css) {
  return [...css.matchAll(/^\s*(--kd-[\w-]+):\s*([^;]+);/gm)].map((match) => [
    match[1],
    match[2].trim(),
  ]);
}

test("TrueDown keeps its light and dark design tokens", () => {
  assert.deepEqual(kdTokens(trueDownCss), kdTokens(sharedCss));
});

test("the shared brand palette is anchored to #487A7A", () => {
  for (const css of [sharedCss, trueDownCss]) {
    assert.equal((css.match(/--kd-accent:\s*#487a7a;/gi) ?? []).length, 2);
  }
  assert.equal((sharedComponentsSource.match(/--kd-content-accent:\s*#487a7a;/gi) ?? []).length, 2);
  assert.match(kdownloaderLogo, /stop-color="#487a7a"/i);
  assert.match(trueDownLogo, /stop-color="#487a7a"/i);
});

test("TrueDown markup uses a consistent component vocabulary", () => {
  assert.match(trueDownHtml, /class="kd-panel task-panel"/);
  assert.match(trueDownHtml, /class="kd-button primary"/);
  assert.match(trueDownHtml, /class="kd-button secondary"/);
  assert.match(trueDownHtml, /class="kd-icon-button"/);
  assert.match(trueDownHtml, /class="kd-toast"/);
  assert.doesNotMatch(trueDownHtml, /class="(?:button|panel|icon-button|toast)(?:\s|\")/);
});

test("TrueDown consumes the generated canonical component runtime", () => {
  assert.equal(trueDownComponentsSource, sharedComponentsSource);
  assert.match(
    trueDownHtml,
    /<script src="\/components\.js" defer><\/script>[\s\S]*<script src="\/app\.js" defer><\/script>/
  );
  assert.match(trueDownApp, /KDComponents\.createToast/);
  assert.match(trueDownApp, /KDComponents\.prepareDecorativeIcons/);
  assert.match(trueDownApp, /KDComponents\.setBusyState/);
  assert.doesNotMatch(
    trueDownApp,
    /(?:setAttribute|removeAttribute|toggleAttribute)\("aria-busy"/
  );
});

test("TrueDown bounds task rendering and exposes accessible batch controls", () => {
  assert.match(trueDownHtml, /id="task-filter"/);
  assert.match(trueDownHtml, /id="task-search"[^>]+type="search"/);
  assert.match(trueDownHtml, /id="batch-pause-btn"/);
  assert.match(trueDownHtml, /id="batch-resume-btn"/);
  assert.match(trueDownHtml, /id="batch-remove-btn"/);
  assert.match(trueDownHtml, /id="pause-queue-btn"/);
  assert.match(trueDownHtml, /id="resume-queue-btn"/);
  assert.match(trueDownHtml, /id="open-downloads-btn"/);
  assert.match(trueDownHtml, /id="cfg-task-concurrency"[^>]+placeholder="3"/);
  assert.match(trueDownHtml, /id="cfg-dropbox-mode"/);
  assert.match(trueDownHtml, /id="m-dropbox-mode"/);
  assert.match(trueDownHtml, /id="m-dropbox-filter"/);
	assert.match(trueDownHtml, /id="module-list"/);
	assert.match(trueDownHtml, /id="m-google-drive-option"/);
  assert.match(trueDownHtml, /id="auto-update-truedown"/);
  assert.match(trueDownHtml, /id="install-next-engine-btn"/);
  assert.match(trueDownHtml, /id="select-stable-engine-btn"/);
  assert.match(trueDownHtml, /id="select-next-engine-btn"/);
  assert.match(trueDownHtml, /id="application-log-output"[^>]+tabindex="0"/);
  assert.match(trueDownHtml, /关闭此网页不会中断下载/);
  assert.match(trueDownApp, /requestJSON\("\/system\/update\/check"/);
  assert.match(trueDownApp, /requestJSON\("\/system\/engine\/next"/);
  assert.match(trueDownApp, /requestJSON\("\/system\/engine\/select"/);
  assert.match(trueDownApp, /requestJSON\("\/system\/logs"/);
  assert.match(trueDownHtml, /href="\/icons\.svg#icon-/);
  assert.match(trueDownHtml, /id="token-auth-enabled"/);
  assert.match(trueDownApp, /const PAGE_SIZE = 100/);
  assert.match(trueDownApp, /const MAX_PAGE_ETAGS = 128/);
  assert.match(trueDownApp, /If-None-Match/);
  assert.match(trueDownApp, /while \(pageETags\.size > MAX_PAGE_ETAGS\)/);
  assert.match(trueDownApp, /if \(!selectedTaskIDs\.has\(id\)\) taskStatusByID\.delete\(id\)/);
  assert.match(trueDownApp, /function renderDownloadSettings\(settings = downloadSettings, rules = downloadRules, runtime = runtimeSettings\)/);
  assert.match(trueDownApp, /data-select-page/);
  assert.match(trueDownApp, /JSON\.stringify\(\{ action, ids \}\)/);
  assert.match(trueDownApp, /result\.remaining/);
  assert.match(trueDownApp, /sessionStorage/);
  assert.match(trueDownApp, /params\.set\("search", currentSearch\)/);
  assert.match(trueDownApp, /data-sort-field/);
  assert.match(trueDownApp, /aria-sort/);
	assert.match(trueDownApp, /requestJSON\("\/modules"/);
	assert.match(trueDownApp, /moduleOptions: sharedBody\.moduleOptions/);
  assert.match(trueDownApp, /els\.mDropboxMode\.value = downloadRules\.dropboxMode/);
  assert.match(trueDownHtml, /id="dialog-overlay"[^>]+aria-hidden="true"[^>]+inert/);
  assert.doesNotMatch(trueDownApp, /window\.(?:alert|confirm|prompt)\s*\(/);
  assert.match(trueDownApp, /current page connection remains valid|当前页面连接保持有效/);
  assert.doesNotMatch(trueDownApp, /setInterval\(/);
  assert.doesNotMatch(trueDownApp, /credentials:\s*["']include["']/);
});
