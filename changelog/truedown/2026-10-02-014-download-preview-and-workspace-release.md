# TrueDown download preview and workspace update

## Changes

- Add an independent, resizable download preview for images, UTF-8 text, audio and video, with Open, Windows Open with and Open directory actions.
- Use TrueDown-styled media controls for playback, seeking, ten-second steps, volume, speed and video fullscreen. Adapt toolbars to the file type and provide text wrapping, image zoom and responsive layouts.
- Isolate preview permissions and file access; verify signatures, bounded media dimensions/animation work and complete SHA-256 before rendering. Refuse active documents and linked paths. Correct WAV MIME alias matching.
- Parse clipboard download links once when opening New download, preserving drafts and requiring explicit submission.
- Fix cancellation being misreported as confirmation initialization failure and settle native popup results before teardown.
- Add theme-matched empty-state illustrations, preserve task-list scroll height during selection, extend Mica across auxiliary/confirmation content and enlarge desktop icon artwork.
- Add global BitTorrent client identity for compatible NEXT engines while keeping HTTP identity independent.

## Verification

- Local JavaScript, Go tests/vet, Rust tests/Clippy, shared UI and generated icon checks passed; the WAV release-note format regression was corrected and its suite rerun successfully.
- Browser preview tests cover file integrity, inert text, media playback/seek/volume/speed/fullscreen, keyboard isolation, narrow layouts and cleanup.
- Windows hidden native acceptance covers task forms, cancellation-state handling, clipboard and preview permission boundaries, completed-file reads and reopen lifecycle. Real downloaded PNG, text, WebM and WAV samples render with custom media controls.
- Native desktop builds passed locally. Visible Mica composition, Explorer icon-cache refresh, native fullscreen and visible chooser interaction remain separate acceptance checks; media decoding still depends on the system WebView.
