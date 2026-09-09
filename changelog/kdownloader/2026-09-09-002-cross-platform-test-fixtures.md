# KDownloader - Cross-platform release-test fixtures

- Resolve temporary test directories to physical paths before exercising release
  helpers, so macOS's `/var` alias does not reject valid changelog fixtures.
  Intentional product-directory and ancestor links remain forbidden.
- Add a regression that runs the real release-note tests through a temporary
  directory alias. Cross-platform repository jobs explicitly use Node 22.
  Extension behavior and product version 1.6.3 are unchanged.

## Verification

- Release workflow tests include a reproduced-then-fixed temporary alias failure
  and retain the product-boundary, symlink and junction checks.
- Full Node suite (317 tests), Python migration suite (13 tests), shared UI
  consistency, extension build and changelog selection pass. Native macOS CI
  has not yet run this change.
