import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = { runtime: { id: "test-extension" } };

const helpers = await import("../background/messageHelpers.js");

test("message sender URL prefers the sending document over a stale tab URL", () => {
  const sender = {
    url: "https://pawchive.pw/patreon/user/creator",
    tab: { id: 4, url: "https://kemono.cr/stale" },
  };
  assert.equal(helpers.getSenderUrl(sender), sender.url);
  assert.doesNotThrow(() => helpers.requireTrustedWebSender(
    sender,
    ["pawchive.pw"],
    "Watch state"
  ));
  assert.throws(
    () => helpers.requireTrustedWebSender(sender, ["kemono.cr"], "Watch state"),
    /supported site pages/
  );
});

test("extension pages remain authorized when hosted in a browser tab", () => {
  const sender = {
    url: "chrome-extension://test-extension/settings.html",
    tab: { id: 9, url: "chrome-extension://test-extension/settings.html" },
  };
  assert.equal(helpers.isExtensionPageSender(sender), true);
  assert.doesNotThrow(() => helpers.requireExtensionPage(sender, "Settings"));
  assert.equal(helpers.isExtensionPageSender({ url: "https://kemono.cr/post", tab: { id: 9 } }), false);
});

test("accepted request ids are idempotent per sender and action", () => {
  const requestId = `request:${crypto.randomUUID()}`;
  const sender = { url: "https://kemono.cr/post", tab: { id: 11 } };
  const first = helpers.beginAcceptedRequest("startDownload", requestId, sender);
  assert.equal(first.duplicate, false);
  assert.equal(helpers.beginAcceptedRequest("startDownload", requestId, sender).duplicate, true);
  assert.equal(helpers.beginAcceptedRequest(
    "startDownload",
    requestId,
    { url: sender.url, tab: { id: 12 } }
  ).duplicate, false);
  helpers.completeAcceptedRequest(first.token);
  assert.equal(helpers.beginAcceptedRequest("startDownload", requestId, sender).duplicate, true);
});

test("respondWith maps mapper failures into one error response", async () => {
  const response = await new Promise((resolve) => {
    helpers.respondWith(resolve, Promise.resolve(1), () => {
      throw new Error("mapper failed");
    });
  });
  assert.deepEqual(response, { success: false, error: "mapper failed" });
});

test("completed request ids are evicted before the registry rejects new work", () => {
  const sender = { url: "https://kemono.cr/post", tab: { id: 42 } };
  for (let index = 0; index < 5000; index++) {
    const registration = helpers.beginAcceptedRequest(
      "registry-capacity",
      `completed-${index}`,
      sender
    );
    assert.equal(registration.duplicate, false);
    helpers.completeAcceptedRequest(registration.token);
  }
});
