# Shared controls and Aria2 NEXT 3.1.1

- Desktop context menus share action labels, shortcut hints, item rendering and keyboard navigation. The archive preview shares the standard busy-button state. Confirmation windows and task dialogs share focus handling with extension dialogs.
- Menus, select options, window captions, About links, toasts and notices render decorative sprite icons through the shared component runtime.
- The reviewed Windows NEXT engine is 3.1.1. It acknowledges shutdown before exit and can publish simultaneous same-title media streams under distinct filenames.
- The manager retains its owned-output cancellation and failed HTTP retry policies. Engine acceptance checks orphan checkpoint cleanup after restart, failed retries on preallocated files and same-title HLS outputs.

## Verification

- Real-engine Windows x64 acceptance used the published 3.1.1 binary, verified media frame hashes, checked native shutdown and retried an interrupted preallocated transfer.
- Chromium exercised modal focus, shortcut navigation, select menus, tooltips and the desktop menu bridge. Shared UI and native icon checks cover the corresponding menu actions.
