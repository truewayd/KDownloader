# KDownloader 3.3.1

- Choose the existing site UA, the current browser UA, or the download backend's
  own default UA for media requests. Cookie forwarding is independently optional
  and remains enabled by default.
- Read cookies for each trusted media URL, including the source tab's cookie
  store and first-party partition. Preserve cross-site restrictions and the
  header-size bound; cookie values are not saved in settings.
- Keep Pawchive API verification and its document-start bridge unchanged.
- Compare the generic hand-off with ABDM Browser Integration and include its
  original Apache-2.0 notice and source reference in the About inventory.

## Verification

- UA/Cookie combinations for ABDM and Gopeed; configuration migration, partial
  saves and reset; exact-URL/store/partition lookups and Pawchive bridge guards.
- Full JavaScript suite: 425 passed, one intentional skip; 13 history migration
  tests, shared UI and notice integrity checks passed.
- Isolated settings preview at desktop and 390-pixel widths in light/dark themes;
  saved values survive reload and backend switching. The Chrome connector was
  unavailable, so this does not claim installed-extension UI acceptance.
- Native header fixtures pass on aria2 1.37.0 and NEXT 3.0.1; Windows and Linux
  core tests and packaged startup checks pass.
