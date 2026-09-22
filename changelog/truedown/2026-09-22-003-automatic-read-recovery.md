# TrueDown automatic read recovery

- Remove redundant refresh and reload controls from tasks, settings, logs, task details and file groups.
- Retry failed settings and native new-task reads automatically with bounded backoff; pause recovery while hidden and cancel obsolete view retries.
- Keep existing tasks and logs visible during disconnects and clear the inline connection status after recovery.
- Preserve form drafts and reconcile task/group revision conflicts without replaying saves or task submissions.

## Verification

- Verify offline startup, automatic recovery, retained drafts, conflict reconciliation and cancellation in unit and browser acceptance tests.
- Windows hidden native acceptance covers core recovery, auxiliary windows, draft retention and cleanup.
