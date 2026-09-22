# Windows packaging assessment

The current supported Windows release is a portable ZIP. `build.ps1` runs
Tauri with `--no-bundle`, stages the native shell, Go sidecars, stable aria2 and
notices, and checks executable resources. `publish-truedown.yml` archives that
directory and publishes a schema-2 update manifest. The Go updater accepts the
exact `TrueDown-build-<number>.zip` asset and replaces its verified files in place.

Tauri supports NSIS setup EXEs and WiX MSI installers. The existing bundle
configuration already declares the sidecars, notices, icon and Windows aria2
resource, plus WebView2 bootstrapper installation. It provides the inputs for
an NSIS bundle, but the production build and acceptance workflow currently
skip installer generation. A setup EXE is not a drop-in update asset.

For ordinary Windows users, an additional per-user NSIS installer is preferable
for initial installation: it provides a stable writable install location,
shortcuts, uninstall registration and WebView2 setup. Keep the portable ZIP
and current verified self-update channel until installer-specific acceptance
has been implemented. A machine-wide Program Files installation would require
an elevation-aware update strategy; the current updater assumes it can write
beside the running application.

Before making an installer the default distribution, add:

- NSIS packaging with an explicit per-user installation mode and upgrade policy;
- matching product/build identities and an optional signing step;
- install, upgrade, uninstall and WebView2 acceptance in an isolated profile;
- complete sidecar/aria2/notice validation and installer release assets;
- an uninstall policy for profile data and profile-scoped startup registration;
- compatibility checks for in-place ZIP self-updates inside an NSIS install.

Replacing the ZIP update channel with installer-driven updates additionally
requires a new verified update manifest/installer protocol and migration for
existing portable installations. Merely changing `--no-bundle` to `--bundles
nsis` does not provide those behaviors.

References: [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/)
and [Tauri updater](https://v2.tauri.app/plugin/updater/).
