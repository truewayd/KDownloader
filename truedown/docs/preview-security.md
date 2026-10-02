# Download preview security boundary

Reviewed: 2026-10-02. Previewed bytes and filenames are untrusted, even for completed downloads.

## Scope and threat model

Protect against malicious downloaded content, forged WebView arguments, path escapes, linked
files, ordinary replacement during reads and oversized media. Preview is a viewer, not a malware
scanner or an OS sandbox for applications launched by the user. A compromised OS/WebView codec,
administrator-controlled mount or process already running as the same user remains outside this
boundary. Header checks reduce resource abuse; they do not prove arbitrary codec input harmless.

## Native isolation

- The singleton `task-preview` has its own capability: event listen/unlisten only. It cannot enumerate
  other windows, read the clipboard, open settings or use filesystem/shell plugins.
- The Rust dispatcher admits only preview state, current-file requests and its own frame/material
  commands. The API role permits `GET /tasks/preview` and fixed file/directory/Windows chooser actions.
  Every request must carry exactly one ID matching the currently open native preview target.
- Only the packaged preview document may navigate. New windows, remote documents, `file:`, `data:`
  documents and blob navigation are rejected. Configuration plus page CSP excludes frames, objects,
  active downloads, forms, workers and external media/network resources. No downloaded content gets
  an executable document or an IPC bridge.

## Files and integrity

- The client supplies a task ID and aligned byte offset, never a path. The core derives the exact
  basename from a completed manager-owned task and revalidates the task after reading.
- Windows retains no-delete/no-write handles along the whole local-drive path, rejects reparse
  points, device/UNC/alternate-stream paths and executable signatures, then opens the held file.
  Unix walks components with descriptor-relative `openat`, `O_NOFOLLOW` and nonblocking final opens.
  Both readers reject hard links and non-regular files. No validate-then-follow-symlink fallback exists.
- Two concurrent reads maximum; each response contains at most 512 KiB before base64 encoding.
  Files are limited to 64 MiB and text to 2 MiB. Metadata versions and before/after stat checks reject
  ordinary changes. The first read hashes the full bounded file; the frontend verifies the assembled
  SHA-256 before handing any content to a decoder. This is consistency checking, not an authenticity
  signature. A process able to rewrite task files and metadata as the same user is not a trusted signer.

## Rendering and resource limits

- PNG, JPEG, GIF, BMP and static WebP: extension must match the content signature. Inspect dimensions
  before decode, cap each image at 8192 pixels per side and 16 megapixels. PNG/GIF container walks are
  bounded; animations permit at most 200 frames and 64 megapixels of cumulative canvas work.
  Embedded/compressed BMP payloads and animated WebP are refused.
- JPEG header inspection is limited to 1 MiB. RIFF/PNG chunk lengths and GIF subblocks must stay inside
  the bounded input; complex/truncated containers fail closed. These checks allocate no pixel buffers.
- MP4/WebM and MP3/WAV/Ogg/FLAC/M4A use signature-checked, blob-backed native media controls without
  autoplay. Decoder availability varies by OS. Unsupported codecs remain an ordinary preview error.
- UTF-8 text, JSON, XML, CSV, Markdown and logs render via `textContent`, with no HTML or Markdown
  evaluation. HTML, SVG, PDF, AVIF, scripts, executables and unknown formats have no embedded viewer.
- Images have no drag payload. Hiding, switching tasks or unloading aborts reads, pauses/unloads media,
  clears DOM content and revokes blob URLs. The only way to launch another application is an explicit
  file action. Windows Open with uses `SHOpenWithDialog` through a fixed, bounded, parent-verified
  helper and the same data-file guard as Open; callers cannot choose a program, verb or argument.

## Verification

Go tests cover unfinished/missing/oversized/changed files, aligned chunk bounds, full digest,
symlinks/hard links, MIME spoofing, malformed/truncated PNG, image bombs and GIF animation budgets.
Rust tests cover preview role, command and current-target restrictions. Browser tests cover literal
hostile text, tampered chunks, stale targets, resource cleanup, fit/zoom and narrow layouts. Windows
hidden acceptance exercises a real downloaded file, permission denials, hide/reopen and native IPC.
Visible chooser interaction and adversarial OS decoder exploitation are not established by these tests.

## Primary references

- [Go traversal-resistant file APIs](https://go.dev/blog/osroot): path validation alone does not close symlink races.
- [Go image security considerations](https://pkg.go.dev/image#hdr-Security_Considerations): inspect dimensions before decoding untrusted images.
- [WebP container specification](https://developers.google.com/speed/webp/docs/riff_container): RIFF chunk and image/canvas layout.
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/): separate capabilities by WebView access needs.
- [Tauri security model](https://v2.tauri.app/security/): native IPC boundaries and reliance on updated system WebViews.
- [SVG image contexts](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image): image-context restrictions do not apply to embedded active documents.
- [Windows SHOpenWithDialog](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenwithdialog): explicit native application chooser.
