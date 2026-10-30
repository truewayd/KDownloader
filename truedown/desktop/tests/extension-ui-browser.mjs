import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

if (!process.argv[2]) throw new Error("Pass an isolated run output directory");
const output = path.resolve(process.argv[2]);
const root = fileURLToPath(new URL("../../../", import.meta.url));
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(output, "profile"), {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const protocol = await context.newCDPSession(context.pages()[0]);
  for (const colorScheme of ["light", "dark"]) {
    if (colorScheme === "light") await worker.evaluate(() => chrome.action.openPopup());
    const { targetInfos } = await protocol.send("Target.getTargets");
    const target = targetInfos.find(item => item.url === `chrome-extension://${extensionId}/popup/popup.html`);
    assert.ok(target, `Action popup target missing: ${JSON.stringify(targetInfos)}`);
    const { sessionId } = await protocol.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    let sequence = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const finish = (error, value) => { clearTimeout(timer); protocol.off("Target.receivedMessageFromTarget", receive); error ? reject(error) : resolve(value); };
      const receive = event => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id === id) finish(message.error ? new Error(message.error.message) : null, message.result);
      };
      const timer = setTimeout(() => finish(new Error(`Popup protocol timeout: ${method}`)), 5000);
      protocol.on("Target.receivedMessageFromTarget", receive);
      protocol.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(finish);
    });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: colorScheme }, { name: "prefers-reduced-motion", value: "reduce" }] });
    const result = await send("Runtime.evaluate", { expression: `new Promise(resolve => {
      const deadline = Date.now() + 3000;
      const check = () => {
        if (!document.getElementById('storage-used')?.textContent.includes('KB') && Date.now() < deadline) { setTimeout(check, 20); return; }
        resolve({width: document.body.getBoundingClientRect().width, viewport: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth});
      }; check();
    })`, awaitPromise: true, returnByValue: true });
    const geometry = result.result.value;
    assert.equal(geometry.width, 360);
    assert.equal(geometry.viewport, 360, "the real action popup owns its native 360px viewport");
    assert.equal(geometry.overflow, false);
    assert.ok(geometry.height <= 600);
    const ordering = await send("Runtime.evaluate", { expression: `(${async function () {
      const original = KDUI, requests = [];
      await Promise.all([loadBackendState(), loadFeatureVisibility(), loadStats()]);
      globalThis.KDUI = { ...original, sendMessage: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) };
      try {
        const start = () => Promise.all([loadBackendState(), loadFeatureVisibility(), loadStats()]);
        const first = start(), second = start();
        if (requests.length !== 8) throw new Error("Popup fixture did not intercept all reads");
        requests.slice(4).forEach(({ resolve }) => resolve({ enabled: true, config: { enabled: true }, stats: { bytes: 2048, records: 42 } }));
        await second;
        requests.slice(0, 4).forEach(({ reject }) => reject(new Error("stale fixture response")));
        await first;
        return { ready: backendReady, cache: !searchCachePanel.classList.contains("kd-hidden"), gist: !gistPanel.classList.contains("kd-hidden"), stats: storageUsed.textContent };
      } finally {
        globalThis.KDUI = original;
        await Promise.all([loadBackendState(), loadFeatureVisibility(), loadStats()]);
      }
    }} )()`, awaitPromise: true, returnByValue: true });
    assert.equal(ordering.exceptionDetails, undefined);
    assert.deepEqual(ordering.result.value, { ready: true, cache: true, gist: true, stats: "2.00 KB · 42" });
    const screenshot = await send("Page.captureScreenshot");
    await writeFile(path.join(output, `popup-${colorScheme}.png`), Buffer.from(screenshot.data, "base64"));
    if (colorScheme === "dark") await send("Runtime.evaluate", { expression: "window.close()" });
    else await protocol.send("Target.detachFromTarget", { sessionId });
    console.log(`${colorScheme}: real action popup read ordering, 360px width and overflow OK`);
  }

  const fixtures = [
    { name: "kemono", url: "https://kemono.cr/patreon/user/123", kind: "creator" },
    { name: "coomer", url: "https://coomer.st/onlyfans/user/123", kind: "creator" },
    { name: "pawchive", url: "https://pawchive.pw/patreon/user/123", kind: "creator" },
    { name: "coomerfans", url: "https://coomerfans.com/u/onlyfans/123", kind: "coomerfans" },
    { name: "favorites", url: "https://kemono.cr/patreon/account/favorites/artists", kind: "flag" },
  ];
  for (const fixture of fixtures) {
    const cards = fixture.kind === "flag"
      ? '<a class="fancy-link fancy-link--kemono user-card" data-service="patreon" data-id="123" href="/patreon/user/123">Creator</a>'
      : fixture.kind === "coomerfans"
        ? '<section class="model-posts"><h2>Posts</h2><div class="posts-list"><div class="post"><h3><a href="/p/456/123/onlyfans">Post</a></h3></div></div></section>'
        : `<div class="user-header__actions"></div><article class="post-card"><a class="fancy-link image-link" href="${new URL(fixture.url).pathname}/post/456">Post</a></article>`;
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(`${new URL(fixture.url).origin}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>body{font-family:system-ui;padding:24px}.post-card,.post,.user-card{display:block;width:280px;height:160px;background:#eee;margin:16px}button{cursor:auto!important}</style></head><body><main>${cards}</main></body></html>` }));
    await page.goto(fixture.url);
    const variant = fixture.kind === "flag" ? "flag" : "creator";
    const actions = page.locator(`kd-ui-action[variant="${variant}"]`);
    await actions.first().waitFor({ state: "visible" });
    assert.equal(await actions.count(), 1);
    const control = actions.first().locator("button");
    assert.equal(await control.evaluate(node => getComputedStyle(node).cursor), "pointer");
    assert.ok(await control.getAttribute("aria-label"));
    await control.focus();
    assert.equal(await control.evaluate(node => node.getRootNode().activeElement === node), true);

    // Replace targets at the same URL and deliver the site's HTMX lifecycle.
    for (let round = 0; round < 3; round++) {
      await page.evaluate(markup => {
        document.querySelector("main").innerHTML = markup;
        document.dispatchEvent(new Event("htmx:afterSwap"));
      }, cards);
      await actions.first().waitFor({ state: "visible" });
      assert.equal(await actions.count(), 1, "reinjection must stay idempotent");
    }
    await page.evaluate(() => {
      history.pushState({}, "", "?audit=1");
      document.querySelectorAll("kd-ui-action").forEach(node => node.remove());
      history.back();
    });
    await actions.first().waitFor({ state: "visible" });
    assert.equal(await actions.count(), 1, "history navigation restores controls once");
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      document.querySelectorAll("kd-ui-action").forEach(node => node.remove());
      document.dispatchEvent(new Event("htmx:afterSwap"));
    });
    await page.waitForTimeout(350);
    assert.equal(await actions.count(), 0, "a suspended page must not recreate controls");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await actions.first().waitFor({ state: "visible" });
    assert.equal(await actions.count(), 1);
    await page.screenshot({ path: path.join(output, `${fixture.name}.png`) });
    assert.deepEqual(errors, []);
    console.log(`${fixture.name}: isolated-world styling, focus, history/HTMX reinjection and page lifecycle passed`);
    await page.close();
  }
} finally { await context.close(); }
