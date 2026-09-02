# Windows application icon

- TrueDown now embeds its product logo as a multi-size Windows executable icon,
  so Explorer, shortcuts, and process surfaces no longer show the generic
  application icon.
- The release build verifies the icon after linking, while normal builds remain
  independent of icon-generation tools and network downloads.

## Verification

```text
cd truedown
go test ./...
go vet ./...
pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1
```
