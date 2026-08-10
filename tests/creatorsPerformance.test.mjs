import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, test } from "node:test";

const storage = {};
const getCalls = [];
const setCalls = [];
const creatorsChrome = {
  storage: {
    local: {
      async get(keys) {
        getCalls.push(keys);
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in storage).map((key) => [key, storage[key]]));
      },
      async set(values) {
        setCalls.push(values);
        Object.assign(storage, values);
      },
    },
  },
};
const creatorsFetch = async (url) => ({
  async text() {
    return JSON.stringify([{ id: url }]);
  },
});

const constantsSource = await readFile(new URL("../background/constants.js", import.meta.url), "utf8");
const constantsUrl = `data:text/javascript;base64,${Buffer.from(constantsSource).toString("base64")}`;
const networkUrl = `data:text/javascript;base64,${Buffer.from(`
  export async function readLimitedResponseText(response) { return response.text(); }
`).toString("base64")}`;
const creatorsSource = (await readFile(new URL("../background/creators.js", import.meta.url), "utf8"))
  .replace(/from ['"]\.\/constants\.js['"]/, `from '${constantsUrl}'`)
  .replace(/from ['"]\.\/network\.js['"]/, `from '${networkUrl}'`);
const creators = await import(`data:text/javascript;base64,${Buffer.from(creatorsSource).toString("base64")}`);

beforeEach(() => {
  globalThis.chrome = creatorsChrome;
  globalThis.fetch = creatorsFetch;
  getCalls.length = 0;
  setCalls.length = 0;
  for (const key of Object.keys(storage)) delete storage[key];
});

test("creator cache update stores payload and metadata in one write", async () => {
  await creators.updateCacheFromNetwork("kemono.cr");
  assert.equal(setCalls.length, 1);
  assert.ok(setCalls[0]["creatorsOverride_kemono.cr"]);
  assert.ok(setCalls[0]["creatorsOverride_kemono.cr_meta"]);
});

test("reading all creator caches uses one batched storage request", async () => {
  storage["creatorsOverride_kemono.cr"] = { __text: "cached" };
  const cached = await creators.getCachedCreators();
  assert.equal(getCalls.length, 1);
  assert.deepEqual(getCalls[0], ["creatorsOverride_coomer.st", "creatorsOverride_kemono.cr"]);
  assert.ok(cached["kemono.cr"]);
});
