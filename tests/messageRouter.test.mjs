import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const asModuleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const emptyFactory = (name) => asModuleUrl(`export function ${name}() { return {}; }`);
const configUrl = asModuleUrl(`
  export function createConfigHandlers() {
    return {
      safe: ({ sendResponse }) => {
        sendResponse({ success: true });
        return true;
      },
    };
  }
`);

let listener;
globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(value) {
        listener = value;
      },
    },
  },
};

const source = (await readFile(path.join(root, "background", "messages.js"), "utf8"))
  .replace(/from\s+["']\.\/handlers\/configHandlers\.js["']/, `from "${configUrl}"`)
  .replace(/from\s+["']\.\/handlers\/dbHandlers\.js["']/, `from "${emptyFactory("createDbHandlers")}"`)
  .replace(/from\s+["']\.\/handlers\/downloadHandlers\.js["']/, `from "${emptyFactory("createDownloadHandlers")}"`)
  .replace(/from\s+["']\.\/handlers\/creatorsHandlers\.js["']/, `from "${emptyFactory("createCreatorsHandlers")}"`)
  .replace(/from\s+["']\.\/handlers\/watchHandlers\.js["']/, `from "${emptyFactory("createWatchHandlers")}"`);
const router = await import(asModuleUrl(source));

test("message router accepts only explicit function handlers", () => {
  router.registerMessageHandlers();
  let response;
  assert.equal(listener({ action: "safe" }, {}, (value) => { response = value; }), true);
  assert.deepEqual(response, { success: true });

  for (const action of ["__proto__", "constructor", "toString", 42, null]) {
    response = undefined;
    assert.equal(listener({ action }, {}, (value) => { response = value; }), false);
    assert.equal(response, undefined);
  }
});
