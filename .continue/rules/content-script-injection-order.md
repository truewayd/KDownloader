---
globs: manifest.json
description: Prevents ReferenceError due to injection order and keeps content
  bundle predictable.
alwaysApply: false
---

Always list content scripts in manifest.json in this order: content/helpers.js, content/ui.js, content/download.js, content/actions.js. Do not include content.js (entry) unless it is needed. Ensure later scripts only depend on globals defined by earlier scripts.