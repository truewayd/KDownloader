# AB Download Manager API compatibility

Reviewed on 2026-10-13 using upstream source, not only REST-API.yml:

- Latest published desktop release: [v1.11.0](https://github.com/amir1376/ab-download-manager/releases/tag/v1.11.0).
- Inspected master: `dda4e2d0ca66895aab8547bc32bf4f113e70baa2`. The integration server in v1.11.0 and master is unchanged from v1.10.4.
- Browser integration: latest published v1.5.0; inspected master `1871203ce9665ea6802e8d1328f8b70c7dc9d948`. The newer bypass shortcut does not change the HTTP protocol.
- [Routes and authentication](https://github.com/amir1376/ab-download-manager/blob/afc57634b3c121c6415213242b2b600cccc6fd6e/integration/server/src/main/kotlin/com/abdownloadmanager/integration/Endpoints.kt).
- [Request types and legacy decoding](https://github.com/amir1376/ab-download-manager/blob/afc57634b3c121c6415213242b2b600cccc6fd6e/integration/server/src/main/kotlin/com/abdownloadmanager/integration/model/DownloadCredentialsFromIntegration.kt).
- [Headless request](https://github.com/amir1376/ab-download-manager/blob/afc57634b3c121c6415213242b2b600cccc6fd6e/integration/server/src/main/kotlin/com/abdownloadmanager/integration/model/NewDownloadTask.kt).
- [Desktop behavior](https://github.com/amir1376/ab-download-manager/blob/afc57634b3c121c6415213242b2b600cccc6fd6e/desktop/app/src/main/kotlin/com/abdownloadmanager/desktop/integration/IntegrationHandlerImp.kt).

Recent upstream integration changes were API Key authentication on 2026-07-24
and loopback-only binding on 2026-09-06. TrueDown already implements both defaults.
The older REST specification omits polymorphic types, suggested names, silent
options, categories and start flags; it is not a complete compatibility contract.
No upstream implementation was copied.

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
| HLS | Explicit `type:"hls"` fails before task creation. aria2 HTTP downloads do not implement playlist assembly. |
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
HLS assembly and a TrueDown-specific native messaging host need separate product
and engine work. They are not enabled by merely accepting new JSON fields.
