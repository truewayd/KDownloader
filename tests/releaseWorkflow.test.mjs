import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const run = promisify(execFile);

async function unlinkIfPresent(linkPath) {
  try {
    await unlink(linkPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function assertBuildRejectsBeforeCompilation(command, args) {
  try {
    await run(command, args);
    assert.fail("unsafe build path should be rejected");
  } catch (error) {
    assert.match(
      String(error?.stderr || error?.message || error),
      /reparse point|symbolic link|junction/i,
    );
    assert.doesNotMatch(String(error?.stdout || ""), /Building\.\.\./);
  }
}

function workflowPaths(source) {
  const block = source.match(/paths:\s*\r?\n([\s\S]*?)\s+workflow_dispatch:/);
  assert.ok(block, "workflow must define push path filters");
  return [...block[1].matchAll(/-\s+"([^"]+)"/g)].map((match) => match[1]);
}

function actionReferences(source) {
  return [...source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(.+))?$/gm)].map((match) => ({
    reference: match[1],
    version: match[2],
  }));
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

test("KDownloader releases use one product version plus a monotonic build component", async () => {
  const [manifestSource, workflow, buildSource, versionReader, agents] = await Promise.all([
    read("manifest.json"),
    read(".github/workflows/publish-extension.yml"),
    read("tools/build-extension.ps1"),
    read("tools/read-extension-version.ps1"),
    read("AGENTS.md"),
  ]);
  const manifest = JSON.parse(manifestSource);

  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.notEqual(manifest.version, "1.0.0");
  const { stdout } = await run("pwsh", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(root, "tools", "read-extension-version.ps1"),
  ]);
  assert.equal(stdout.trim(), manifest.version);

  assert.match(versionReader, /MAJOR\.MINOR\.PATCH/);
  assert.match(versionReader, /components must not exceed 65535/);
  assert.match(buildSource, /\[Nullable\[int\]\]\$BuildNumber/);
  assert.match(buildSource, /\$stagedManifest\.version = "\$baseVersion\.\$BuildNumber"/);
  assert.match(buildSource, /version_name/);
  assert.match(workflow, /\.\/tools\/read-extension-version\.ps1/);
  assert.match(workflow, /-BuildNumber \$env:BUILD_NUMBER/);
  assert.match(workflow, /KDownloader-v\$version-build-\$env:BUILD_NUMBER\.zip/);
  assert.match(workflow, /kdownloader-v\$version-build-\$env:BUILD_NUMBER/);
  assert.match(agents, /History source identities must never fork beyond exactly two namespaces/);
  assert.match(agents, /manifest\.json` is the single source for KDownloader's three-component/);
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

test("release-note selector refuses a reparse-point product directory", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "kdownloader-release-link-"));
  const outside = await mkdtemp(path.join(tmpdir(), "kdownloader-release-outside-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "2026-08-30-001-secret.md"), "must not be copied\n");
  await symlink(outside, path.join(fixtureRoot, "kdownloader"), "junction");

  const selector = path.join(root, "tools", "read-latest-changelog.ps1");
  await assert.rejects(
    run("pwsh", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", selector,
      "-Product", "KDownloader", "-ChangelogDirectory", fixtureRoot,
      "-OutputFile", path.join(fixtureRoot, "release-notes.md"),
    ]),
    /symbolic link or junction/i,
  );
});

test("release-note selector refuses a reparse point in an input ancestor", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "kdownloader-release-ancestor-"));
  const outside = await mkdtemp(path.join(tmpdir(), "kdownloader-release-ancestor-outside-"));
  const holder = path.join(fixtureRoot, "holder");
  const link = path.join(holder, "linked-root");
  await mkdir(path.join(outside, "changelog", "kdownloader"), { recursive: true });
  await mkdir(holder);
  await writeFile(
    path.join(outside, "changelog", "kdownloader", "2026-08-30-001-secret.md"),
    "must not cross an ancestor junction\n",
  );
  await symlink(outside, link, "junction");
  t.after(async () => {
    await unlinkIfPresent(link);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const selector = path.join(root, "tools", "read-latest-changelog.ps1");
  await assert.rejects(
    run("pwsh", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", selector,
      "-Product", "KDownloader",
      "-ChangelogDirectory", path.join(link, "changelog"),
      "-OutputFile", path.join(fixtureRoot, "release-notes.md"),
    ]),
    /symbolic link or junction/i,
  );
});

test("monorepo release workflows are independently path scoped", async () => {
  const [kDownloader, trueDown, trueDownBuild, extensionBuild] = await Promise.all([
    read(".github/workflows/publish-extension.yml"),
    read(".github/workflows/publish-truedown.yml"),
    read("truedown/build.ps1"),
    read("tools/build-extension.ps1"),
  ]);
  const kDownloaderPaths = workflowPaths(kDownloader);
  const trueDownPaths = workflowPaths(trueDown);

  assert.ok(kDownloaderPaths.includes("background/**"));
  assert.ok(kDownloaderPaths.includes("changelog/kdownloader/**"));
  assert.ok(kDownloaderPaths.includes("tools/read-extension-version.ps1"));
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
  assert.match(trueDownBuild, /\.truedown-clean-/);
  assert.match(trueDownBuild, /Directory\]::Move\(\$fullPath, \$quarantine\)/);
  assert.match(trueDownBuild, /Assert-NoReparseTree \$quarantine/);
  assert.match(trueDownBuild, /ARIA2_COPYING/);
  assert.match(extensionBuild, /\.kdownloader-build-/);
  assert.match(extensionBuild, /\.kdownloader-clean-/);
  assert.match(extensionBuild, /Directory\]::Move\(\$stagingPath, \$outputPath\)/);
  assert.match(extensionBuild, /File\]::Copy\(\$file\.FullName, \$destination, \$false\)/);
});

test("release workflows pin actions and bind releases to the tested commit", async () => {
  const [kDownloader, trueDown, dependabot] = await Promise.all([
    read(".github/workflows/publish-extension.yml"),
    read(".github/workflows/publish-truedown.yml"),
    read(".github/dependabot.yml"),
  ]);

  for (const workflow of [kDownloader, trueDown]) {
    const references = actionReferences(workflow);
    assert.ok(references.length > 0, "workflow must use at least one action");
    for (const { reference, version } of references) {
      assert.match(reference, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/, `${reference} must use an immutable commit`);
      assert.match(version || "", /^v\d+(?:\.\d+){1,2}$/, `${reference} must document its release version`);
    }
    assert.match(workflow, /persist-credentials:\s*false/);
    assert.match(workflow, /target_commitish:\s*\$\{\{ github\.sha \}\}/);
    assert.match(workflow, /timeout-minutes:\s*\d+/);
  }

  assert.match(kDownloader, /run:\s*npm test/);
  assert.match(kDownloader, /python -m unittest tests\/migrate_history_json_test\.py/);
  assert.match(kDownloader, /group:\s*publish-extension-\$\{\{ github\.ref \}\}/);
  assert.match(trueDown, /run:\s*go vet \.\/\.\.\./);
  assert.match(trueDown, /run:\s*node --test tests\/releaseWorkflow\.test\.mjs/);
  assert.match(dependabot, /package-ecosystem:\s*"github-actions"/);
  assert.match(dependabot, /interval:\s*"weekly"/);
});

test("extension build refuses to clean through a directory junction", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "kdownloader-build-boundary-"));
  const target = path.join(fixtureRoot, "outside-target");
  const marker = path.join(target, "must-survive.txt");
  const junction = path.join(root, "dist", `unsafe-build-${process.pid}-${Date.now()}`);
  await mkdir(target, { recursive: true });
  await writeFile(marker, "preserve\n");
  await mkdir(path.dirname(junction), { recursive: true });
  await symlink(target, junction, "junction");
  t.after(async () => {
    await unlinkIfPresent(junction);
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const build = path.join(root, "tools", "build-extension.ps1");
  await assert.rejects(
    run("pwsh", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", build,
      "-OutputDirectory", path.relative(root, junction),
    ]),
    /symbolic link or junction/,
  );
  await access(marker);
});

test("extension build refuses to clean a tree containing a directory junction", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "kdownloader-build-tree-boundary-"));
  const target = path.join(fixtureRoot, "outside-target");
  const marker = path.join(target, "must-survive.txt");
  const output = path.join(root, "dist", `unsafe-tree-${process.pid}-${Date.now()}`);
  const junction = path.join(output, "nested-junction");
  await mkdir(target, { recursive: true });
  await writeFile(marker, "preserve\n");
  await mkdir(output, { recursive: true });
  await symlink(target, junction, "junction");
  t.after(async () => {
    await unlinkIfPresent(junction);
    await rm(output, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const build = path.join(root, "tools", "build-extension.ps1");
  await assert.rejects(
    run("pwsh", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", build,
      "-OutputDirectory", path.relative(root, output),
    ]),
    /symbolic link or junction/,
  );
  await access(marker);
});

test("TrueDown build refuses an output directory junction before compilation", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "truedown-build-boundary-"));
  const target = path.join(fixtureRoot, "outside-target");
  const marker = path.join(target, "must-survive.txt");
  const trueDownRoot = path.join(root, "truedown");
  const junction = path.join(trueDownRoot, "dist", `unsafe-build-${process.pid}-${Date.now()}`);
  await mkdir(target, { recursive: true });
  await writeFile(marker, "preserve\n");
  await mkdir(path.dirname(junction), { recursive: true });
  await symlink(target, junction, "junction");
  t.after(async () => {
    await unlinkIfPresent(junction);
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await assertBuildRejectsBeforeCompilation("pwsh", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(trueDownRoot, "build.ps1"),
    "-OutputDirectory", path.relative(trueDownRoot, junction),
  ]);
  await access(marker);
});

test("TrueDown build refuses an internal directory junction before compilation", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "truedown-build-tree-boundary-"));
  const target = path.join(fixtureRoot, "outside-target");
  const marker = path.join(target, "must-survive.txt");
  const trueDownRoot = path.join(root, "truedown");
  const output = path.join(trueDownRoot, "dist", `unsafe-tree-${process.pid}-${Date.now()}`);
  const junction = path.join(output, "nested-junction");
  await mkdir(target, { recursive: true });
  await writeFile(marker, "preserve\n");
  await mkdir(output, { recursive: true });
  await symlink(target, junction, "junction");
  t.after(async () => {
    await unlinkIfPresent(junction);
    await rm(output, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await assertBuildRejectsBeforeCompilation("pwsh", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(trueDownRoot, "build.ps1"),
    "-OutputDirectory", path.relative(trueDownRoot, output),
  ]);
  await access(marker);
});

test("TrueDown build refuses a junction in embedded source inputs before compilation", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "truedown-build-source-boundary-"));
  const target = path.join(fixtureRoot, "outside-web");
  const trueDownRoot = path.join(root, "truedown");
  const junction = path.join(trueDownRoot, "web", `unsafe-source-${process.pid}-${Date.now()}`);
  await mkdir(target, { recursive: true });
  await symlink(target, junction, "junction");
  t.after(async () => {
    await unlinkIfPresent(junction);
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await assertBuildRejectsBeforeCompilation("pwsh", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(trueDownRoot, "build.ps1"),
    "-OutputDirectory", `dist/source-boundary-${process.pid}-${Date.now()}`,
  ]);
});
