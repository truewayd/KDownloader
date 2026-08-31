# Fix creator-page download history states

- Restored the shared history namespace used by Kemono, Coomer, and Pawchive; only CoomerFans keeps a separate source identity.
- Made complete and empty history records render as a persistent check mark on creator and post pages.
- Made partial downloads render as a distinct, retryable warning state instead of appearing complete or reverting to idle.
- Kept complete records written under the short-lived Pawchive source regression visible as aliases of the shared history namespace.
- Added regression coverage for Pawchive sender validation, legacy history reads, batched status lookup, and creator-button state rendering.

## Verification

- `npm test`
- `npm run test:python`
- `npm run build`
