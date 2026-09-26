# Animated sidebar and compact traffic status

- Animate sidebar expansion and collapse over 220 ms, including the desktop
  title-strip alignment, with immediate changes under reduced motion.
- Keep download speed on the left and downloading/error counts on the right
  in one row. Add a gauge icon beside the expanded speed.
- Show only the full speed in the collapsed traffic indicator. Use an 88 px
  desktop rail and an 80 px narrow rail to retain readable speed units.
- Preserve idle hiding and update-notice priority in every sidebar layout.

## Verification

- Browser checks cover active, stalled, high-speed and idle traffic, plus update
  checking, downloading, paused, queued, failed, ready and restart states.
- Check light/dark themes, expanded/collapsed/narrow bounds, animation midpoint,
  reduced motion, tooltip behavior and update recovery.
