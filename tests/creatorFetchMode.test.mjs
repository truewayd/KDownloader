import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const readSource = (file) => readFile(path.join(root, file), "utf8");

test("popup exposes Default, Full, Links only, and Pawchive DMs Creator Fetch modes", async () => {
  const html = await readSource("popup/popup.html");
  const options = Array.from(html.matchAll(/<option\s+value="(default|full|links|dms)"/g), (match) => match[1]);
  assert.deepEqual(options, ["default", "full", "links", "dms"]);
  assert.match(html, /id="creator-fetch-mode"/);
  assert.doesNotMatch(html, /creator-fetch-full-mode/);
});

test("popup allows Links only without a backend and sends creator.fetch.mode", async () => {
  const source = await readSource("popup/popup.js");
  assert.match(source, /mode !== "links" && mode !== "dms"/);
  assert.match(source, /PAWCHIVE_DMS_PLACEHOLDER/);
  assert.match(source, /action: "creator\.fetch"[\s\S]*?\bmode,/);
  assert.doesNotMatch(source, /fullMode:/);
});

test("background Pawchive DMs path exports text without media dispatch or history writes", async () => {
  const source = await readSource("background/handlers/downloadHandlers.js");
  const match = source.match(/async function runPawchiveDmsFetch[\s\S]*?\n}\n\nfunction linksFileName/);
  assert.ok(match, "runPawchiveDmsFetch should be defined before linksFileName");
  assert.match(match[0], /fetchPawchiveDms/);
  assert.match(match[0], /formatPawchiveDmsText/);
  assert.match(match[0], /dispatchTextDownloadTask/);
  assert.doesNotMatch(match[0], /runSingleDownload|markDownloaded|markMultipleDownloaded/);
  assert.match(source, /if \(mode === "dms"\)/);
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
