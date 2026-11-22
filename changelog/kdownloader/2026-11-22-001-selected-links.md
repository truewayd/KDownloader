# Selected link destinations

- The opt-in browser menu sends HTTP(S) links behind selected labels as well as visible URL text. A partial selection inside a link works. Duplicate addresses are sent once with their fragments intact.
- The extension reads the selection in the clicked frame using a temporary tab grant. Restricted frames retain the text-only handoff. The existing batch limits and backend setting checks apply.
- Extension confirmations and injected link dialogs now share keyboard focus handling with TrueDown.

## Verification

- Real Chrome exercised partial anchor selections, fragments, hidden links, selection changes, the action popup and settings at desktop and mobile widths.
- Node tests exercised clicked-frame targeting, deduplication, restricted-frame fallback, batch bounds and disabling the backend during a read.
