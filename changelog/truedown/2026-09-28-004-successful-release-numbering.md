# TrueDown release numbering and settings spacing

- Derive the next build number from published TrueDown releases instead of workflow attempts. Failed builds and incomplete drafts reuse the next candidate without inflating the version.
- Serialize release workflows across refs and share one candidate across all packages, embedded identities, manifests and assets. Recheck before upload; reject stale reruns and conflicting tags, and replace only the unpublished candidate draft.
- Preserve every public release and its number, including when a post-publication visibility check fails.
- Unify settings panel spacing, remove nested padding from updates/modules, and collapse empty status rows above the program update panel.

## Verification

- Release-number tests cover repeated failures, drafts, pagination, public releases, stale reruns, tag conflicts and API failures.
- Release workflow contracts, full repository tests, settings light/dark and narrow-layout acceptance, and native package validation.
