import assert from "node:assert/strict";
import test from "node:test";
import { githubRequest, listReleases, nextBuildNumber, prepareDraft } from "../truedown/tools/release-number.mjs";

const commit = "a".repeat(40);
const release = (build, draft = false) => ({ id: build, tag_name: `truedown-build-${build}`, draft, prerelease: false });

test("failed runs and incomplete drafts do not consume release numbers", () => {
  const history = [release(78), release(76), release(79, true), release(500, true), { tag_name: "kdownloader-v1.5.0-build-900" }];
  assert.equal(nextBuildNumber(history), 79);
  assert.equal(nextBuildNumber(history), 79, "repeated failed attempts reuse the same candidate");
  assert.equal(nextBuildNumber([...history, release(79)]), 80);
  assert.equal(nextBuildNumber([]), 1);
  assert.equal(nextBuildNumber([{ ...release(80), prerelease: true }, release(78)]), 81, "public prereleases own immutable tags too");
  assert.throws(() => nextBuildNumber([release(9999999999999)]), /exhausted/);
  assert.throws(() => nextBuildNumber([{ ...release(78), draft: "false" }]), /identity/);
  assert.throws(() => nextBuildNumber([{ ...release(78), tag_name: "truedown-build-078" }]), /identity/);
});

test("number selection reads every history page and fails closed on API errors", async () => {
  const calls = [];
  const history = await listReleases(async path => {
    calls.push(path);
    return calls.length === 1 ? Array.from({ length: 100 }, (_, i) => release(i + 1)) : [release(300)];
  });
  assert.equal(nextBuildNumber(history), 301);
  assert.deepEqual(calls, ["/releases?per_page=100&page=1", "/releases?per_page=100&page=2"]);
  await assert.rejects(listReleases(async () => { throw new Error("offline"); }), /offline/);
  await assert.rejects(listReleases(async () => ({})), /release list/);
  await assert.rejects(listReleases(async () => Array(100).fill(release(1))), /pagination limit/);
});

test("retry replaces only the unpublished candidate and discards its partial assets", async () => {
  const mutations = [];
  await prepareDraft(async (path, options) => {
    if (path.startsWith("/releases?")) return [release(78), release(79, true), release(80, true)];
    if (path.startsWith("/git/ref/")) { assert.equal(options.allowMissing, true); return null; }
    mutations.push([path, options.method]);
  }, 79, commit);
  assert.deepEqual(mutations, [["/releases/79", "DELETE"]]);
});

test("stale job reruns cannot replace a release published by a newer run", async () => {
  let calls = 0;
  await assert.rejects(prepareDraft(async () => {
    calls++;
    return [release(78), release(79)];
  }, 79, commit), /already published or superseded/);
  assert.equal(calls, 1, "no mutation after a number conflict");
  await assert.rejects(prepareDraft(async () => [release(78)], 80, commit), /superseded/);
});

test("existing tags must resolve to the tested commit before draft cleanup", async () => {
  const check = async (object, annotated = false) => {
    let deleted = false;
    const pending = prepareDraft(async (path, options) => {
      if (path.startsWith("/releases?")) return [release(78), release(79, true)];
      if (path.startsWith("/git/ref/")) return { object: annotated ? { type: "tag", sha: "c".repeat(40) } : object };
      if (path.startsWith("/git/tags/")) return { object };
      if (options?.method === "DELETE") deleted = true;
    }, 79, commit);
    if (object.sha === commit) { await pending; assert.equal(deleted, true); }
    else { await assert.rejects(pending, /different commit/); assert.equal(deleted, false); }
  };
  await check({ type: "commit", sha: commit });
  await check({ type: "commit", sha: commit }, true);
  await check({ type: "commit", sha: "b".repeat(40) });
  await check({ type: "commit", sha: "b".repeat(40) }, true);
});

test("GitHub requests bound responses and never treat permission failures as empty history", async () => {
  const response = value => async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return value;
  };
  await assert.rejects(githubRequest("owner/repo", "test-token", response(new Response("denied", { status: 403 })))("/releases"), /HTTP 403/);
  assert.equal(await githubRequest("owner/repo", "test-token", response(new Response("missing", { status: 404 })))("/git/ref/tags/x", { allowMissing: true }), null);
  await assert.rejects(githubRequest("owner/repo", "test-token", response(new Response("x".repeat(4 * 1024 * 1024 + 1))))("/releases"), /size limit/);
  assert.deepEqual(await githubRequest("owner/repo", "test-token", response(new Response("[]")))("/releases"), []);
});
