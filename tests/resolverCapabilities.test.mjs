import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("legacy resolver metadata retains update controls while fixed modules opt out", async () => {
  const source = await readFile(new URL("../truedown/web/settings.js", import.meta.url), "utf8");
  const context = vm.createContext({ stringValue: value => typeof value === "string" ? value : "" });
  vm.runInContext(source.slice(source.indexOf("function normalizeResolverModule("), source.indexOf("async function loadResolverModules(")), context);
  assert.equal(context.normalizeResolverModule({ id: "dropbox", name: "Dropbox" }).hotReload, true);
  assert.equal(context.normalizeResolverModule({ id: "google-drive", name: "Drive", hotReload: true }).hotReload, true);
  assert.equal(context.normalizeResolverModule({ id: "telegraph", name: "Telegraph", hotReload: false }).hotReload, false);
});
