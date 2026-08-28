# BitTorrent identity and zero-speed diagnostics

- Documented and surfaced the actual engine-owned Aria2 Next/libtorrent BitTorrent identity, including its versioned `A2` peer fingerprint, without exposing ineffective retired aria2 identity controls or mismatching the ordinary HTTP User-Agent.
- Added peer, seeder, tracker, connection-candidate, handshake, and availability details to BitTorrent task progress so a zero download rate has immediate discovery context.
- Enabled Aria2 Next v2.6.5+ native redacted debug logging with bounded 10 MiB rotation across four `aria2.log` files, while keeping the console warning stream separate and retaining summarized logs for older engines.
- Classified Aria2 Next's HTTP 416 stale-range failure in the dashboard. Retrying that specific error now asks for destructive confirmation, removes only the task's direct-child partial file and recovery state, and restarts from zero; ordinary failures continue to retain resumable data.

## Verification

- `go test ./...`
- `go vet ./...`
- `node --check web/app.js`
