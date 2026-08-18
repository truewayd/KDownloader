# TrueDown resolver modules and Google Drive

- Added a versioned resolver-module registry with persisted install/remove state and dashboard controls. Dropbox and Google Drive ship installed as independent built-in modules; removing one affects new links while existing module-tagged tasks remain refreshable and resumable.
- Moved Dropbox start routing and aria2 preparation behind the shared module lifecycle without changing direct-archive defaults, optional folder expansion, filtering, or stable-link resume behavior.
- Added a pure-Go Google Drive resolver based on the public-link behavior studied from gdown. It accepts common Drive and Docs URL shapes, handles bounded large-file confirmation forms, exports Docs/Sheets/Slides, and refreshes temporary content URLs and cookies immediately before aria2 admission.
- Added bounded parallel recursion through Google Drive's public `embeddedfolderview`, preserving shared-folder hierarchy while limiting response size, file count, directory count, and depth.
- Added authenticated `GET/POST /modules` management and bounded `moduleOptions` on start requests. Dashboard submissions and AB-compatible `/add` requests now use the same installed-module routing.
- Persisted a generic resolver module ID on tasks and migrated existing Dropbox records, keeping temporary provider URLs out of durable task identity.
- Added gdown attribution and its MIT license to the packaged third-party notices.

## Verification

- `go test ./...`
- `go vet ./...`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1`
- Live public Google Drive folder parse with six tasks through `TRUEDOWN_GOOGLE_DRIVE_TEST_URL`
- Live public Google Drive file-name and confirmation-flow resolution through `TRUEDOWN_GOOGLE_DRIVE_TEST_URL`
- Compiled dashboard module controls checked in real Chrome at 1100 px and 390 px with no horizontal overflow
