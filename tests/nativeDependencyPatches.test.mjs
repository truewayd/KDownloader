import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativePatches } from "../truedown/tools/verify-native-patches.mjs";

const desktop = fileURLToPath(new URL("../truedown/desktop/", import.meta.url));

test("native dependency patches match the reviewed full source trees", async () => {
  const patches = await verifyNativePatches();
  assert.equal(patches.size, 4);
  const lock = await fs.readFile(path.join(desktop, "Cargo.lock"), "utf8");
  for (const name of ["proc-macro-error", "proc-macro-error-attr", "proc-macro-error2", "proc-macro-error-attr2", "unic-char-range", "unic-char-property", "unic-common", "unic-ucd-ident", "unic-ucd-version"]) {
    assert.ok(!lock.includes(`name = "${name}"`), `${name} must stay removed`);
  }
  for (const patch of patches.values()) {
    const entry = lock.split("[[package]]").find(value => value.includes(`name = "${patch.name}"\n`));
    assert.ok(entry?.includes(`version = "${patch.version}"`));
    assert.ok(!entry.includes("source ="), `${patch.name} must resolve to its local patch`);
  }
});

test("native patch validation rejects reverted, missing and unreviewed source", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-patches-"));
  try {
    const root = path.join(temporary, "vendor");
    await fs.cp(path.join(desktop, "vendor"), root, { recursive: true });
    const variant = path.join(root, "glib-0.18.5/src/variant_iter.rs");
    const original = await fs.readFile(variant, "utf8");
    await fs.writeFile(variant, original.replace("&mut p,", "&p,"));
    await assert.rejects(verifyNativePatches(root), /Native patch source changed/);
    await fs.writeFile(variant, original);
    const extra = path.join(root, "urlpattern-0.3.0/src/unreviewed.rs");
    await fs.writeFile(extra, "// unreviewed\n");
    await assert.rejects(verifyNativePatches(root), /Native patch source changed/);
    await fs.unlink(extra);
    await fs.unlink(variant);
    await assert.rejects(verifyNativePatches(root), /Native patch files missing/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
