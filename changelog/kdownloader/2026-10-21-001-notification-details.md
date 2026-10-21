# System notification details

- Draw independent error, warning, information, announcement and success indicators from rounded teal and pale color blocks, using the original logos' gradients and soft shadows. The shared SVG source drives system notifications and application indicators. Download failures, verification/fallback prompts and Watch activity select their business variant; avatar failures retain that purpose before the final brand fallback.
- Simplify error and success to two intersecting or joined blocks in teal and pale tones. Warning keeps an open triangle with its pale block on the left; information uses a pale dot and teal stem; announcements use a rounded speech bubble and pale tail. Preserve subtle gradients and shadows without extra interior marks.

- Share notification presentation across download failures, backend fallback confirmations, Pawchive verification and Watch. Use the bundled 128px icon, KDownloader attribution and a consistent creation timestamp.
- Preserve Watch creator avatars and retry a failed avatar notification once with the bundled icon. Notification failures leave Watch check results and stored baselines intact.
- Open Pawchive verification from the notification body or its action button, clearing the notice after opening succeeds. Failed notification creation permits another attempt without the success cooldown.
- Keep backend fallback behind its explicit confirmation buttons, with batch aggregation, cancellation suppression and sanitized download messages unchanged.

## Verification

- Automated notification, Watch, Pawchive, download RPC and native-fallback regression tests; extension build and shared-UI consistency check.
- Real Chrome/system notification appearance requires separate manual verification.
