# Pawchive media hand-off

Pawchive's `file.pawchive.pw/data/` service can return HTTP 403 with a plain-text
download policy: no more than one request per second, five simultaneous
downloads, and an identifiable downloader User-Agent. It explicitly warns that
excessive downloading and pretending to be a browser can cause a block.

On 2026-10-13, creator `fanbox/2131660` returned its JSON listing successfully,
while its media files returned that policy response. Local aria2 logs showed the
same 403 from `Server: ddos-guard`, with `User-Agent: Mozilla/5.0`. Browser success
does not prove that a download client's request meets the server's policy.

KDownloader owns creator/post parsing, media URL construction, the full post
referrer and media request identity. By default, it sends `KDownloader/<extension version>`
and its project URL with `Accept: */*` to the configured ABDM/TrueDown or Gopeed
backend. The document-start API bridge retains its browser-managed identity.

KDownloader 3.3.1 exposes three media UA modes in backend settings: `site`
(existing site defaults), `browser` (the background browser's complete UA), and
`backend` (omit the UA override). `forwardCookies` is independent and defaults to
true. Cookies are selected for the exact media URL, using the originating tab's store when available,
including its first-party partition, with the existing 64 KiB bound. Disabling
this option prevents media cookie reads and forwarding. These settings do not
change Pawchive's API bridge or browser verification flow.

The generic hand-off behavior was compared with
[ABDM Browser Integration's header reader](https://github.com/amir1376/ab-download-manager-browser-integration/blob/658a0c70188d78033f478ba51c102a273322166f/src/background/actions.ts#L39)
and [its sendHeaders choice](https://github.com/amir1376/ab-download-manager-browser-integration/blob/658a0c70188d78033f478ba51c102a273322166f/src/contentscripts/AddDownloads.ts#L6).
Its URL cookie lookup and browser UA inform the independent implementation;
its Host override is not copied. The complete original Apache-2.0 notice is
retained in `truedown/licenses/ABDM_BROWSER.txt` and the generated About inventory.

[Chrome's Cookie API](https://developer.chrome.com/docs/extensions/reference/api/cookies)
defaults to unpartitioned cookies; modern
[Cloudflare clearance cookies use CHIPS](https://developers.cloudflare.com/waf/troubleshooting/samesite-cookie-interaction/).
Cloudflare also [ties clearance to the visitor/device](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/).
The option can carry applicable cookies, but does not guarantee another client's
requests pass verification, especially when browser and backend exits differ.

TrueDown receives ordinary HTTP tasks. Its existing header path accepts the
caller UA, including an override of a configured native UA; no Pawchive resolver
module is involved. The default global concurrency is three, with the ordinary
16-connection option and five-attempt retry option. Global queue concurrency and
per-file connections are different limits. There is no Pawchive-specific core
timer, connection cap, retry cap, resume branch or metadata-probe scheduler.

## Default-queue acceptance

On 2026-10-14, two disjoint sets of 12 files from `fanbox/2131660` completed with
the site's core adaptations removed. Both runs used the actual native queue
default of three, ordinary connection/retry options and KDownloader's media UA.
No cookies, browser visits, media preflights or extra request delay were used.

| Engine | Verified files | Verified bytes | Observed active task peak |
| --- | ---: | ---: | ---: |
| aria2 1.37.0 | 12/12 | 8,041,870 | 3 |
| aria2 NEXT 3.0.1 | 12/12 | 48,768,933 | 3 |

All 24 output SHA-256 values matched their source URL identities. The sets
include covers, attachments, JPEG and PNG files, including a 31,986,715-byte PNG.
The aria2 wire log recorded 12 requests, zero HTTP 403 responses and a minimum
start gap of 10,305 microseconds; success therefore did not depend on the former
1.1-second timer. NEXT does not expose equivalent legacy wire blocks, so its
request-count, spacing and HTTP-response-count fields are unavailable.

Samples were selected using creator JSON only, excluding URLs present in the
local task database, available aria2 log and the earlier two-file experiment.
This establishes previously unobserved local requests, not an empty global CDN
cache or proof that the user never opened a URL in another browser/profile.
See [the per-file report](pawchive-default-validation-2026-10-14.json).

`TestPawchiveDefaultsLive` is opt-in through `TRUEDOWN_PAWCHIVE_LIVE=1` and takes
a disjoint JSON manifest in `TRUEDOWN_PAWCHIVE_SAMPLES`. Optional
`TRUEDOWN_PAWCHIVE_REPORT` retains results after the isolated profile is cleaned.
`TRUEDOWN_ARIA2_PATH` selects the native engine; set
`TRUEDOWN_ARIA2_NEXT_VERSION` when testing NEXT. Do not reuse warmed manifests as
fresh-file evidence. Ordinary CI skips this external test.

These results support keeping this hand-off in the extension and preserving the
generic backend defaults. They do not isolate UA as the only cause of the earlier
403, prove another IP/proxy will behave identically, or override the site's stated
download limits. Existing task headers are not rewritten; old browser-UA tasks
must be submitted again by the updated extension. Backend acceptance remains
distinct from verified download completion.
