# Windows packaging

Windows manual downloads use `TrueDown-build-<number>-windows-amd64-setup.exe`.
`build.ps1` compiles the native application, runs Tauri's NSIS bundler, then
stages the actual installer payload, stable aria2 and notices for update packaging.
Tauri temporarily changes the shell's bundle-type bytes during bundling. Read
the shell back through the installer's restricted staging mode so the update
manifest and bridge ZIP match its actual bytes. Resource checks verify the GUI subsystem, icon and DPI
manifest. Local development builds produce `TrueDown-dev-windows-amd64-setup.exe`.

Setup explicitly uses `currentUser`, with English and Simplified Chinese,
shortcuts and uninstall registration. It defaults to a user-writable location,
allowing the existing non-elevated updater to replace application files. WebView2
is downloaded when missing; offline installation without WebView2 is unsupported.
Product version comes from the root manifest, while the shell and sidecars retain
their matching numbered release identity. Reinstalling the same product version
is supported; automatic updates continue to compare release build numbers.

Exit TrueDown before installing over an existing copy or uninstalling. Uninstall
removes packaged files while preserving unrelated files, profile data and
downloads. Portable users with explicit or portable profiles must continue to
select that profile when launching the installed application. No automatic move
of an arbitrary portable directory is attempted.

`publish-truedown.yml` presents the setup link first. All seven bridge assets (five afterward) must
pass validation before publication. A disposable hosted Windows runner installs
and reinstalls into a path containing spaces, compares installed payload hashes,
runs native startup/CLI acceptance, and uninstalls while checking that unrelated
data survives. Developer machines do not run this registration-changing test.
Fresh-machine WebView2 bootstrap and interactive wizard appearance still need
separate acceptance; hosted runners normally have WebView2 already installed.

Bridge build 94 alone publishes `TrueDown-build-<number>.zip` with the schema-2
manifest for old clients. New clients accept only setup/schema-3 JSON, verify hashes and executable identity, and replace the application
transactionally with health checks and rollback. NSIS's restricted staging mode prepares only the five update-owned files without installation side effects. The bridge assets serve
existing clients once; later releases contain no Windows ZIP. Users missing the bridge must install a newer setup manually. Replacing
transactional replacement with full interactive installer execution would change rollback
and profile/engine preservation guarantees.

References: [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/)
and [Tauri updater](https://v2.tauri.app/plugin/updater/).
