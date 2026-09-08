# Settings, native captions, proxies and automatic updates

- Preserve the existing settings category order and open Download and speed by
  default. Remove the overview; put logs and About in the settings sidebar.
  Auxiliary log/about shortcuts now reuse the settings window. The main sidebar
  toggle has no background or border, with accessible focus feedback retained.
- Keep actual Windows/Linux caption buttons and macOS traffic lights. Application
  titles remain bounded; all working surfaces retain window-edge padding.
- Offer 26 common group icons through a keyboard-accessible picker and persist
  the selection alongside each group's editable suffix list.
- Rotate application logs daily or at 4 MiB, keeping at most three archives for
  seven days. The core runs hourly cleanup; the visible log category refreshes
  and follows the latest entry, with an option to stop following.
- Default download proxy mode to System; offer Custom HTTP(S) and No proxy.
  Retain legacy custom addresses. Apply the choice to direct downloads and
  Dropbox/Google Drive resolution, explicitly overriding inherited aria2 proxy
  variables for direct connections. Local RPC always stays direct.
- Advance product version to 1.5.0 and carry that version through the matching
  shell/core/CLI package. Keep monotonically increasing release build numbers
  for update selection. Correct unchecked/disabled/staged update status text.
- Add independent automatic NEXT updates for already installed Windows engines.
  Verify stable release architecture, checksum and executable version; skip
  equal/older releases. Apply only after the queue and in-flight requests drain,
  retain the previous verified engine on failure, and suppress retries of the
  same failed version. New profiles enable the preference; existing profiles
  retain manual updates until explicitly enabled. The engine choice is unchanged.
- Serialize automatic application with preference writes and allow 90 seconds
  for a complete updated shell/core/WebView health acknowledgement.

## Verification

Go tests cover real proxy transport routing, direct overrides, group icon
persistence, daily/expired log cleanup, NEXT version ordering, disabled checks,
verified staging, durable rollback and post-drain idle checks. Browser acceptance
covers settings categories at desktop/mobile widths in both themes, proxy drafts,
log following, icon selection and integrated About. Native acceptance checks
actual OS captions, one shared settings window, retained drafts and process cleanup.
Windows bundle acceptance passes manual and automatic replacement, health failure
rollback, and interrupted-install recovery with all windows hidden. The complete
file set updates together and the aria2 binary remains untouched. The matching
1.5.0 shell/core/CLI package passes startup and exit checks. Linux Go tests and
real aria2 task persistence checks pass in WSL; macOS native behavior remains for CI.
