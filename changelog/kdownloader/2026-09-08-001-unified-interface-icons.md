# KDownloader 1.3.1

The extension and TrueDown now generate their interface icons from the same
pinned Lucide source. Existing icon IDs and the TrueDown brand artwork remain
stable; vector icons stay sharp at high display scales. The build includes
the source library's ISC and Feather MIT notices inside the generated sprite.
Input placeholders also retain readable contrast in both themes, using the
same shared tokens as TrueDown.
The popup also keeps every action reachable in short display work areas by
allowing root scrolling after its content scroller reaches the end, while
preserving its 360px width and automatic initial height.

## Verification

Verification covers symbol references, matching shared shapes, deterministic
generation, component synchronization and the extension clean build.
Real Chrome action-popup acceptance also covers light/dark icons and
placeholders, short and normal work areas, wheel scrolling and keyboard focus;
the extension settings page is checked at desktop and narrow widths.
