# Validate public update discovery anonymously

- Match the updater's unauthenticated GitHub request when checking published release metadata. A repository token can expose assets that ordinary clients cannot yet see.
- Require the public stable release and all five uploaded assets; bound each request and retry. Keep authenticated access only for uploading and publishing.
- Includes the build 48 asset-endpoint fallback for clients upgrading from older versions.

## Verification

- Public metadata tests cover missing, duplicate, draft and prerelease entries. Workflow contracts reject credentials in the public verification step.
