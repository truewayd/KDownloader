import assert from "node:assert/strict";

export async function assertToastPlacement(page, capturePrefix) {
  for (const [message, kind] of [["Settings saved", "success"], ["Download failed: ".repeat(32) + "x".repeat(140), "error"]]) {
    await page.evaluate(({ message, kind }) => showToast(message, kind), { message, kind });
    await page.waitForFunction(() => {
      const toast = document.querySelector("#toast");
      return toast.classList.contains("is-visible") && toast.getAnimations().every(animation => animation.playState === "finished");
    });
    const bounds = await page.locator("#toast").evaluate(element => {
      const { x, y, width, bottom, right } = element.getBoundingClientRect();
      return { x, y, width, bottom, right, viewportWidth: innerWidth, viewportHeight: innerHeight,
        titlebar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--native-titlebar-height")) || 0,
        textFits: element.scrollWidth <= element.clientWidth };
    });
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - bounds.viewportWidth / 2) < 1, JSON.stringify(bounds));
    assert.ok(bounds.x >= 16 && bounds.right <= bounds.viewportWidth - 16, JSON.stringify(bounds));
    assert.ok(Math.abs(bounds.y - bounds.titlebar - 16) < 1 && bounds.bottom <= bounds.viewportHeight - 24, JSON.stringify(bounds));
    assert.ok(bounds.textFits, "Long toast text must wrap within the visible surface");
    if (capturePrefix) await page.screenshot({ path: `${capturePrefix}-${kind}.png` });
  }
  await page.evaluate(() => document.querySelector("#toast").classList.remove("is-visible"));
}
