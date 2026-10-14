# TrueDown browser header reference

- Add the pinned AB Download Manager Browser Integration source and its complete
  original Apache-2.0 notice to the About inventory, identifying its role as a
  reference for browser UA and URL-scoped cookie hand-off.
- Preserve the generic HTTP backend and its existing header override path.
  Pawchive verification and media identity choices remain in the extension.

## Verification

- Native HTTP fixtures verify the supplied UA overrides the configured engine
  UA, an omitted override retains it, and a synthetic cookie reaches the server;
  both aria2 1.37.0 and NEXT 3.0.1 pass.
- Full JavaScript and Go suites, Go vet, shared UI and original notice checks.
- Windows package/core/CLI startup and WSL Linux tests/startup passed locally.
