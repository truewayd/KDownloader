import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const script = await readFile(new URL("../../web/native-context-menu.js", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto("about:blank");
  await page.setContent(`<input id="edit" value="hello world"><input id="password" type="password" value="secret">
    <textarea id="readonly" readonly>read only</textarea><input id="disabled" disabled>
    <div id="editable" contenteditable>editable</div><div id="blank">workspace</div>
    <div id="caption" data-native-drag>caption</div>
    <table><tbody><tr data-task-id="1"><td><button data-action="details">name</button>
    <button data-action="pause">pause</button><button data-action="remove">remove</button></td></tr></tbody></table>`);
  await page.evaluate(() => {
    window.calls = []; window.errors = []; window.clicked = [];
    window.nativeWindowRole = "main";
    window.__TAURI__ = { core: { invoke: async (command, args) => { calls.push({ command, args }); } } };
    window.listenNativeEvent = async (_, callback) => { window.dispatchMenu = payload => callback({ payload }); };
    window.showToast = message => errors.push(message);
    if (!crypto.randomUUID) crypto.randomUUID = () => `test-${Math.random().toString(16).slice(2)}`;
    document.addEventListener("click", event => { if (event.target.dataset.action) clicked.push(event.target.dataset.action); });
  });
  await page.addScriptTag({ content: script });
  const open = async selector => {
    await page.locator(selector).dispatchEvent("contextmenu", { button: 2, clientX: 40, clientY: 50 });
    return page.evaluate(() => calls.at(-1)?.args?.request);
  };
  assert.equal((await open("#edit")).kind, "edit");
  await page.locator("#edit").evaluate(input => input.setSelectionRange(0, 5));
  assert.equal((await open("#edit")).kind, "edit-selection");
  await page.locator("#password").evaluate(input => input.setSelectionRange(0, 6));
  assert.equal((await open("#password")).kind, "password");
  assert.equal((await open("#readonly")).kind, "read-only");
  assert.equal((await open("#editable")).kind, "edit");
  assert.equal((await open("#blank")).kind, "workspace");
  let request = await open("tr");
  assert.equal(request.kind, "task");
  assert.deepEqual(request.actions, ["details", "pause", "remove"]);
  await page.evaluate(token => dispatchMenu({ token, action: "pause" }), request.token);
  assert.deepEqual(await page.evaluate(() => clicked), ["pause"]);
  // A late event cannot execute an action on the next context.
  const old = request;
  request = await open("tr");
  await page.evaluate(token => dispatchMenu({ token, action: "remove" }), old.token);
  assert.deepEqual(await page.evaluate(() => clicked), ["pause"]);
  // A polling update can disable a previously offered action.
  await page.locator('[data-action="pause"]').evaluate(button => { button.disabled = true; });
  await page.evaluate(token => dispatchMenu({ token, action: "pause" }), request.token);
  assert.deepEqual(await page.evaluate(() => clicked), ["pause"]);
  request = await open("tr");
  assert(!request.actions.includes("pause"));
  await page.evaluate(token => { location.hash = "settings/general"; dispatchMenu({ token, action: "remove" }); }, request.token);
  assert.deepEqual(await page.evaluate(() => clicked), ["pause"]);
  await page.locator('[data-action="details"]').focus();
  await page.keyboard.press("Shift+F10");
  assert.equal(await page.evaluate(() => calls.at(-1).args.request.kind), "task");
  const count = await page.evaluate(() => calls.length);
  await open("#caption"); await open("#disabled");
  assert.equal(await page.evaluate(() => calls.length), count);
  await page.evaluate(() => { nativeWindowRole = "settings"; });
  await open("#blank");
  assert.equal(await page.evaluate(() => calls.length), count);
  request = await open("#edit");
  assert.equal(request.kind, "edit-selection");
  assert.equal(await page.locator('[role="menu"]').count(), 0);
  assert.deepEqual(await page.evaluate(() => errors), []);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const afterDispose = await page.evaluate(() => calls.length);
  await open("#edit");
  assert.equal(await page.evaluate(() => calls.length), afterDispose);
  const plain = await browser.newPage();
  await plain.setContent('<input id="plain">');
  await plain.addScriptTag({ content: script });
  assert.equal(await plain.evaluate(() => document.querySelector("input").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), true);
  console.log("Context menus: input/password/readonly/contenteditable, task state, stale events, keyboard, roles and teardown passed");
} finally { await browser.close(); }
