import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const script = await readFile(new URL("../../web/context-menu.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../../web/styles.css", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 400, height: 400 }, colorScheme, reducedMotion: "reduce" });
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.setContent(`<input id="edit" value="hello world"><input id="password" type="password" value="secret">
      <textarea id="readonly" readonly>read only</textarea><input id="disabled" disabled>
      <div id="editable" contenteditable>editable</div><div id="tasks-page"><div id="blank">workspace</div>
      <button id="pause-queue-btn">pause queue</button><button id="resume-queue-btn" disabled>resume queue</button>
      <button id="retry-all-btn" aria-disabled="true">retry all</button><button id="clear-done-btn" disabled>clear done</button>
      <button id="open-downloads-btn">downloads</button></div>
      <aside id="workspace-sidebar"><nav class="primary-nav"><div id="file-group-navigation">
      <a href="#tasks" data-task-category="image"><span id="group-label">Images</span></a></div><div id="group-blank">groups</div></nav></aside>
      <div id="unrelated">other surface</div>
      <div id="caption" data-native-drag>caption</div><pre id="log">diagnostic text</pre>
      <dialog id="modal"><input id="modal-edit" value="modal draft"></dialog>
      <table><tbody><tr data-task-id="1"><td><button data-action="details">name</button>
      <button data-action="pause">pause</button><button data-action="remove">remove</button></td></tr></tbody></table>`);
    await page.addStyleTag({ content: styles });
    await page.evaluate(() => {
      window.calls = []; window.errors = []; window.clicked = [];
      window.nativeWindowRole = "main";
      window.selectFileGroup = group => { window.selectedGroup = group.dataset.taskCategory; };
      window.invokeNative = async (command, args) => { calls.push({ command, args }); };
      document.execCommand = action => { calls.push({ command: "edit_action", args: { action: action === "selectAll" ? "select-all" : action } }); return true; };
      window.openModal = async () => calls.push({ command: "new-task" });
      window.showToast = message => errors.push(message);
      document.addEventListener("click", event => {
        if (event.target.dataset.action) clicked.push(event.target.dataset.action);
        if (event.target.id === "pause-queue-btn") calls.push({ command: "pause-queue" });
      });
      document.addEventListener("keydown", event => { if (event.key === "Escape") window.escaped = true; });
    });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const open = async (selector, x = 40, y = 50) => {
      await page.locator(selector).scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator(selector).evaluate((target, { x, y }) => target.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y,
      })), { x, y });
      return page.locator('[role="menuitem"]').evaluateAll(items => items.map(item => item.dataset.menuAction));
    };
    const choose = action => page.locator(`[data-menu-action="${action}"]`).click();
    assert.deepEqual(await open("#edit"), ["undo", "redo", "paste", "select-all"]);
    await choose("select-all");
    assert.deepEqual(await page.locator("#edit").evaluate(input => [input.selectionStart, input.selectionEnd]), [0, 11]);
    assert.deepEqual(await open("#edit"), ["undo", "redo", "cut", "copy", "paste", "select-all"]);
    await choose("copy");
    assert.equal(await page.evaluate(() => calls.at(-1).args.action), "copy");
    assert.deepEqual(await page.locator("#edit").evaluate(input => [document.activeElement === input, input.selectionStart, input.selectionEnd]), [true, 0, 11]);
    await page.locator("#password").evaluate(input => input.setSelectionRange(0, 6));
    assert.deepEqual(await open("#password"), ["undo", "redo", "paste", "select-all"]);
    assert.deepEqual(await open("#readonly"), ["copy", "select-all"]);
    assert.deepEqual(await open("#editable"), ["undo", "redo", "paste", "select-all"]);
    assert.deepEqual(await open("#blank"), ["new-task", "pause-queue", "open-downloads"]);
    await choose("pause-queue");
    assert.equal(await page.evaluate(() => calls.at(-1).command), "pause-queue");
    await open("#blank");
    await page.locator("#pause-queue-btn").evaluate(button => { button.disabled = true; });
    const queueCalls = await page.evaluate(() => calls.length);
    await choose("pause-queue");
    assert.equal(await page.evaluate(() => calls.length), queueCalls, "queue actions revalidate busy/disabled controls");
    assert.deepEqual(await open("#blank"), ["new-task", "open-downloads"]);
    assert.deepEqual(await open("#pause-queue-btn"), []);
    assert.deepEqual(await open("#unrelated"), []);
    assert.deepEqual(await open("#group-label"), ["group-edit", "group-add", "group-manage"]);
    assert.equal(await page.evaluate(() => selectedGroup), "image");
    await choose("group-edit");
    assert.deepEqual(await page.evaluate(() => calls.at(-1)), { command: "open_group_settings", args: { groupId: "image", add: false } });
    assert.deepEqual(await open("#group-blank"), ["new-task", "group-add", "group-manage"]);
    await choose("group-add");
    assert.deepEqual(await page.evaluate(() => calls.at(-1)), { command: "open_group_settings", args: { groupId: null, add: true } });
    await open("#group-label");
    await page.locator("[data-task-category]").evaluate(link => { link.dataset.taskCategory = "video"; });
    const groupCalls = await page.evaluate(() => calls.length);
    await choose("group-edit");
    assert.equal(await page.evaluate(() => calls.length), groupCalls, "changed group identity cannot redirect an old action");
    assert.deepEqual(await open("tr"), ["details", "pause", "remove"]);
    await choose("pause");
    assert.deepEqual(await page.evaluate(() => clicked), ["pause"]);
    await open("tr");
    await page.locator('[data-action="pause"]').evaluate(button => { button.disabled = true; });
    await choose("pause");
    assert.deepEqual(await page.evaluate(() => clicked), ["pause"]);
    assert.deepEqual(await open("tr"), ["details", "remove"]);
    await page.evaluate(() => { location.hash = "settings/general"; });
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
    await page.locator('[data-action="details"]').focus();
    await page.keyboard.press("Shift+F10");
    assert.equal(await page.locator('[role="menu"]').count(), 1);
    await page.keyboard.press("End");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.menuAction), "remove");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.menuAction), "details");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => Boolean(window.escaped)), false, "menu Escape must not close the parent window");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), "details");
    await open("#edit", 399, 399);
    const bounds = await page.getByRole("menu").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 400 && bounds.y + bounds.height <= 400);
    await page.locator("#blank").click();
    assert.equal(await page.getByRole("menu").count(), 0);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    for (const [selector, selectable] of [["#blank", false], ["#log", true]]) {
      const box = await page.locator(selector).boundingBox();
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      assert.equal(await page.evaluate(() => Boolean(window.getSelection().toString())), selectable);
    }
    assert.deepEqual(await open("#log"), ["copy", "select-all"]);
    await choose("copy");
    assert.equal(await page.evaluate(() => window.getSelection().toString()), "diagnostic text");
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.evaluate(() => { nativeWindowRole = "settings"; });
    assert.deepEqual(await open("#group-label"), []);
    assert.deepEqual(await open("#blank"), []);
    assert.deepEqual(await open("#disabled"), []);
    assert.deepEqual(await open("#caption"), []);
    await open("#edit");
    await page.locator("#edit").evaluate(input => { input.inert = true; });
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
    await page.locator("#edit").evaluate(input => { input.inert = false; });
    await page.evaluate(() => document.getElementById("modal").showModal());
    await open("#modal-edit");
    assert.equal(await page.locator("dialog [role=menu]").count(), 1);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog").evaluate(dialog => dialog.open), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog").evaluate(dialog => dialog.open), false);
    // Older WebViews use the same styled menu without the popover API.
    await page.evaluate(() => { HTMLElement.prototype.showPopover = undefined; });
    await open("#edit");
    assert.equal(await page.getByRole("menu").isVisible(), true);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    assert.deepEqual(await open("#edit"), []);
    assert.deepEqual(await page.evaluate(() => errors), []);
    assert.deepEqual(pageErrors, []);
    await page.close();
    console.log(`${colorScheme}: themed menus, selection, password protection, stale actions, modal scope, keyboard, viewport and teardown passed`);
  }
  const native = await browser.newPage();
  await native.setContent('<table><tr data-task-id="1"><td><button data-action="pause">Pause</button></td></tr></table><div id="file-group-navigation"><a data-task-category="image">Images</a></div><aside id="workspace-sidebar">Sidebar</aside>');
  await native.evaluate(() => {
    window.calls = []; window.errors = []; window.clicked = 0; window.nativeWindowRole = "main";
    window.selectFileGroup = group => { window.selectedGroup = group.dataset.taskCategory; };
    window.__TAURI__ = { core: { invoke() {} } };
    window.invokeNative = (command, args) => {
      calls.push({ command, args });
      if (["open_group_settings", "open_auxiliary"].includes(command)) return Promise.reject(new Error(`Failed: ${command}`));
      return command === "show_context_menu" ? new Promise(resolve => { window.answerMenu = resolve; }) : Promise.resolve();
    };
    window.showToast = message => errors.push(message);
    document.querySelector('button').onclick = () => clicked++;
  });
  await native.addScriptTag({ content: script });
  const openNative = () => native.locator('tr').dispatchEvent('contextmenu', { button: 2, clientX: 20, clientY: 20 });
  await openNative();
  assert.equal(await native.locator('[role="menu"]').count(), 0);
  assert.equal(await native.evaluate(() => calls.at(-1).args.keyboard), false);
  await native.keyboard.press("ArrowDown");
  assert.equal(await native.evaluate(() => calls.at(-1).command), "context_menu_key");
  await native.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await native.evaluate(() => calls.filter(call => call.command === 'context_menu_cancel').length), 0, 'native activation checks own mouse-menu cancellation');
  await native.evaluate(() => answerMenu('pause'));
  await native.waitForFunction(() => clicked === 1);
  await native.evaluate(() => { clicked = 0; });
  await native.locator('button').focus();
  await native.keyboard.press("Shift+F10");
  assert.equal(await native.evaluate(() => calls.at(-1).args.keyboard), true);
  await native.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await native.evaluate(() => calls.filter(call => call.command === 'context_menu_cancel').length), 1, 'keyboard menus may take focus for accessibility');
  await native.evaluate(() => { document.querySelector('button').disabled = true; answerMenu('pause'); });
  await native.waitForFunction(() => calls.filter(call => call.command === 'context_menu_cancel').length === 2);
  assert.equal(await native.evaluate(() => clicked), 0, 'late native actions revalidate the row');
  await native.evaluate(() => { document.querySelector('button').disabled = false; });
  await openNative();
  const request = await native.evaluate(() => calls.filter(call => call.command === 'show_context_menu').at(-1).args.requestId);
  await native.evaluate(() => window.dispatchEvent(new Event('hashchange')));
  assert.equal(await native.evaluate(() => calls.filter(call => call.command === 'context_menu_cancel').at(-1).args.requestId), request);
  await native.evaluate(() => answerMenu('pause'));
  assert.equal(await native.evaluate(() => clicked), 0);
  await openNative();
  const typingRequest = await native.evaluate(() => calls.filter(call => call.command === 'show_context_menu').at(-1).args.requestId);
  await native.keyboard.press("a");
  assert.equal(await native.evaluate(() => calls.filter(call => call.command === 'context_menu_cancel').at(-1).args.requestId), typingRequest, "typing dismisses a mouse menu before editing the caller");
  for (const [selector, action, command] of [
    ["[data-task-category]", "group-edit", "open_group_settings"],
    ["[data-task-category]", "group-add", "open_group_settings"],
    ["[data-task-category]", "group-manage", "open_group_settings"],
    ["#workspace-sidebar", "settings", "open_auxiliary"],
  ]) {
    const before = await native.evaluate(() => errors.length);
    await native.locator(selector).dispatchEvent("contextmenu", { button: 2, clientX: 20, clientY: 20 });
    await native.evaluate(() => window.dispatchEvent(new Event("blur")));
    await native.evaluate(action => answerMenu(action), action);
    await native.waitForFunction(before => errors.length === before + 1, before, { timeout: 2000 });
    assert.equal(await native.evaluate(() => errors.at(-1)), `Failed: ${command}`, "action errors remain visible after the menu closes");
  }
  await native.close();
  console.log('native bridge: separate window dispatch, caller blur, stale rows and request-scoped cancellation passed');
  const renderer = await browser.newPage();
  await renderer.setContent('<div id="menu" role="menu"></div>');
  await renderer.evaluate(() => {
    window.results = [];
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      if (command === "context_menu_init") return ["group-edit", "group-add", "group-manage", "pause-queue", "resume-queue", "retry-all", "clear-done", "open-downloads"];
      results.push({ command, args });
    } } };
  });
  await renderer.addScriptTag({ content: await readFile(new URL("../../web/context-menu-window.js", import.meta.url), "utf8") });
  await renderer.waitForFunction(() => window.__popupActive);
  assert.equal(await renderer.getByRole("menuitem").count(), 8);
  assert.equal(await renderer.locator('[data-action="clear-done"]').evaluate(button => button.classList.contains("danger")), true);
  await renderer.evaluate(() => { navigateContextMenu("End"); navigateContextMenu("Enter"); });
  assert.equal(await renderer.evaluate(() => results.at(-1).args.action), "open-downloads", "caller key relay activates the highlighted fixed action");
  await renderer.close();
} finally { await browser.close(); }
