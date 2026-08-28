# Tracker traffic research MVP

- Added an experimental, manually enabled RatioGhost-compatible tracker announce research module for Aria2 Next without modifying the aria2-next source tree.
- Added configurable leecher threshold, download/upload multiplier ranges, random KiB/s bonus and probability, zero-download reporting, and seed simulation with the requested 3 / 0-0.001 / 2-8 / 15 KiB/s / 5% defaults.
- Added an opaque loopback-only tracker relay with an automatically allocated port. It accepts only token-bound tracker GETs, rewrites HTTP/HTTPS trackers, preserves UDP trackers, and forwards HTTPS with normal upstream certificate validation instead of MITM certificates.
- Kept the module off by default and required a dedicated research-only, no-abuse, user-responsibility confirmation on every disabled-to-enabled transition.
- Persisted settings and restorable original tracker lists with owner-only permissions while keeping tracker URLs, passkeys, info hashes, relay tokens, and the internal port out of API status.
- Added Aria2 Next-only local `.torrent`, magnet, and HTTP(S) torrent-link creation with a user-selected save directory and mandatory smart layout: single-file torrents save directly, while multi-file torrents keep a torrent-named root folder.
- Added durable imported metainfo, a private Aria2 Next fast-resume state directory, integrity checking, one-second resume snapshots, native GID reattachment, and persistent `followedBy` child tracking so existing local torrent data is verified and resumed after restart.

## Verification

- `node --check truedown/web/app.js`
- `go test ./internal/downloader ./internal/api`
- `go test ./...`
- `go vet ./...`
