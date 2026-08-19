# TrueDown resolver components

Dropbox and Google Drive each have two layers:

- A compiled resolver engine owns parsing, task creation, trusted-host checks,
  response limits, recursion limits, and credential handling.
- A small declarative component package owns provider compatibility values such
  as endpoint paths, CSRF cookie names, and the resolver User-Agent.

This boundary lets provider compatibility updates ship independently without
loading executable plugins or weakening the download manager's security model.

## Lifecycle

The baseline packages in `internal/downloader/module_baselines/` are embedded in
`TrueDown.exe`. They are always available, including when a user update is
missing, corrupt, incompatible, or older than the embedded baseline.

The dashboard's resolver-component cards support three separate actions:

- **Enable / Disable** changes whether the resolver claims new links. It does
  not delete a component version or affect existing module-tagged tasks.
- **Import update** validates a local JSON package, persists it as
  `<data-dir>/modules/<id>.json`, and activates an immutable snapshot
  immediately. In-flight calls finish on their old snapshot.
- **Restore baseline** removes the independent package and atomically activates
  the version embedded in the running TrueDown binary.

The module list reports the active version, baseline version, release date,
source, hot-reload support, and the SHA-256 digest computed from normalized
package content. Updates must be strictly newer than both the embedded baseline
and any active update; restoring the baseline is the explicit downgrade path.

## Package envelope

Packages are UTF-8 JSON objects no larger than 64 KiB. Unknown fields are
rejected at every level.

```json
{
  "schemaVersion": 1,
  "id": "google-drive",
  "engine": "google-drive-v1",
  "version": "1.1.0",
  "releasedAt": "2026-08-20",
  "config": {}
}
```

`version` uses canonical `major.minor.patch` numeric components. `releasedAt`
uses `YYYY-MM-DD`. The `id` and `engine` must match one of the engines compiled
into the current TrueDown release.

### Dropbox `dropbox-v1`

```json
{
  "folderEntriesPath": "/list_shared_link_folder_entries",
  "csrfCookieNames": ["__Host-js_csrf", "t"],
  "userAgent": "Mozilla/5.0"
}
```

The endpoint path is always resolved against the compiled, trusted
`https://www.dropbox.com` origin. Cookie names and header values are bounded and
cannot contain control characters.

### Google Drive `google-drive-v1`

```json
{
  "stableDownloadPath": "/uc",
  "openPath": "/open",
  "folderViewPath": "/embeddedfolderview",
  "nativeExportPath": "/{type}/d/{id}/export",
  "userAgent": "Mozilla/5.0"
}
```

Drive paths remain on compiled `drive.google.com` or `docs.google.com` origins.
`nativeExportPath` must contain exactly one `{type}` and one `{id}` placeholder;
both are path-escaped before use. A package cannot add redirect hosts, lower
response or traversal protections, introduce aria2 arguments, or run code.

## HTTP API

- `GET /modules` returns component and enablement state.
- `POST /modules` accepts `{ "id": "...", "installed": true }` for backwards
  API compatibility; the flag now means enabled for new-link routing.
- `POST /modules/package` accepts `{ "package": <package-object> }` and returns
  the newly active component description after persistence succeeds.
- `DELETE /modules/package?id=<module-id>` restores the embedded baseline.

The endpoints use the same origin and `X-Api-Key` protection as other TrueDown
write APIs.
