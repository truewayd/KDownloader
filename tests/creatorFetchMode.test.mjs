import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const readSource = (file) => readFile(path.join(root, file), "utf8");

test("popup exposes Default, Full, and Links only Creator Fetch modes", async () => {
  const html = await readSource("popup/popup.html");
  const options = Array.from(html.matchAll(/<option\s+value="(default|full|links)"/g), (match) => match[1]);
  assert.deepEqual(options, ["default", "full", "links"]);
  assert.match(html, /id="creator-fetch-mode"/);
  assert.doesNotMatch(html, /creator-fetch-full-mode/);
});

test("popup allows Links only without a backend and sends creator.fetch.mode", async () => {
  const source = await readSource("popup/popup.js");
  assert.match(source, /if \(!backendReady && mode !== "links"\)/);
  assert.match(source, /action: "creator\.fetch"[\s\S]*?\bmode,/);
  assert.doesNotMatch(source, /fullMode:/);
});

test("background Links only path bypasses media dispatch and history writes", async () => {
  const source = await readSource("background/handlers/downloadHandlers.js");
  const match = source.match(/async function runLinksOnlyBatch[\s\S]*?\n}\n\nasync function runDownloadBatch/);
  assert.ok(match, "runLinksOnlyBatch should be defined before the normal download batch");
  assert.match(match[0], /dispatchExternalLinksTextTask/);
  assert.doesNotMatch(match[0], /runSingleDownload/);
  assert.doesNotMatch(match[0], /markDownloaded|markMultipleDownloaded/);
  assert.match(source, /scope\.mode === "links"/);
});
