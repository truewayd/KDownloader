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
      <div id="editable" contenteditable>editable</div><div id="blank">workspace</div>
      <div id="caption" data-native-drag>caption</div><pre id="log">diagnostic text</pre>
      <dialog id="modal"><input id="modal-edit" value="modal draft"></dialog>
      <table><tbody><tr data-task-id="1"><td><button data-action="details">name</button>
      <button data-action="pause">pause</button><button data-action="remove">remove</button></td></tr></tbody></table>`);
    await page.addStyleTag({ content: styles });
    await page.evaluate(() => {
      window.calls = []; window.errors = []; window.clicked = [];
      window.nativeWindowRole = "main";
      window.__TAURI__ = { core: { invoke: async (command, args) => { calls.push({ command, args }); } } };
      window.invokeNative = window.__TAURI__.core.invoke;
      window.openModal = async () => calls.push({ command: "new-task" });
      window.showToast = message => errors.push(message);
      document.addEventListener("click", event => { if (event.target.dataset.action) clicked.push(event.target.dataset.action); });
      document.addEventListener("keydown", event => { if (event.key === "Escape") window.escaped = true; });
    });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const open = async (selector, x = 40, y = 50) => {
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
    assert.deepEqual(await open("#blank"), ["new-task", "settings"]);
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
} finally { await browser.close(); }
