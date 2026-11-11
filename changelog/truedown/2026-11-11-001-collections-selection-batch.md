# Collections, selection and batch operations

- Add a Telegraph resolver for ordered native images, video and audio using the official public page API. External media players are outside this first version.
- Preserve Google Drive resource keys throughout directory scans and file preparation. Retry transient directory failures, validate explicit next links, reject detected unsupported continuation, increase bounded collection capacity and retain safe failure diagnostics.
- Select all captures the current filtered task membership independently of the virtual viewport. Scrolling/sorting preserve selection; changing filters clears it. Offscreen links remain copyable, Ctrl/Cmd+A selects the filtered result and Escape clears selection from the task list.
- Submit selected mutations in bounded chunks with progress and no automatic replay. Batch ordinary aria2 pause requests and writer-settlement checks through authenticated multicalls. Avoid per-task engine-result retirement for completed ordinary removals, parallelize guarded active cleanup with four workers, and delete database rows in 256-ID statements within one transaction.
- Preserve update-task confirmations, completed output, conflicting ownership protection, torrent payloads and failure reporting.
- Default new downloads to the operating system's Downloads directory, honoring Windows Known Folder redirection and Linux XDG user directories while retaining profile layout compatibility.

## Verification

- Go regression coverage for offscreen filtered selection, Telegraph extraction, Drive resource keys and pagination, batched pause settlement and completed-task removal without per-record RPC.
- JavaScript regression coverage for 1,205 offscreen selections, obsolete responses, filter/viewport behavior and 2,405 selected removals split into bounded chunks.
- Full repository tests and Go static analysis; native Rust compilation and visible desktop acceptance require a configured native toolchain.
