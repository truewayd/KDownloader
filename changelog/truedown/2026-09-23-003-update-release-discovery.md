# Reliable release discovery

- Recover GitHub release lists that temporarily omit uploaded assets by querying the newest stable release's asset endpoint. Keep the request bounded and retain all manifest, checksum and executable checks.
- Incomplete releases and failed asset lookups report an error instead of incorrectly reporting no update or choosing an older release.
- Upload release assets as a draft, verify all five uploaded files before publication, then check the release-list metadata consumed by existing clients.

## Verification

- Regression coverage includes empty/partial asset projections, complete inline metadata, missing assets, rate limits, invalid release IDs, cancellation and newest-release selection.
- Uploaded-asset validation rejects missing, duplicate, incomplete and incorrectly sized files. Workflow contracts require draft upload, validation and public metadata verification in order.
- Go tests and vet passed; frontend tests passed (358, one conditional skip), as did 29 release validation tests, 13 migration tests, shared UI checks and the extension build.
