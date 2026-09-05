# KDownloader 1.2.3: consistent controls and feedback

- Keep the popup at 360px wide and make overflowing panels scrollable so history actions remain reachable.
- Unify selects, keyboard focus, disabled/hover behavior, busy cursors and accessible state, readable light-theme text, and shared progress visuals.
- Use a shared native-dialog confirmation with localized actions, Escape/backdrop cancellation, and focus restoration for settings operations.
- Display persisted normalized settings after saving and retain success/error feedback. Blank numeric fields use their displayed defaults.
- Improve contrast of injected status controls and external links in both color schemes.
- Includes the preceding project-audit fixes for history metadata, serialized configuration/secrets, creator fetch errors and links, and reliable batch completion.

## Verification

```text
npm run ui:check
npm run version:check
npm test
npm run build
```

Browser fixtures exercise popup scrolling, settings controls and confirmations,
light/dark themes, keyboard behavior, and responsive layouts. The installed
Chrome does not allow loading an unpacked extension through its automation flags;
the real Chrome action popup remains a manual check.
