# Native dependency notices

Native packages include the locked target's Rust dependency licenses and the
original Microsoft WebView2 SDK loader notice. Supplemental upstream notices
are pinned to each published crate's source revision and checked by SHA-256;
ordinary builds reject missing or changed notices instead of downloading replacements.

## Verification

Generated the inventories for Windows x64, Linux x64 and macOS ARM64. Verified
the bundled Windows static loader against the original WebView2 SDK NuGet package.
