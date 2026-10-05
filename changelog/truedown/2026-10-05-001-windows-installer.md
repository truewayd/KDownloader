# Windows installer distribution

Windows users should download `TrueDown-build-N-windows-amd64-setup.exe`.
Setup installs for the current user, adds shortcuts and uninstall registration,
includes the shell, core, CLI, stable aria2 and notices, and downloads WebView2
when missing. English and Simplified Chinese follow the system language.

Exit TrueDown before reinstalling or uninstalling. Existing default-profile
settings and downloads remain separate from the packaged files. Portable-profile
users should launch the installed app with their existing explicit data directory.

Build 94 is the one-time migration bridge: it also includes the old ZIP and
schema-2 manifest so existing clients can upgrade. From this version onward,
automatic updates download the setup executable with a schema-3 manifest. The
installer's restricted update mode stages only the verified application files;
existing transactional health checks and rollback preserve engines and profiles.
Later releases publish no Windows ZIP. Users who skip the bridge and remain on
an older client must manually install a newer setup once.

## Verification

Release validation requires seven bridge assets and five assets afterward. Disposable
hosted Windows CI checks installation and reinstallation against the validated
package hashes, installed native startup, and uninstall with unrelated data
preservation. Local installer compilation and regression results are reported
separately from hosted lifecycle acceptance.
