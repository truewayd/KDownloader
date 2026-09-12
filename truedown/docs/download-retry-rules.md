# Download names, partial files, and retries

## Output identity

An HTTP task owns one output path. TrueDown chooses its name from the caller's
filename, a resolver's verified filename, or a sanitized URL filename, in that
order. The fallback is `download`. Once admitted to the engine, that path remains
fixed across failures, retries, pauses, restarts, and refreshed resolver URLs.
An already numbered caller filename is preserved; retry never adds another
suffix to it. Ordinary unnamed HTTP downloads pin the URL-derived name before
submission instead of letting response headers or the engine rename the file.

Only new tasks allocate collision suffixes: `photo.png`, `photo(1).png`, and so
on. Both filesystem entries and other task records reserve names. A foreign
`.aria2` file also reserves its corresponding payload name, including dangling
symlinks. A not-yet-started task can choose another name if a collision appears
while it is queued. Exhausting the bounded name search produces an error.

Each reservation includes the payload and its `.aria2` control file before
either exists. For example, `file.bin` and `file.bin.aria2` cannot be reserved by
different tasks at the same location. Relative and absolute directory spellings
share the same reservation. If older records overlap, recovery and cleanup fail
without deleting either task's data.

## Retry behavior

Retry and Retry all execute immediately, without an additional confirmation.
The manager still validates output ownership and the payload/control-file pair
before any required clean restart. Removing an unfinished task requires a
separate native confirmation window in the desktop app; the HTTP dashboard
uses its page dialog.

| Situation | Behavior |
| --- | --- |
| Failed HTTP task with usable payload and `.aria2` map | Resume at the same path; keep downloaded pieces. |
| Owned payload without `.aria2`, including a file already at its expected size | Remove only that task's incomplete payload and start again at the same path. Sparse/preallocated file length cannot prove completeness. |
| Orphaned `.aria2` for an owned task with no payload | Remove the unusable map and start at the same path. |
| Invalid HTTP range or incompatible piece length | Persist a clean restart, then remove the owned payload/map before resubmission. |
| Engine rejects a demonstrably corrupt HTTP map | Report damaged resume state; Retry starts the same file from zero. |
| Add the same failed request again | Reuse its task and normal retry behavior. |
| Add the same completed request again | Check remote modification conditionally. An unchanged response retains the file; replacement downloads start from zero. |
| A completed-file refresh is interrupted | Its next retry follows partial-download rules, including after application restart. |
| Resolver metadata no longer matches a recorded name, size, or digest | Fail before cleaning or resuming old data. Correct the source request before retrying. |
| Engine result cannot be retired | Keep the previous GID and partial files; do not start another writer. |
| Directory, symlink, path mismatch, or another task owns the cleanup target | Fail and preserve the conflicting data. |
| BitTorrent | Preserve native payload layout and engine integrity/resume behavior; HTTP cleanup never deletes a torrent tree. |

Retries are bounded by the configured engine retry settings. TrueDown does not
create an automatic loop of clean restarts. A failed transfer remains actionable
until the user retries it. Pausing and closing the application retain resumable
files; a task is complete only when the engine reports successful completion.

Incomplete HTTP downloads continue to use their recorded filename alongside
the `.aria2` map. They are not usable completed files merely because they are
visible in the download directory. Do not rename or replace either file while
the task is running.

## Persistence and failure boundaries

SQLite record schema 7 adds `transfer_state` and `previous_gid`. The transfer
states are `pending`, `resume`, `restart`, and `recheck`. New output ownership is
committed before engine submission, and a failed database write does not publish
a replacement filename or start the engine. Clean-restart intent survives queue
waits and process restarts. The old GID is retained until its result can be
removed; subsequent retries cannot forget a still-running writer. Queued work
also carries its expected GID so older work cannot apply stale recheck intent.

Existing records retain their stored output path and migrate to resume state.
HTTP recovery checks direct child paths and validates the entire payload/control
pair before deleting either entry. Resolver preparation finishes and verifies
metadata before cleanup. Actual file deletion can still fail, for example if
another process locks the file; the task remains failed and can be retried after
the cause is resolved.

The engine sometimes returns only a generic error for a damaged `.aria2` file.
For stopped HTTP tasks, TrueDown checks the known control layout with fixed-size
reads, seeks over bitmaps, and at most 4,096 partial-piece records. I/O errors and
unrecognized future layouts are left for engine diagnosis. This is a structural
check, not a content hash. End-to-end integrity still depends on checksums or
stable remote metadata supplied by the server.

The underlying resume and overwrite options are described in the
[official aria2 manual](https://aria2.github.io/manual/en/html/aria2c.html).
TrueDown reserves those options so custom arguments cannot silently enable
automatic renaming, discard piece maps, or overwrite another output.

## Existing numbered leftovers

Retry repairs only the output recorded for that task. Old sibling files such as
`photo(1).png` and `photo(2).png` may belong to different downloads, contain useful
partial data, or be complete files. TrueDown never deletes them by a naming
pattern. Verify the task's recorded path and a successful replacement before
manually removing an old leftover. Files detached from all task records cannot
be safely assigned to a task by their names alone.
