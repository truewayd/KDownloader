# TrueDown 1.6.0

- Replace the Windows title area with TrueDown's title strip while preserving real DWM caption buttons, resizing and native window operations. Keep the WebView outside the native caption hit regions.
- Remove the nested settings panel and give the settings content and save area one rounded background. Preserve category order and open Download and speed by default.
- Save new downloads under their file-group subdirectories: Pictures, Videos, Music, Archives, Applications, Documents, Projects and Other. Users can edit each group's safe subdirectory name; custom groups default to their name.
- Preserve existing task paths and request identity across group changes. Resolver names can select the final directory before output begins; collection downloads keep their hierarchy and BitTorrent payloads stay together.
- Verify all eight default directories with real aria2 downloads, plus native hidden-window, settings and group-editor acceptance.

## Verification

- `go test ./...` and `go vet ./...`.
- Real aria2 output-byte checks for all eight default subdirectories.
- `cargo test --locked` and `cargo clippy --locked -- -D warnings`.
- Settings, file-group editor, task-form and hidden Windows acceptance.
