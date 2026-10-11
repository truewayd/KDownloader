# KDownloader cloud-link integration v1

These HTTP endpoints use the existing host, origin and optional `X-Api-Key`
authentication checks. They do not extend ABDM's `/add` or
`/start-headless-download` schemas and are not granted to desktop WebViews.

`GET /integrations/kdownloader/v1/capabilities` returns
`{protocol:"kdownloader.resolve",version:1,resolve:true,modules:[{id,enabled}]}`.
Only enabled supported modules permit the extension's opt-in switch to be saved.
The extension validates the configured backend again on each enabled save.

`POST /integrations/kdownloader/v1/resolve` accepts exactly `{link}` (16 KiB
request maximum). Only HTTPS public Google Drive/Dropbox module links are
eligible; no headers, cookies, names, output paths or executable options are
accepted. The module receives a 25-second deadline and retains its immutable
selection across concurrent settings changes. There is no ordinary HTTP fallback.

The JSON reply contains `protocol`, `version`, the original `link`, `accepted`,
`reason`, `module`, `taskIds`, `filtered`, and `duplicates`. Reasons are
`unsupported`, `disabled`, `unavailable`, or `failed`. An accepted response means
tasks were created/deduplicated or all entries were intentionally filtered, not
that final downloads succeeded. Uncertain network outcomes are not automatically
retried. Task fingerprints deduplicate an explicit repeated submission.

The extension records complete links locally, with `extracted`, `accepted`,
`failed`, or `manual` status. Both posts and DMs use the same normalized full URL
identity; query strings and fragment keys are retained. Incomplete MEGA links are
excluded from the ledger. TXT records are committed after the TXT is declared to
Chrome; backend attempts are recorded independently so failed attempts do not
repeat automatically. Users can unmark selected links to retry them.

`GET /system/download-issues` is a read-only counter snapshot for the native
notification monitor. It exposes a core epoch and counters for ordinary,
Dropbox and Google Drive issues. It contains no task URLs or raw errors.
