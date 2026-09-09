# Reviewed dependency patches

These four crates are copied from the exact crates.io archives recorded in
`patches.json`. Their original versions and license notices are retained.
The manifest records every source file hash and every deviation from the
original archive. `node truedown/tools/verify-native-patches.mjs` verifies the
complete source trees before native license generation and release builds.
Do not edit the Cargo registry cache or suppress advisories globally.

- `glib 0.18.5`: backport the mutable FFI output pointer fix from
  https://github.com/gtk-rs/gtk-rs-core/pull/1343 for RUSTSEC-2024-0429.
  Tauri's GTK3 stack requires GLib 0.18. A version-only scanner can still flag
  this version; the reviewed source contains the fix. Run the Linux regression
  with optimization: `cargo test --locked --release --test dependencies`.
- `glib-macros 0.18.5` and `gtk3-macros 0.18.2`: rename their dependency to the
  maintained `proc-macro-error3 3.1.1` with `syn2-error`, retaining the existing import name and
  providing the absolute crate name used by its attribute expansion.
  This removes `proc-macro-error` and its deprecated helper from the graph.
  The earlier replacement `proc-macro-error2` is also unmaintained and is not used.
- `urlpattern 0.3.0`: replace `unic-ucd-ident` with `unicode-id-start 1.4.0`,
  retaining ID_Start/ID_Continue semantics and the URLPattern-specific extra
  characters. This removes all five unmaintained UNIC crates. Unicode data
  follows the maintained replacement. Tests cover non-ASCII group names,
  ID versus XID distinctions, invalid names and route/origin boundaries.

Only the normalized build manifests are patched. `Cargo.toml.orig` remains
the original published source for reference. These are local compatibility
patches, not new upstream releases. Remove them when Tauri's resolved graph
contains the upstream fixes and maintained replacements. GTK3 itself remains
an upstream platform constraint; this patch set does not migrate it to GTK4.
