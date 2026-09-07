# Recoverable native bundle updates

- Numbered Windows native packages stage a schema-2 release manifest covering
  the shell, core, CLI and notices. Platform, protocol, archive and per-file
  integrity must all match. Legacy single-executable stages are never applied.
- Prepare the entire previous/candidate file sets before replacing any file.
  Keep a recovery marker until the native main window and its matching core
  acknowledge the expected build. Failed startup restores the whole previous set.
- Delegate interrupted updates before CLI/profile startup; repeated recovery is
  safe after partial replacement or rollback. Engines, settings and downloads
  remain outside the application replacement set.
- Keep standalone cores under their external package owner. The first migration
  from a legacy package requires installing the complete native package.

## Verification

Go tests cover strict release binding, corrupt/duplicate/traversal
archives, transaction boundaries and every partial replacement prefix. Go vet
and Rust clippy pass. Real hidden WebView2 packages pass successful upgrade,
expected-build health failure/rollback, and interrupted replacement recovery;
all application hashes and unchanged aria2 are checked. Native release packaging
and macOS runtime acceptance remain separate integration work.
