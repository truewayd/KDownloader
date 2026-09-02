# Hot download-engine switching and recovery

- Switching between the built-in aria2 and a verified Aria2 Next installation
  now keeps the TrueDown HTTP service alive, drains active requests, restores
  unfinished downloads from the durable task database, and rolls back to the
  previous engine when the selected executable cannot start.
- Unexpected aria2 exits now preserve queued and paused task intent, retry the
  active engine up to three times, and reload TrueDown automatically only when
  in-process recovery is exhausted.
- Aria2 control files are saved every five seconds to reduce the resumable-data
  window after an unexpected process failure. Switching to stable aria2 is
  blocked while unfinished Aria2 Next BitTorrent tasks remain.

## Verification

```text
npm run ui:check
npm test
cd truedown
go test ./...
go vet ./...
TRUEDOWN_INTEGRATION=1 go test ./internal/downloader -run TestManagerDetectsUnexpectedAria2ExitForRecovery -count=1
TRUEDOWN_INTEGRATION=1 go test . -run TestManagerHostReloadsStableEngineInProcess -count=1
```
