# TrueDown AB browser integration compatibility

- Added the AB Download Manager browser extension's HTTP fallback protocol to TrueDown on its existing `127.0.0.1:15151` listener. The extension can now detect TrueDown through `POST /ping` and submit normal HTTP downloads through `POST /add`.
- Mapped AB download links, suggested filenames, request headers, and source-page URLs into TrueDown's validated aria2 queue while bounding each integration request to 1 MiB and 256 items.
- Standardized KDownloader, AB's extension, and the TrueDown dashboard on the same `X-Api-Key` authentication header and `apiKey` configuration field. HLS requests are rejected explicitly because TrueDown does not implement AB Download Manager's HLS pipeline.
- Added focused API and authentication coverage for connection probing, task dispatch, input validation, and extension API-key authentication.

## Verification

- `go test ./...`
- `go vet ./...`
