import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("independent resolver profile publication does not require an application release", async () => {
  const publish = await read(".github/workflows/publish-resolver-profiles.yml");
  const application = await read(".github/workflows/publish-truedown.yml");
  assert.match(publish, /truedown\/modules\/profiles\/\*\.json/);
  assert.match(publish, /TestPublishedResolverProfiles\|TestResolverProfile/);
  assert.match(publish, /truedown-module-\$id-v\$version/);
  assert.match(publish, /sha256sum/);
  assert.match(publish, /cmp .*existing/);
  assert.match(publish, /\[\[ "\$target" == "\$GITHUB_SHA" \]\]/);
  assert.match(application, /!truedown\/modules\/\*\*/);
  for (const file of ["test-cross-platform.yml", "test-native-desktop.yml"]) {
    assert.match(await read(`.github/workflows/${file}`), /!truedown\/modules\/profiles\/\*\*/);
  }
});

test("filename identity is supplied by modules without provider IDs in the manager policy", async () => {
  const manager = await read("truedown/internal/downloader/manager.go");
  const policy = manager.slice(manager.indexOf("func expectedDropboxRemoteName"), manager.indexOf("func validAriaOptionName"));
  assert.doesNotMatch(policy, /GoogleDriveModuleID|ModuleID == "mega"/);
  assert.match(policy, /metadata\.NameSource == responseFilenameIdentity/);
  assert.match(policy, /expectedName = task\.RemoteName/);
  const profile = JSON.parse(await read("truedown/modules/profiles/google-drive.json"));
  assert.equal(profile.config.nameSource, "response");
  assert.equal(profile.engine, "google-drive-v1");
});
