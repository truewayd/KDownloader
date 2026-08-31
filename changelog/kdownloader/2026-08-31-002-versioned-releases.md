# Add explicit KDownloader release versions

- Raised the KDownloader product version from the long-lived `1.0.0` placeholder to `1.1.0`.
- Made `manifest.json` the single source for the three-component product version and added a reusable version validator.
- Added the GitHub run number as the fourth Chrome version component in release builds so every published package has a monotonically increasing update version.
- Included the product version and build number in KDownloader archives, artifacts, tags, release titles, and the staged manifest display name.
- Made the two-source history identity contract explicit: Kemono, Coomer, and Pawchive may never fork away from `default`, while only CoomerFans uses `coomerfans`.

## Verification

- `npm run version:check`
- `npm test`
- `npm run test:python`
- `npm run build`
