import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const run = promisify(execFile);

function workflowPaths(source) {
  const block = source.match(/paths:\s*\r?\n([\s\S]*?)\s+workflow_dispatch:/);
  assert.ok(block, "workflow must define push path filters");
  return [...block[1].matchAll(/-\s+"([^"]+)"/g)].map((match) => match[1]);
}

test("release workflows use dated, product-specific changelogs", async () => {
  const [kDownloader, trueDown, selectorSource, agents, changelogGuide, gitignore] =
    await Promise.all([
      read(".github/workflows/publish-extension.yml"),
      read(".github/workflows/publish-truedown.yml"),
      read("tools/read-latest-changelog.ps1"),
      read("AGENTS.md"),
      read("changelog/README.md"),
      read(".gitignore"),
    ]);

  for (const [product, directory] of [
    ["kdownloader", "changelog/kdownloader"],
    ["truedown", "changelog/truedown"],
  ]) {
    const datedFiles = (await readdir(path.join(root, directory)))
      .filter((name) => /^\d{4}-\d{2}-\d{2}-\d{3}-.+\.md$/.test(name))
      .sort()
      .reverse();
    assert.ok(datedFiles.length > 0, `${product} requires a dated release note`);
    const latest = await read(`${directory}/${datedFiles[0]}`);
    assert.match(latest, /^# .+/);
    assert.match(latest, /## Verification/);
  }

  assert.match(kDownloader, /-Product KDownloader -OutputFile release-notes\.md/);
  assert.match(trueDown, /-Product TrueDown -OutputFile release-notes\.md/);
  assert.match(kDownloader, /body_path:\s*release-notes\.md/);
  assert.match(trueDown, /body_path:\s*release-notes\.md/);
  assert.match(kDownloader, /generate_release_notes:\s*false/);
  assert.match(trueDown, /generate_release_notes:\s*false/);
  assert.match(selectorSource, /ValidateSet\("KDownloader", "TrueDown"\)/);
  assert.match(selectorSource, /Sort-Object Name -Descending/);
  assert.match(changelogGuide, /Changes affecting both products require one product-specific note in each directory/);
  assert.doesNotMatch(agents, /^- \d{4}-\d{2}-\d{2}:/m);
  assert.match(gitignore, /!changelog\/\*\.md/);
  assert.match(gitignore, /!changelog\/\*\/\*\.md/);
});

test("release-note selector cannot cross product boundaries", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "kdownloader-release-notes-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const kDownloaderDirectory = path.join(fixtureRoot, "kdownloader");
  const trueDownDirectory = path.join(fixtureRoot, "truedown");
  await Promise.all([mkdir(kDownloaderDirectory), mkdir(trueDownDirectory)]);
  await Promise.all([
    writeFile(path.join(kDownloaderDirectory, "2026-08-25-001-extension.md"), "older extension note\n"),
    writeFile(path.join(kDownloaderDirectory, "2026-08-26-001-extension.md"), "latest extension note\n"),
    writeFile(path.join(trueDownDirectory, "2026-08-27-001-truedown.md"), "newer TrueDown note\n"),
    writeFile(path.join(kDownloaderDirectory, "not-dated.md"), "invalid newest extension note\n"),
  ]);

  const selector = path.join(root, "tools", "read-latest-changelog.ps1");
  const extensionOutput = path.join(fixtureRoot, "extension-release-notes.md");
  const trueDownOutput = path.join(fixtureRoot, "truedown-release-notes.md");
  await run("pwsh", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", selector,
    "-Product", "KDownloader", "-ChangelogDirectory", fixtureRoot,
    "-OutputFile", extensionOutput,
  ]);
  await run("pwsh", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", selector,
    "-Product", "TrueDown", "-ChangelogDirectory", fixtureRoot,
    "-OutputFile", trueDownOutput,
  ]);

  assert.equal(await readFile(extensionOutput, "utf8"), "latest extension note\n");
  assert.equal(await readFile(trueDownOutput, "utf8"), "newer TrueDown note\n");

  await Promise.all([
    rm(path.join(kDownloaderDirectory, "2026-08-25-001-extension.md")),
    rm(path.join(kDownloaderDirectory, "2026-08-26-001-extension.md")),
  ]);
  await assert.rejects(
    run("pwsh", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", selector,
      "-Product", "KDownloader", "-ChangelogDirectory", fixtureRoot,
      "-OutputFile", extensionOutput,
    ]),
    /No dated KDownloader changelog file/,
  );
});

test("monorepo release workflows are independently path scoped", async () => {
  const [kDownloader, trueDown, trueDownBuild] = await Promise.all([
    read(".github/workflows/publish-extension.yml"),
    read(".github/workflows/publish-truedown.yml"),
    read("truedown/build.ps1"),
  ]);
  const kDownloaderPaths = workflowPaths(kDownloader);
  const trueDownPaths = workflowPaths(trueDown);

  assert.ok(kDownloaderPaths.includes("background/**"));
  assert.ok(kDownloaderPaths.includes("changelog/kdownloader/**"));
  assert.ok(!kDownloaderPaths.includes("changelog/**"));
  assert.ok(!kDownloaderPaths.some((entry) => entry.startsWith("changelog/truedown")));
  assert.ok(!kDownloaderPaths.includes("truedown/**"));
  assert.ok(trueDownPaths.includes("truedown/**"));
  assert.ok(trueDownPaths.includes("changelog/truedown/**"));
  assert.ok(!trueDownPaths.some((entry) => entry.startsWith("changelog/kdownloader")));
  assert.ok(trueDownPaths.includes("tools/read-latest-changelog.ps1"));
  assert.match(trueDown, /working-directory:\s*truedown/);
  assert.match(trueDown, /RELEASE_TAG:\s*truedown-build-/);
  assert.match(trueDown, /UPDATE_MANIFEST:\s*truedown-update-/);
  assert.match(trueDown, /Get-FileHash -Algorithm SHA256/);
  assert.match(trueDownBuild, /OutputDirectory must be inside/);
  assert.match(trueDownBuild, /Remove-Item -LiteralPath \$dist -Recurse -Force/);
  assert.match(trueDownBuild, /ARIA2_COPYING/);
});
