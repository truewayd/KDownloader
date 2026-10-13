# Independent Go MEGA module

Status: module 0.2.0 implements public files and folders, 2026-10-12.
Local and public-link acceptance is recorded below. Not yet published.

## Responsibility split

| Component | Responsibility |
| --- | --- |
| TrueDown manager | Durable identity, output reservation, task controls and publication |
| Existing aria2 | Ciphertext HTTP transfer, range resume, scheduling, retries, proxy and speed limits |
| Independent Go executable | MEGA metadata, AES decryption and complete MAC verification |
| Generic artifact coordinator | Staging, process retirement, recovery journal and atomic publication |
| Generic module host | Private framed IPC and signed executable installation |

## Public-link modes and shared filter

The module accepts modern `/file/handle#key` and legacy `/#!handle!key`
public-file links, modern `/folder/handle#key` and legacy `/#F!handle!key`
public-folder links, and modern selected-subfolder or selected-file fragments.
It decrypts anonymous folder metadata and node keys within the independent
process. A child handle stays qualified by its original folder share; it is
never treated as a standalone public-file handle. Selected subfolders are
resolved by node ancestry, including when siblings have the same visible name.

- `archive` is the default persisted `megaMode`. One queue task downloads the
  selected folder and builds a ZIP locally, preserving hierarchy and empty
  directories. At most one member uses aria2 at a time within that admission.
  Each member passes its full MEGA MAC before the ZIP can be published.
  ZIP entries use the Go standard library's Store method; this mode does not
  shrink file contents or call a remote ZIP service.
- `expand` creates one independent task per file, preserving the relative
  hierarchy. The same `filterMode` and suffix list used by Dropbox and Google
  Drive apply here. Project mode reads the current Engineering group; custom
  mode uses the saved list; off applies no exclusions. Matching ignores case.
  Request options may override the MEGA mode or disable its filter.
- Direct public-file and selected-file submissions remain individual downloads.
  The folder filter does not exclude them or change an archive's contents.
  Google Drive filters the actual selected export suffix, for example `.pptx`
  for Slides, after deriving the final output name.

The listing is bounded to 6,000 nodes, 5,000 files, 1,000 directories, depth 64
and a 768 KiB durable manifest. Windows-unsafe names, case-insensitive path
collisions, unavailable node keys, missing parents and cycles fail explicitly.
They are not silently omitted from a ZIP. An archive freezes its listing at
submission; a changed file name or length fails the transfer for a fresh retry.

Dropbox and Google Drive already delegate file transfers to aria2. Their Go
HTTP clients handle metadata, confirmation pages, folder enumeration and URL
refresh, not a second file-download stack. MEGA adds post-transfer verification
because aria2 cannot perform its AES/MAC protocol. The standalone network
downloader remains a reference/test path; production tasks use aria2.

No JavaScript runtime, native SDK, account or developer application key is
required. Public-link fragment decryption keys remain necessary. The publisher's
Ed25519 signing key is unrelated to MEGA and never reaches users.

## Queue and recovery

SQLite retains the stable public link and, for folder tasks, a private manifest
or opaque child metadata. Task snapshots do not expose that additional key
material. Temporary URLs exist only in admission snapshots. Metadata and
host-selected proxy settings cross a private pipe; keys never become process
arguments or raw diagnostics.

A private directory under the output directory contains a journal bound to the
module, public link, frozen child metadata and reserved output. aria2 owns
`ciphertext` (a file) or fixed `ciphertext-NNNNNN` members (an archive), and their
native checkpoint/control files. Changing task options does not change staging identity.
Metadata refresh validates name/size before resume. File length never proves
plaintext integrity.

Engine completion starts local verification rather than declaring the task done.
At most two verification processes run concurrently. The module reads fixed
`ciphertext`, exclusively creates `payload`, verifies the full MAC, syncs/closes
the file and returns SHA-256. For an archive, verified plaintext streams directly
into ZIP entries; no separate plaintext member files are created. The host
verifies the ZIP payload and journals the result
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
and complete reference licenses. The host verifies publisher signature, platform/protocol/version,
then uses a visible updater-owned aria2 task to download the executable. An
immutable installation and successful ID/version/capability handshake precede
atomic activation. Failure preserves the previous pointer. In-flight calls keep
their selected binary; restoring baseline does not delete in-use versions.
Declarative resolver JSON cannot install executable code.

The publisher must configure Actions secret `TRUEDOWN_MODULE_SIGNING_KEY`,
matching `internal/modulehost/trust.go`. The signing tool rejects other keys.
Never store the seed in the repository, logs or user UI. Provisioning and a real
published signed-update round trip are not verified by this local change. Module-only source releases
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

On 2026-10-12, an anonymous example subfolder from
[NTFSvolume/mega.py](https://github.com/NTFSvolume/mega.py) passed the real bundled
module and aria2 queue: TXT (61 bytes), PDF (45,815 bytes) and CSV (29,024 bytes)
produced a readable 75,370-byte ZIP. Excluding `.PDF` produced two independent
downloads whose bytes matched the ZIP entries. A selected PDF link bypassed the
folder filter and matched the verified ZIP member. A separate 662,326-byte public
PDF from [RM520N-GL](https://github.com/4IceG/RM520N-GL) passed the module's MAC
verification and production aria2 queue, SHA-256
`0e0f8f00ccf5ec70faccdb1d46678d14e0896d5a110cc8cb44cfc357a35d4e3a`.
The old 22-byte MEGAJS CLI example is now unavailable (API code -9); its earlier
result is not current acceptance evidence.

A two-member aria2 fixture also passed interruption, parent pause, process
restart with nonzero HTTP Range, ZIP content comparison, active removal and
preservation of a completed ZIP when its task is removed. These checks exercise
the coordinator; fixed SDK vectors and the public-link checks exercise MEGA's
actual cryptography. The shared filter passed a real Google Drive Slides folder
export. Dropbox enumerated 18 public files, excluded all 18 with `.GZ`, passed
a one-byte Range probe, and downloaded a 12,546,129-byte file through aria2
whose bytes matched an independently fetched reference.
Live links and keys are supplied through environment variables, not committed or
logged. These are small-file checks, not large archives or quota acceptance.

The About page lists dependency and reference roles and full license texts.
`licenses/projects.json` pins reference source commits and original license
hashes. MEGAJS is MIT; SDK is BSD-2-Clause; MEGAcmd's BSD license explicitly
excepts GPL portions, including the interactive shell. No webclient, SDK,
MEGAcmd or JavaScript runtime is bundled. Native dependency notices are generated
from the locked platform graph and included in the packaged About page.

CloudRAID, hashcash and account downloads remain unsupported and fail explicitly.
Native macOS/ARM execution and published update acceptance require separate evidence.
