# Native HLS and DASH downloads

- Accept ABDM browser/headless HLS requests durably and preserve initial pause
  intent. Older engines retain visible waiting tasks with a native notice; mixed
  HTTP tasks continue, and selecting NEXT 3 resumes normal media admission.
- Add explicit HLS/DASH, MP4/MKV and live duration controls to New download.
- Delegate track selection, fragments, muxing, native resume and media-cache
  deletion to NEXT. Failed media retries retain the same GID and cached segments.
- Show duration-based progress and an explicit finish-and-save action for live
  recordings. Preserve completed outputs when removing task records.
- Keep browser credentials scoped by the native engine to their source origin.

## Verification

- Real NEXT 3 HLS/DASH output decoded against generated reference frames; both
  audio and video streams verified using developer-only FFmpeg/ffprobe.
- Real failed retry, pause/restart, cache deletion, paused live finalization,
  cross-origin credential isolation and typed browser/headless admission tests.
- Go, JavaScript and native permission regression tests; browser form checks.
