# TrueDown - Payload and control-file ownership

- Reserve each HTTP output and its `.aria2` control file as one pair, including
  before files exist and during batch submission.
- Resolve relative directory reservation keys to absolute paths so equivalent
  directory spellings cannot reserve the same output twice.
- Reject overlapping older task records before recovery or cleanup, preserving
  both files instead of touching another task's data.
- Retain the existing record schema, request identity, and file locations.

## Verification

Regression tests cover both collision orders, single and batch
submission, legacy recovery/cleanup, and relative/absolute directory aliases.
The Windows Go suite with real aria2 integration passes.
