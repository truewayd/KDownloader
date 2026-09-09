import assert from "node:assert/strict";

// Self-contained so Playwright and WebDriver evaluate the same observation.
export function readToastPlacement() {
  const element = document.querySelector("#toast");
  if (!element?.classList.contains("is-visible")) return null;
  // WebKit may report no animations until pending styles have been laid out.
  const { x, y, width, height, bottom, right } = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (width <= 0 || height <= 0 || Number(style.opacity) !== 1
    || Math.abs(y - parseFloat(style.top)) > 0.1
    || element.getAnimations().some(animation => animation.playState !== "finished")) return null;
  return { x, y, width, bottom, right, viewportWidth: innerWidth, viewportHeight: innerHeight,
    titlebar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--native-titlebar-height")) || 0,
    textFits: element.scrollWidth <= element.clientWidth };
}

export function assertToastBounds(bounds) {
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - bounds.viewportWidth / 2) < 1, JSON.stringify(bounds));
  assert.ok(bounds.x >= 16 && bounds.right <= bounds.viewportWidth - 16, JSON.stringify(bounds));
  assert.ok(Math.abs(bounds.y - bounds.titlebar - 16) < 1 && bounds.bottom <= bounds.viewportHeight - 24, JSON.stringify(bounds));
  assert.ok(bounds.textFits, "Long toast text must wrap within the visible surface");
}

export async function assertToastPlacement(page, capturePrefix) {
  for (const [message, kind] of [["Settings saved", "success"], ["Download failed: ".repeat(32) + "x".repeat(140), "error"]]) {
    await page.evaluate(({ message, kind }) => showToast(message, kind), { message, kind });
    const observation = await page.waitForFunction(readToastPlacement);
    try { assertToastBounds(await observation.jsonValue()); }
    finally { await observation.dispose(); }
    if (capturePrefix) await page.screenshot({ path: `${capturePrefix}-${kind}.png` });
  }
  await page.evaluate(() => document.querySelector("#toast").classList.remove("is-visible"));
}
