import assert from "node:assert/strict";
import test from "node:test";
import { MAX_INVENTORY_BYTES, MAX_LICENSE_BYTES, licenseInventory, readBoundedLicenseResponse } from "../truedown/tools/native-license-bounds.mjs";

test("license response preserves valid bytes across chunk boundaries", async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([0x61, 0xe6]));
    controller.enqueue(new Uint8Array([0xb5, 0x8b, 0x0a]));
    controller.close();
  } });
  const response = new Response(body);
  assert.deepEqual(await readBoundedLicenseResponse(response, 5), Buffer.from([0x61, 0xe6, 0xb5, 0x8b, 0x0a]));
  assert.equal(body.locked, false);
});

test("declared and streaming oversized license bodies cancel without draining", async () => {
  for (const declared of [true, false]) {
    let pulls = 0, canceled = false;
    const body = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(4)); },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: declared ? { "Content-Length": "1000" } : {} });
    await assert.rejects(readBoundedLicenseResponse(response, 7), /size limit/);
    assert.equal(canceled, true);
    assert.equal(pulls, declared ? 0 : 2);
    assert.equal(body.locked, false);
  }
});

test("license body read errors release their reader", async () => {
  const failure = new Error("connection ended");
  const body = new ReadableStream({ pull(controller) { controller.error(failure); } });
  await assert.rejects(readBoundedLicenseResponse(new Response(body)), error => error === failure);
  assert.equal(body.locked, false);
});

test("default license limit cancels an actual body exceeding one MiB", async () => {
  let pulls = 0, canceled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(pulls === 1 ? MAX_LICENSE_BYTES : 1));
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(readBoundedLicenseResponse(new Response(body)), /size limit/);
  assert.equal(pulls, 2);
  assert.equal(canceled, true);
  assert.equal(body.locked, false);
});

test("inventory enforces UTF-8 bytes and newlines before retaining an addition", () => {
  const inventory = licenseInventory(7);
  inventory.push("ab", "\u6d4b");
  assert.equal(inventory.text(), "ab\n\u6d4b\n");
  assert.throws(() => inventory.push("overflow", "more"), /package limit/);
  assert.equal(inventory.text(), "ab\n\u6d4b\n");
});

test("default inventory limit matches existing generated newline bytes", () => {
  const inventory = licenseInventory();
  const lines = ["Native licenses", "x".repeat(MAX_INVENTORY_BYTES - 17)];
  inventory.push(...lines);
  assert.equal(Buffer.byteLength(inventory.text()), MAX_INVENTORY_BYTES);
  assert.equal(inventory.text(), lines.join("\n") + "\n");
  assert.throws(() => inventory.push(""), /package limit/);
});
