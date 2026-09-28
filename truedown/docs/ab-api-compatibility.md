# AB Download Manager API compatibility

Reviewed on 2026-09-28 using upstream source, not only REST-API.yml:

- Latest published desktop release: [v1.10.4](https://github.com/amir1376/ab-download-manager/releases/tag/v1.10.4), commit `afc57634b3c121c6415213242b2b600cccc6fd6e`.
- Current master: `2beb913e7ec9b2cf50303f15242696a2744a34d5`. Its integration server has no changes relative to v1.10.4.
- Browser integration: latest published v1.5.0; inspected master `d15970d452ae981dd0b6ef008cfe52817144be5d`.
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
| `POST /add` | Accepts modern `{items, options}` and legacy arrays; preserves HTTP headers, page and suggested filename. Accepts JSON, text/plain and absent Content-Type as the official extension sends them. |
| `silentAdd:true, silentStart:false` | New tasks enter the manager paused before engine admission, including resolver expansion. |
| `silentAdd:true, silentStart:true` | Creates queued tasks. |
| `silentAdd:false` or omitted | Retains TrueDown's existing immediate import behavior. ABDM's interactive import dialog is not reproduced. |
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
are rejected. Resolver failures can still produce partial batch acceptance;
the API does not promise an atomic multi-source import.

Future named queues/scheduling, category mapping, interactive external imports,
HLS assembly and a TrueDown-specific native messaging host need separate product
and engine work. They are not enabled by merely accepting new JSON fields.
