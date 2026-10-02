# Custom download preview controls

- Replace browser audio/video controls with TrueDown-styled playback, seek/buffer progress, time, ten-second steps, volume/mute, speed and video fullscreen.
- Give audio a centered music identity and filename, video an unobstructed canvas with separate controls, and text a reading surface with optional line wrapping. Hide irrelevant image zoom actions.
- Keep Mica window surfaces, light/dark/high-contrast support, keyboard controls and responsive layouts. Release event listeners, fullscreen and media when the preview closes or changes.
- Preserve the existing file/integrity/CSP/IPC boundary and system decoding; no new native permissions, dependencies or autoplay.
## Verification

- Browser regression covers real audio playback, seeking, keyboard isolation, volume, rate, video fullscreen, narrow layouts and cleanup, alongside existing preview security checks.
- Windows WebView2 acceptance downloads real PNG, text, WebM and WAV fixtures, checks custom play/pause, volume and speed, and captures light/dark and 620px layouts. Native build, icon/shared UI checks and release-note regression passed. Captures use the reduced-transparency fallback; visible Mica composition and native fullscreen are not established by hidden captures.
