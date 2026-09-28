import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const maximumBuild = 9999999999999;

export function nextBuildNumber(releases) {
  let maximum = 0;
  for (const release of releases) {
    if (typeof release?.tag_name !== "string") throw new Error("Invalid release metadata");
    if (!release.tag_name.startsWith("truedown-build-")) continue;
    const match = /^truedown-build-([1-9]\d{0,12})$/.exec(release.tag_name);
    if (!match || typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean") {
      throw new Error("Invalid TrueDown release identity");
    }
    // Public prereleases also own their tags. Only drafts can reuse a number.
    if (!release.draft) maximum = Math.max(maximum, Number(match[1]));
  }
  if (maximum >= maximumBuild) throw new Error("TrueDown build number exhausted");
  return maximum + 1;
}

export async function listReleases(request) {
  const releases = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await request(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 100) throw new Error("Invalid release list");
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error("Release history exceeds pagination limit");
}

export async function prepareDraft(request, build, commit) {
  if (!/^[1-9]\d{0,12}$/.test(String(build)) || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Invalid build or commit");
  }
  const releases = await listReleases(request);
  if (Number(build) !== nextBuildNumber(releases)) {
    throw new Error("Release number was already published or superseded; start a fresh workflow run");
  }
  const tag = `truedown-build-${build}`;
  // Existing tags are immutable, including tags created outside this workflow.
  let ref = await request(`/git/ref/tags/${tag}`, { allowMissing: true });
  let object = ref?.object;
  for (let depth = 0; object?.type === "tag" && depth < 4; depth++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new Error("Invalid tag object");
    object = (await request(`/git/tags/${object.sha}`)).object;
  }
  if (ref && (object?.type !== "commit" || object.sha !== commit)) {
    throw new Error("Existing release tag points to a different commit");
  }
  const drafts = releases.filter(release => release.tag_name === tag);
  for (const draft of drafts) {
    if (draft.draft !== true || !Number.isSafeInteger(draft.id) || draft.id <= 0) {
      throw new Error("Refusing to replace a public or invalid release");
    }
  }
  // Remove only this unpublished candidate, including partial/stale assets.
  for (const draft of drafts) await request(`/releases/${draft.id}`, { method: "DELETE" });
}

export function githubRequest(repository, token, fetcher = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") || !token) {
    throw new Error("A repository and GitHub token are required");
  }
  return async (path, { method = "GET", allowMissing = false } = {}) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "TrueDown/release-number" },
    });
    if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub release request failed: HTTP ${response.status}`); }
    if (response.status === 204) return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error("GitHub response exceeds size limit");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
}

async function main() {
  const request = githubRequest(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "resolve" && !args.length && process.env.GITHUB_OUTPUT) {
    const build = nextBuildNumber(await listReleases(request));
    await appendFile(process.env.GITHUB_OUTPUT, `build_number=${build}\n`);
    console.log(`Candidate TrueDown build ${build}; the number advances only when published`);
  } else if (mode === "prepare" && args.length === 2) {
    await prepareDraft(request, args[0], args[1]);
  } else throw new Error("Usage: release-number.mjs resolve | prepare BUILD COMMIT");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
