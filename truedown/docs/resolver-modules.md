# Resolver boundaries and independent updates

## Current scope

| Layer | Owns | Update unit |
| --- | --- | --- |
| Host manager | Queue, durable task identity, local path ownership, retry cleanup and aria2 admission | TrueDown application |
| Resolver metadata contract | Transient remote filename, size, digest and initial filename basis | Host-supported contract |
| Google Drive profile | Compatibility endpoints, user agent and first-response filename policy | Independent JSON release |
| Dropbox profile | Folder endpoint, CSRF cookie names and user agent | Independent JSON release |
| Google Drive/Dropbox parsers | Confirmation flow, bounded folder enumeration and URL validation | Compiled host code |
| MEGA provider | Metadata, decryption and MAC verification over private framed IPC | Independent signed executable |
| Task links UI | Context menu and selected-task clipboard writes | TrueDown desktop |

Google Drive and Dropbox are declarative compatibility components, not arbitrary
code plugins. Naming them modules does not make their compiled parsers independently
updatable. MEGA already has that stronger executable boundary.

The filename fix previously branched on Google Drive inside the manager. The host
now accepts a provider-declared `NameSource` instead. Google Drive's profile chooses
`nameSource=response` (also the default for an older profile omitting the field).
That uses only the persisted remote name for identity, allowing a listing title or
custom local name to differ on first preparation. `legacy-output` retains the old
initial local-name fallback for compatibility testing. Both modes enforce any
recorded remote name, size and digest. Neither renames an admitted local output.
MEGA declares response identity through the same generic contract; Dropbox keeps
its existing legacy fallback. The manager needs no Google/MEGA name special cases.

## Publishing a compatibility profile

1. Edit `truedown/modules/profiles/google-drive.json` or `dropbox.json`, increasing
   its independent canonical semver and updating `releasedAt`.
2. Commit and push that profile to main. `publish-resolver-profiles.yml` validates
   both profiles with the actual host decoder and tests the retry/update contract.
3. It publishes `truedown-module-ID-vVERSION` containing `ID.json` and
   `ID.sha256`. Already published versions must match byte for byte; they are
   never overwritten. A partial draft is recoverable only at its originating SHA.
4. In Engine and modules, Check updates fetches that module's highest published
   stable version. The host bounds discovery to ten pages and JSON to 64 KiB,
   omits application/site credentials, validates its checksum and exact
   ID/engine/version, and runs the closed config decoder before activation.

Profile data is fetched only from the fixed project repository over HTTPS with
a SHA-256 consistency check. This is not an executable publisher signature.
Only MEGA's executable path can install code, after Ed25519 verification and a
successful protocol/version/capability handshake. Profiles cannot choose arbitrary
hosts, scripts, paths, commands or executable downloads.

The registry serializes persistence and rejects a fetched update if the active
profile changed meanwhile. A concurrent manual import therefore wins. Baseline
restore rejects an update in progress. A profile check never changes its enabled
flag. In-flight calls retain their immutable component snapshot; later calls see
the new profile. Network, decoding and persistence failures retain the active
component. Reset switches back to the embedded baseline without deleting tasks.

`publish-truedown.yml` excludes `truedown/modules/**`; desktop validation also
excludes profile-only changes. Thus future profile-only pushes publish no new
application installer. Updating the host's frozen baseline is a deliberate,
separate change to `internal/downloader/module_baselines/`.

This first integration requires one application update for the generic identity
contract and automatic profile discovery. Previously shipped hosts reject the
new Google `nameSource` field and retain their active profile; a profile release
cannot retroactively add missing host behavior. Copy-link UI also needs that
application update.

## Further code independence

The remaining coupling is explicit: resolver methods still receive `*Manager`,
and Google/Dropbox protocol parsing lives in the downloader package. A future
code-level module migration should replace that with bounded Resolve/List/Prepare
messages carrying source, selected format and host-approved proxy data. Providers
should return stable source IDs, relative path components, remote metadata and
transient transfer URLs, never manager/store handles or arbitrary output paths.
The host must retain filtering, task admission, local ownership and publication.

Extend the existing `modulehost` framed protocol with an HTTP-resolution capability
and validate every returned URL/header/path before aria2 admission. Version that
capability separately from MEGA's artifact verification, use its existing signed
installation/handshake/immutable-selection mechanism, and keep old providers for
in-flight calls. Migrate one provider with parity fixtures covering confirmation,
native exports, folder limits, credentials, cancellation and retries before
removing the compiled implementation. Do not turn a JSON compatibility package
into an executable loader or move output ownership into provider code.

This change implements the generic filename boundary and independent configuration
delivery. The remaining parser migration is future work.
