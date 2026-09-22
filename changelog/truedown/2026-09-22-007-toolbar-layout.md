# TrueDown toolbar alignment and layout review

- Keep queue actions together on the left and align the download-directory icon independently at the right edge of the task toolbar.
- Let queue actions wrap inside their own space on narrow windows while keeping the directory action visible and separate.
- Keep the log-follow checkbox at the standard checkbox size and its label on one line.

## Verification

- Check task toolbar alignment, hit targets, overflow and keyboard focus at 1080, 820, 620 and 390 CSS pixels, in both themes and at 100%/200% scale.
- Review all settings categories, new-task forms and task details using the existing browser acceptance fixtures.
