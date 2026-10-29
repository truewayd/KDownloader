import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const root = new URL("../../web/", import.meta.url);
const script = await readFile(new URL("select.js", root), "utf8");
const css = await readFile(new URL("styles.css", root), "utf8") + await readFile(new URL("ui-baseline.css", root), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 360 }, colorScheme });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<form><label for="choice">Format</label><select class="kd-select" id="choice" name="format">
      <option value="a">Alpha</option><option disabled value="b">Beta</option><option hidden>Hidden</option>
      <optgroup disabled label="Unavailable"><option value="c">Charlie</option></optgroup>
      <option value="d">Delta</option><option value="e">Echo</option></select>
      <input id="next"><button type="reset">Reset</button></form>`);
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      window.changes = [];
      for (const type of ["input", "change"]) document.querySelector("#choice").addEventListener(type, event => changes.push([event.type, event.target.value]));
    });
    const select = page.locator("#choice"), list = page.locator(".kd-select-list");
    await select.click();
    assert.equal(await list.isVisible(), true);
    assert.equal(await list.getAttribute("aria-label"), "Format");
    assert.equal(await list.getByRole("option").count(), 5);
    await select.press("ArrowDown");
    await select.press("Enter");
    assert.equal(await select.inputValue(), "d", "keyboard skips disabled and hidden choices");
    assert.deepEqual(await page.evaluate(() => changes), [["input", "d"], ["change", "d"]]);
    assert.equal(await select.evaluate(node => new FormData(node.form).get("format")), "d");
    await select.press("ArrowDown");
    await select.press("End");
    await select.press("Escape");
    assert.equal(await select.inputValue(), "d", "Escape discards pending selection");
    assert.equal(await list.count(), 0);
    await select.click();
    await list.getByRole("option", { name: "Beta", exact: true }).click({ force: true });
    assert.equal(await select.inputValue(), "d");
    assert.equal(await list.count(), 1);
    await list.getByRole("option", { name: "Echo", exact: true }).click();
    assert.equal(await select.inputValue(), "e");
    assert.equal(await select.evaluate(node => document.activeElement === node), true);
    await select.click();
    await select.press("Tab");
    assert.equal(await page.locator("#next").evaluate(node => document.activeElement === node), true);
    assert.equal(await list.count(), 0);
    await select.click();
    await select.evaluate(node => { node.disabled = true; });
    await list.waitFor({ state: "detached" });
    await select.evaluate(node => { node.disabled = false; node.value = "a"; });
    await select.click();
    assert.equal(await list.getByRole("option", { selected: true }).textContent(), "Alpha");
    await page.mouse.click(385, 350);
    assert.equal(await list.count(), 0);
    await select.click();
    await page.setViewportSize({ width: 320, height: 240 });
    await list.waitFor({ state: "detached" });
    assert.equal(await list.count(), 0);
    await select.evaluate(node => { node.style.position = "fixed"; node.style.bottom = "8px"; node.style.right = "8px"; node.style.width = "110px"; });
    await select.click();
    const bounds = await list.boundingBox(), trigger = await select.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.y >= 0 && bounds.y + bounds.height <= trigger.y, "picker fits above a bottom-edge trigger");
    await select.press("Escape");
    await select.press("e");
    await select.press("Enter");
    assert.equal(await select.inputValue(), "e", "typeahead picks matching enabled option");
    await page.getByRole("button", { name: "Reset" }).click();
    assert.equal(await select.inputValue(), "a");
    await select.evaluate(node => { node.selectedIndex = -1; });
    await select.click();
    await select.press("Enter");
    assert.equal(await select.inputValue(), "a", "empty selection can be recovered");
    await select.press("F4");
    assert.equal(await list.count(), 1);
    await select.press("PageDown");
    await select.press("F4");
    assert.equal(await select.inputValue(), "e");
    assert.equal(await list.count(), 0);
    await page.evaluate(() => {
      const form = document.querySelector("form");
      const scroller = document.createElement("div");
      scroller.id = "picker-scroll";
      Object.assign(scroller.style, { height: "96px", overflow: "auto" });
      form.before(scroller);
      const space = document.createElement("div");
      space.style.height = "600px";
      scroller.append(form, space);
      document.querySelector("#choice").style.position = "static";
    });
    await select.focus();
    await select.press("Home");
    await page.locator("#picker-scroll").evaluate(node => node.dispatchEvent(new Event("scroll")));
    assert.equal(await list.isVisible(), true, "a queued focus scroll keeps a picker at the same anchor");
    await select.press("ArrowDown");
    await select.press("Enter");
    assert.equal(await select.inputValue(), "d", "late scroll events cannot discard keyboard selection");
    await select.press("Home");
    await page.locator("#picker-scroll").evaluate(node => { node.scrollTop += 24; });
    await list.waitFor({ state: "detached" });
    assert.equal(await select.inputValue(), "d", "actual anchor movement dismisses without committing");
    for (const mutation of ["hidden", "disabled", "removed"]) {
      await page.locator("#picker-scroll").evaluate(node => { node.scrollTop = 0; });
      await select.focus();
      await select.press("Home");
      await page.evaluate(kind => {
        const select = document.getElementById("choice");
        const fieldset = document.createElement("fieldset");
        select.before(fieldset);
        fieldset.append(select);
        window.pickerFieldset = fieldset;
        if (kind === "removed") fieldset.remove();
        else fieldset[kind] = true;
      }, mutation);
      await list.waitFor({ state: "detached", timeout: 1500 });
      const state = await page.evaluate(() => {
        const fieldset = window.pickerFieldset;
        const select = fieldset.querySelector("select");
        const value = select.value;
        const expanded = select.getAttribute("aria-expanded");
        document.querySelector("form").prepend(select);
        fieldset.remove();
        return { value, expanded };
      });
      assert.deepEqual(state, { value: "d", expanded: "false" }, `${mutation} anchors close without changing their value`);
    }
    assert.deepEqual(errors, []);
    console.log(`${colorScheme}: custom picker values, cancellation, focus, disabled states and viewport bounds OK`);
    await page.close();
  }
} finally { await browser.close(); }
