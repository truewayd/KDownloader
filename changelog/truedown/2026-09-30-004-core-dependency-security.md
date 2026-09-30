# TrueDown core dependency maintenance

- Raise the build toolchain baseline from Go 1.26.4 to Go 1.26.8, including
  CI and packaging jobs that resolve their toolchain from go.mod.
- Update golang.org/x/sys to v0.48.0, modernc.org/sqlite to v1.60.1 and its
  modernc.org/libc dependency to v1.77.1; refresh the verified module checksums.
- Preserve the Windows SQLite implementation and the existing CGo-free Unix
  storage implementation.

Go release history: https://go.dev/doc/devel/release

## Verification

- Go 1.26.8: `go test ./...`, `go vet ./...` and `go mod tidy -diff` pass.
- Go module checksum verification passes; the Go 1.26.8 vulnerability scan
  reports no vulnerabilities on Windows.
- OSV review covers the resolved Go module graph and Go 1.26.8 standard library.
- WSL Linux tests with native aria2 and the CGo-free SQLite storage pass;
  standalone core smoke checks confirm storage, tasks, instance and exit behavior.
