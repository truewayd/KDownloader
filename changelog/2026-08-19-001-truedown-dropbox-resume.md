# TrueDown Dropbox resume compatibility

- Added in-place renewal for failed Dropbox `dl=1` tasks when the partial file, aria2 control file, folder, and file name match.
- Renewed Dropbox resumes ignore redirect URL differences while retaining aria2 total-length validation and enabling integrity checks for any available Digest hash.
- Persisted the renewed link and request metadata so a restarted TrueDown instance continues with the latest Dropbox URL.
- Resolved each Dropbox shared link to its current trusted content URL before aria2 admission, avoiding invalid Range responses from replaying a partial request against the `dl=1` redirect entry point.
- Persisted and compared remote total length and any available Digest header before reusing partial data.
- Treated Dropbox shared-folder links as dynamically generated ZIP archives: refresh now uses one GET with a five-minute response-header budget instead of two short probes, and persists the returned archive name for later resume validation.
- Routed both Dropbox refresh requests and aria2 content transfers through explicit `HTTP(S)_PROXY` settings or the current Windows user proxy, while keeping local aria2 RPC traffic direct.

## Verification

- `go test ./...`
- `go vet ./...`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1`
