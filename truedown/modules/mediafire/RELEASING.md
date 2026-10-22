# Offline publisher signing

The signing seed may remain on the publisher's machine. Git contains only public
manifests and Ed25519 signatures; CI never needs the private key for this route.
The embedded publisher public key and client verification rules remain unchanged.

1. Use the exact Go patch version in `truedown/go.mod` (reuse an installed
   toolchain). Review provider changes, run its tests and commit the source.
2. From the repository root run:

   ```powershell
   ./truedown/modules/tools/prepare-offline-release.ps1 -Version 0.1.2 -SigningKeyPath <existing-key-file> -OutputDirectory <governed-run-directory> -GoPath <pinned-go.exe>
   ```

3. Commit `modules/mediafire/releases/<version>` together with provider changes.
   Push the commit and a new `truedown-module-mediafire-v<version>` tag. Never move
   an old tag or overwrite a public release.
   The helper builds exported Git bytes so Windows checkout line endings cannot
   change executable build IDs. It refuses uncommitted provider/protocol changes.
4. CI rebuilds all four executables with the same Go version, `CGO_ENABLED=0`,
   `-trimpath` and `-buildvcs=false`. It independently computes each complete
   manifest (module, version, OS, architecture, protocol, size, SHA-256) and
   verifies the committed signature against the production trust root. Any
   source/toolchain drift or invalid signature stops publication.
5. The existing signed-install test runs before publishing. The anonymous
   production updater test runs after publishing and proves transfer, signature
   checking, activation, selection after restart and baseline restore.

When no offline manifest directory exists, the workflow can still sign using
`TRUEDOWN_MODULE_SIGNING_KEY` from Actions Secrets. A present but invalid offline
signature is never silently replaced. Updating a provider requires a new version
and fresh signatures. The failed initial `0.1.1` publication had no signing
secret; `0.1.2` is the first offline-signed release candidate.
