# Window opening surface readiness

- Keep main and auxiliary windows hidden until the document and native material initialization are ready, avoiding the initial solid-to-Mica background flash.
- Wait for material initialization before showing native confirmations, including prepared confirmations.
- Preserve retained auxiliary documents and shell material restoration. Material failures still use solid surfaces; background startup no longer shows the main window before hiding it.
