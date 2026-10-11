# Independent Go MEGA module

Status: queue integration and signed-update implementation in development,
2026-10-11. Not yet published as a production release.

## Responsibility split

| Component | Responsibility |
| --- | --- |
| TrueDown manager | Durable identity, output reservation, task controls and publication |
| Existing aria2 | Ciphertext HTTP transfer, range resume, scheduling, retries, proxy and speed limits |
| Independent Go executable | MEGA metadata, AES decryption and complete MAC verification |
| Generic artifact coordinator | Staging, process retirement, recovery journal and atomic publication |
| Generic module host | Private framed IPC and signed executable installation |

Dropbox and Google Drive already delegate file transfers to aria2. Their Go
HTTP clients handle metadata, confirmation pages, folder enumeration and URL
refresh, not a second file-download stack. MEGA adds post-transfer verification
because aria2 cannot perform its AES/MAC protocol. The standalone network
downloader remains a reference/test path; production tasks use aria2.

No JavaScript runtime, native SDK, account or developer application key is
required. Public-link fragment decryption keys remain necessary. The publisher's
Ed25519 signing key is unrelated to MEGA and never reaches users.

## Queue and recovery

SQLite retains the stable public link. Temporary URLs exist only in admission
snapshots. Metadata and host-selected proxy settings cross a private pipe; keys
never become process arguments or raw diagnostics.

A private directory under the output directory contains a journal bound to the
module, public link and reserved output. aria2 owns `ciphertext` and its native
checkpoint/control file. Changing task options does not change staging identity.
Metadata refresh validates name/size before resume. File length never proves
plaintext integrity.

Engine completion starts local verification rather than declaring the task done.
At most two verification processes run concurrently. The module reads fixed
`ciphertext`, exclusively creates `payload`, verifies the full MAC, syncs/closes
the file and returns SHA-256. The host verifies that file and journals the result
before atomic, non-overwriting publication. Temporary hard links are removed
before reporting completion. Ciphertext is reclaimed after SQLite completion.

Pause/cancel/exit retire the writer before staging reuse. Restart during
verification repeats the local pass from retained ciphertext. The journal also
recovers a crash between publication and SQLite completion. Removing or clearing
history preserves the user file and cleans only fixed journal-owned entries.
This approach temporarily needs approximately twice the file size. aria2's
native checkpoint compatibility remains authoritative; invalid checkpoints must
restart safely rather than invent completed ranges.

## Distribution and independent updates

Desktop/core builds compile the module separately and carry its binary in the
core's distribution resources; its implementation is not linked into the host.
First use extracts a checksum-addressed baseline cache. Users install nothing
extra. Existing application bundle checks cover the baseline bytes.

Settings offers a MEGA update check. Releases use tags
`truedown-module-mega-vMAJOR.MINOR.PATCH`, four platform binaries, signed manifests
and licenses. The host verifies publisher signature, platform/protocol/version,
then uses a visible updater-owned aria2 task to download the executable. An
immutable installation and successful ID/version/capability handshake precede
atomic activation. Failure preserves the previous pointer. In-flight calls keep
their selected binary; restoring baseline does not delete in-use versions.
Declarative resolver JSON cannot install executable code.

The publisher must configure Actions secret `TRUEDOWN_MODULE_SIGNING_KEY`,
matching `internal/modulehost/trust.go`. The signing tool rejects other keys.
Never store the seed in the repository, logs or user UI. Current local GitHub
credentials return HTTP 403 for Actions secrets; provisioning and a real remote
update round trip are therefore not yet verified. Module-only source releases
use `publish-mega-module.yml` and do not trigger a core release.

## References and validation

Primary references: [MEGAcmd 6505327](https://github.com/meganz/MEGAcmd/tree/6505327a5a7a0e94f26f611f83b024aeeb63582c),
[SDK 8775533](https://github.com/meganz/sdk/tree/8775533fe50255723c45ab8abf4e14285a592d51),
[SDK crypto](https://github.com/meganz/sdk/blob/8775533fe50255723c45ab8abf4e14285a592d51/src/crypto/cryptopp.cpp),
and [MAC aggregation](https://github.com/meganz/sdk/blob/8775533fe50255723c45ab8abf4e14285a592d51/src/utils.cpp).
The SDK crypto code generated eight fixed MAC vectors, including empty input and
exact chunk boundaries. [MEGAJS 32e4fa1](https://github.com/qgustavor/mega/tree/32e4fa102b8a3afdd9e907877da285fea63e85e0)
supplies an additional published vector without shipping its runtime.
[aria2 HTTP resume](https://aria2.github.io/manual/en/html/aria2c.html#cmdoption-continue)
is the transport mechanism; ordinary checksums do not replace the MEGA MAC.

Tests cover protocol ambiguity, cancellation, signature/hash/rollback rejection,
activation failure, corruption, truncation, publication collisions, pause/resume
and publication-journal recovery. A real aria2 test interrupts a 2 MiB fixture,
restarts the manager, verifies nonzero HTTP Range and checks final plaintext.
This recovery test passes with bundled aria2 and aria2 NEXT 2.8.6 on Windows,
including ciphertext reclamation after durable completion and preservation of
the final file when its task record is removed. Linux tests cover publication,
pause, corruption, output collisions and activation failure. The settings page
passes six viewport/theme browser checks, including the MEGA update action.

A published public fixture also passed the native module and real TrueDown queue:
22 bytes, SHA-256
`8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85`.
Live fixtures come from environment variables; their keys are not committed or
logged. This is small-file evidence, not large-file or quota acceptance.

Public folders, CloudRAID, hashcash and account downloads are not implemented;
unsupported requests fail explicitly. Native macOS/ARM execution and published
update acceptance require separate evidence.
