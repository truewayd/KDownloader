import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("release workflow publishes the newest dated changelog", async () => {
  const [workflow, selectorSource, agents, gitignore] = await Promise.all([
    read(".github/workflows/publish-extension.yml"),
    read("tools/read-latest-changelog.ps1"),
    read("AGENTS.md"),
    read(".gitignore"),
  ]);
  const datedFiles = (await readdir(path.join(root, "changelog")))
    .filter((name) => /^\d{4}-\d{2}-\d{2}-\d{3}-.+\.md$/.test(name))
    .sort()
    .reverse();

  assert.ok(datedFiles.length > 0, "At least one dated release note is required");
  assert.equal(datedFiles[0], "2026-08-10-001-security-quality-hot-path-audit.md");
  assert.match(workflow, /read-latest-changelog\.ps1 -OutputFile release-notes\.md/);
  assert.match(workflow, /body_path:\s*release-notes\.md/);
  assert.match(workflow, /generate_release_notes:\s*false/);
  assert.match(selectorSource, /Sort-Object Name -Descending/);
  assert.match(selectorSource, /"README\.md", "CHANGELOG\.md"/);
  assert.doesNotMatch(agents, /^- \d{4}-\d{2}-\d{2}:/m);
  assert.match(gitignore, /!changelog\/\*\.md/);

  const latest = await read(`changelog/${datedFiles[0]}`);
  assert.match(latest, /^# .+/);
  assert.match(latest, /## Verification/);
});

test("monorepo release workflows are independently path scoped", async () => {
  const [kdownloader, trueDown] = await Promise.all([
    read(".github/workflows/publish-extension.yml"),
    read(".github/workflows/publish-truedown.yml"),
  ]);

  assert.match(kdownloader, /paths:\s*[\s\S]*"background\/\*\*"/);
  assert.doesNotMatch(kdownloader, /"truedown\/\*\*"/);
  assert.match(trueDown, /paths:\s*[\s\S]*"truedown\/\*\*"/);
  assert.match(trueDown, /working-directory:\s*truedown/);
  assert.match(trueDown, /RELEASE_TAG:\s*truedown-build-/);
});
