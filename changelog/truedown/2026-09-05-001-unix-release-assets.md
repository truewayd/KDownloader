# Linux and macOS release packages

- Numbered TrueDown releases now include Linux amd64/arm64 tarballs and macOS
  Intel/Apple Silicon ZIP archives containing `TrueDown.app` alongside Windows.
- Each Unix package is built and tested with native aria2 on its matching
  operating system and architecture. Publication waits for all five builds.
- Release validation checks the complete asset set, archive contents, binary
  architectures, Unix executable permissions, and macOS bundle metadata/icon.
- The Windows ZIP name and self-update manifest retain their existing format;
  validation checks the manifest's build, archive size, and SHA-256 before release.
- Unix packages require an installed aria2 and use manual updates. macOS signing,
  notarization, and a native menu-bar controller remain future work.

## Verification

```text
node --test tests/releaseWorkflow.test.mjs
python -m unittest discover -s truedown/tools -p test_validate_release.py
npm run ui:check
npm test
cd truedown
go test ./...
go vet ./...
```

The release workflow additionally runs native Unix integration tests, Linux
package smoke tests, macOS plist validation, and the complete archive validator
before publishing the six assets.
