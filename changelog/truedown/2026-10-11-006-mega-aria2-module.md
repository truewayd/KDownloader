# MEGA queue integration and independent Go module updates

- Route public MEGA file tasks through the existing aria2 queue for ciphertext
  transfer, concurrency, speed limits and HTTP range recovery. An independent Go
  process resolves metadata and verifies/decrypts the completed file.
- Preserve pause/restart intent, journal verified publication, reject damaged
  ciphertext and output collisions, and reclaim staging after durable completion.
- Bundle the baseline executable for first-run use without SDKs, application
  keys or an additional runtime. Add signed independent module releases and an
  update check in Settings, with health verification and baseline recovery.
- Public folders, CloudRAID, account downloads and hashcash remain unsupported.
  Local queue, recovery and signed-activation tests pass; published update
  acceptance still requires the repository's publisher signing secret.

## Verification

- Real aria2 queue download and interrupted-transfer recovery; official SDK MAC
  vectors, corrupt-input rejection and signed module activation/fallback tests.
- Go test suite, Windows native compilation and settings browser checks.
- Published independent updates remain unverified until the signing secret is
  configured; native macOS/ARM execution is not covered by local cross-builds.
