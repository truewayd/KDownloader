# AB Download Manager API compatibility

Reviewed on 2026-10-22 using upstream source, not only REST-API.yml:

- Latest published desktop release: [v1.11.1](https://github.com/amir1376/ab-download-manager/releases/tag/v1.11.1).
- Inspected master: `e329495b6630b18e4b41d7682da33318b0f9ea18`. The integration server in v1.11.1 and master is unchanged from v1.10.4.
- Browser integration: latest published v1.5.0; inspected master `658a0c70188d78033f478ba51c102a273322166f`. The newer bypass shortcut and selected-link content-script/tab fixes do not change the HTTP protocol. The client still uses a 500ms timeout for POST `/add` and `/ping`.
- [Routes and authentication](https://github.com/amir1376/ab-download-manager/blob/afc57634b3c121c6415213242b2b600cccc6fd6e/integration/server/src/main/kotlin/com/abdownloadmanager/integration/Endpoints.kt).
- [Request types and legacy decoding](https://github.com/amir1376/ab-download-manager/blob/afc57634b3c121c6415213242b2b600cccc6fd6e/integration/server/src/main/kotlin/com/abdownloadmanager/integration/model/DownloadCredentialsFromIntegration.kt).
- [Headless request](https://github.com/amir1376/ab-download-manager/blob/afc57634b3c121c6415213242b2b600cccc6fd6e/integration/server/src/main/kotlin/com/abdownloadmanager/integration/model/NewDownloadTask.kt).
- [Desktop behavior](https://github.com/amir1376/ab-download-manager/blob/afc57634b3c121c6415213242b2b600cccc6fd6e/desktop/app/src/main/kotlin/com/abdownloadmanager/desktop/integration/IntegrationHandlerImp.kt).

Recent upstream integration changes were API Key authentication on 2026-07-24
and loopback-only binding on 2026-09-06. TrueDown already implements both defaults.
The older REST specification omits polymorphic types, suggested names, silent
options, categories and start flags; it is not a complete compatibility contract.
No upstream implementation was copied.

[PR 1488](https://github.com/amir1376/ab-download-manager/pull/1488), opened
2026-10-18 and still unmerged at review, only documents the existing
`categoryId`, `startDownload` and `startQueue` fields. It does not introduce
a new REST API. TrueDown already preserves the typed start default and rejects
unsupported queue/category actions before creating tasks.

Rayburst Connect 2.1.7 uses a different
[desktop REST contract](https://github.com/AnInsomniacy/rayburst-connect/blob/v2.1.7/lib/api.ts):
GET `/ping` with product identity, `/downloads/capabilities`, Bearer authentication
and structured download handoff responses. It cannot use TrueDown's ABDM routes
directly. NEXT 3.0.8 restoring engine capability flags does not implement that
desktop protocol. A future adapter needs separate product/route semantics;
do not overload the existing ABDM `/add` contract or impersonate its native host.

| Surface | TrueDown behavior |
| --- | --- |
| `POST /ping` | Returns `pong`; subject to enabled API Key authentication. |
| `POST /add` | Accepts modern `{items, options}` and legacy arrays; preserves HTTP headers, page and suggested filename. Accepts JSON, text/plain and absent Content-Type as the official extension sends them. Returns `OK` after a durable local inbox commit, before cloud resolution, to fit the official extension's 500ms request timeout. |
| `silentAdd:true, silentStart:false` | New tasks enter the manager paused before engine admission, including resolver expansion. |
| `silentAdd:true, silentStart:true` | Creates queued tasks. |
| `silentAdd:false` or omitted | Imports into TrueDown's queue automatically. ABDM's interactive import dialog is not reproduced. |
| `POST /start-headless-download` | Accepts `downloadSource.type:"http"`, `suggestedName`, nullable optional folder/name/IDs, and explicit `startDownload`. Explicit name wins. Typed ABDM requests default to paused, matching upstream. Untyped TrueDown requests retain auto-start unless explicitly disabled. Existing `OK <id>` and module/duplicate response extensions remain. |
| `GET /queues` | Returns `[]`: TrueDown has no ABDM named queue objects. The global pause/resume controls remain available through TrueDown's own API. This HTTP integration route is not granted to native WebViews. |
| Queue/category selection | Non-null `categoryId`, `startQueue:true`, and nonzero queue IDs in typed ABDM requests fail before creating tasks. Untyped legacy TrueDown `queueId` retains its existing aria2 insertion-position meaning. |
| HLS | Explicit `type:"hls"` on `/add` and headless requests is durably accepted with its suggested title, headers and typed/silent pause intent. It delegates to NEXT 3 native media when supported; older engines leave a visible task waiting for a compatible engine, notify the user, and still handle ordinary HTTP items in mixed batches. |
| API Key | Uses `X-Api-Key`; existing host/origin and request-size checks remain. |
| Native Messaging | ABDM's browser native host/CLI protocol is product-specific and is not impersonated. Configure the official extension to use HTTP for TrueDown. |

Adding an existing pending task preserves its current state and identity. The
initial pause intent is neither a stored aria2 option nor part of duplicate
fingerprinting; the task's persisted status controls restart and manual resume.
Bodies remain bounded to 1 MiB, batches to 256 items, and unknown fields/types
are rejected before inbox acceptance. SQLite schema 8 adds a private inbox,
bounded to 64 requests and 16 MiB in aggregate; full/stopping queues return 503
and storage failures never return OK. Pending identical requests coalesce.
Each completed item advances a persisted cursor after its task records exist;
unfinished items replay after restart without restarting an existing completed
task. Request cancellation after acknowledgement does not cancel the import.
Source credentials are removed from the inbox when it settles and never enter
logs or public task snapshots. Resolver failures increment download-issue
notifications; OK means accepted for processing, not resolved or downloaded.
This is an at-least-once inbox with task-identity deduplication, not an atomic
multi-source cloud transaction.

KDownloader sends `downloadSource.type:"http"` and `startDownload:true`
explicitly. Omitting the start flag in a typed ABDM request intentionally pauses
the task, whereas the untyped legacy TrueDown extension remains compatible.

Future named queues/scheduling, category mapping, interactive external imports,
and a TrueDown-specific native messaging host need separate product
and engine work. They are not enabled by merely accepting new JSON fields.
