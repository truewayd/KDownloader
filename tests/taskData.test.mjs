import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../truedown/web/task-data.js", import.meta.url), "utf8");
function store(fetchPage) {
  return vm.runInNewContext(`${source}; new TaskPageStore(fetchPage)`, { fetchPage });
}
function response(id, revision = 1, orderVersion = "order-1", extra = {}) {
  return new Response(JSON.stringify({ tasks: [{ id, revision }], revision, orderVersion, rowsVersion: `rows-${id}-${revision}`, epoch: "core-1", summary: { total: 1000 }, total: 1000, ...extra }), { headers: { ETag: `"page-${id}-${revision}"` } });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("a new viewport bypasses a slow read, with bounded foreground and prefetch slots", async () => {
  const reads = [];
  const pages = store((url) => new Promise(resolve => reads.push({ url, resolve })));
  const first = pages.request("/tasks?offset=0");
  const prefetch = pages.request("/tasks?offset=40", { prefetch: true });
  const latest = pages.request("/tasks?offset=600");
  assert.equal(reads.length, 3);
  assert.equal(await pages.request("/tasks?offset=80", { prefetch: true }), null);
  const skipped = pages.request("/tasks?offset=1000");
  const final = pages.request("/tasks?offset=2000");
  assert.equal(await skipped, null);
  assert.equal(reads.length, 3, "scroll events cannot grow active native requests");
  reads[2].resolve(response(600));
  await latest;
  assert.equal(reads[3].url, "/tasks?offset=2000");
  reads[3].resolve(response(2000));
  reads[0].resolve(response(0));
  reads[1].resolve(response(40));
  await Promise.all([first, prefetch, final]);
  assert.equal(pages.running.size, 0);
});

test("cached pages retain matching bodies for 304 and overview-only responses", async () => {
  const requests = [];
  let reply = response(7);
  const pages = store(async (url, options) => { requests.push({ url, options }); return reply; });
  await pages.request("/tasks?offset=0");
  reply = new Response(null, { status: 304 });
  const reused = await pages.request("/tasks?offset=0");
  assert.equal(reused.page.tasks[0].id, 7);
  assert.equal(requests[1].options.headers["If-None-Match"], '"page-7-1"');
  assert.match(requests[1].url, /rowsVersion=rows-7-1/);
  reply = response(7, 2, "order-1", { tasks: null, rowsVersion: "rows-7-1", rowsUnchanged: true });
  const overview = await pages.request("/tasks?offset=0");
  assert.equal(overview.page.tasks, reused.page.tasks);
  assert.equal(overview.page.revision, 2);
  reply = response(7, 3, "order-1", { tasks: null, rowsVersion: "mismatch", rowsUnchanged: true });
  await assert.rejects(pages.request("/tasks?offset=0"), /Invalid task page/);
});

test("mutation invalidation cannot repopulate pages from an older pending read", async () => {
  let resolve;
  const pages = store(() => new Promise(done => { resolve = done; }));
  const old = pages.request("/tasks?offset=0");
  pages.invalidate();
  resolve(response(1));
  assert.equal(await old, null);
  assert.equal(pages.peek("/tasks?offset=0"), null);
});

test("structural changes discard incompatible cached ranges and late replies", async () => {
  const reads = [];
  const pages = store(url => new Promise(resolve => reads.push({ url, resolve })));
  const old = pages.request("/tasks?offset=0");
  const fresh = pages.request("/tasks?offset=40");
  reads[1].resolve(response(40, 3, "order-2"));
  await fresh;
  reads[0].resolve(response(1, 2, "order-1"));
  assert.equal(await old, null);
  assert.equal(pages.cache.size, 1);
  assert.equal(pages.overview.revision, 3);
});

test("core restart replaces revisions and validators from the previous process", async () => {
  let reply = response(1, 100);
  const pages = store(async () => reply);
  await pages.request("/tasks?offset=0");
  reply = response(2, 1, "new-order", { epoch: "core-2" });
  const fresh = await pages.request("/tasks?offset=40");
  assert.equal(fresh.page.tasks[0].id, 2);
  assert.equal(pages.revision, 1);
  assert.equal(pages.peek("/tasks?offset=0"), null);
});

test("page cache evicts bodies and validators together and bounds retained text", async () => {
  const requests = [];
  const pages = store(async (url, options) => { requests.push(options); return response(1); });
  for (let offset = 0; offset < 10; offset++) await pages.request(`/tasks?offset=${offset}`);
  assert.equal(pages.cache.size, 8);
  assert.equal(pages.peek("/tasks?offset=0"), null);
  await pages.request("/tasks?offset=0");
  assert.equal(requests.at(-1).headers["If-None-Match"], undefined);
  const huge = store(async () => response(1, 1, "order", { tasks: [{ id: 1, name: "x".repeat(1_048_576) }] }));
  await huge.request("/tasks?offset=0");
  assert.equal(huge.cache.size, 0);
});

test("failed obsolete reads release slots and do not stall the latest queued viewport", async () => {
  const reads = [];
  const pages = store(url => new Promise((resolve, reject) => reads.push({ url, resolve, reject })));
  const one = pages.request("/tasks?offset=0").catch(error => error.message);
  const two = pages.request("/tasks?offset=40");
  const latest = pages.request("/tasks?offset=800");
  reads[0].reject(new Error("timeout"));
  assert.equal(await one, "timeout");
  await tick();
  assert.equal(reads[2].url, "/tasks?offset=800");
  reads[1].resolve(response(40));
  reads[2].resolve(response(800));
  await Promise.all([two, latest]);
});
