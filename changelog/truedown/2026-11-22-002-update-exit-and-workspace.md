# Windows update restart and workspace controls

- TrueDown listens for core shutdown during desktop startup. A replacement whose main window fails to initialize closes its core and shell so the updater can roll back. The helper preserves its recovery journal if it cannot confirm that the replacement exited.
- Dragging a task heading near either pinned column scrolls the data columns. Selected tasks retain their highlight when hovered and have a visible mark beside the checkbox.
- Settings search follows language changes immediately. The update card and manual check distinguish a failed check, an available version and a restart in progress.
- Narrow task tables pin the primary action and a More task actions menu so filenames remain readable. Wide tables have larger action targets. On pointer devices, inactive sort arrows appear when hovering or focusing the heading.
- Settings marks the active category with an accent. Keyboard users can move between search results and jump to the matching control. Confirming text with an input method keeps the search open.
- Task details preserve the original filename and raw error message when switching languages, including for media and application update tasks.
- Dragging a task column, file group or module shows its name beside the pointer and marks the insertion edge. Collapsed navigation keeps the name visible. Column resizing shows the live width. Escape cancels reordering, restores a resized column or returns a panned image to its starting position.
- The main workspace and New Download window highlight incoming links and torrent files. The native file-hover hint distinguishes a single torrent from unsupported files before release.
- Sidebar and column sorting now use the same drag component for pointer and keyboard input. A second pointer cannot take over another drag, and releasing a cancelled drag over its source no longer activates that item.

## Verification

- Windows acceptance exercises manual and automatic restarts, incompatible builds, a main document with scripting disabled, and interrupted rollback. It checks the installed file hashes and confirms the update helper has exited.
- Browser tests cover narrow table edge scrolling, selection, language switching, light and dark settings layouts, and failed update feedback.
- Browser and native-menu bridge fixtures check the compact row actions, keyboard activation and focus restoration. Settings and task-detail fixtures check result navigation, input-method composition and literal filenames.
- Chromium fixtures exercise insertion marks, compact rails, cancellation, live sizes, image panning and drop feedback. Native hover listeners are exercised with a bridge fixture and the Windows shell is compiled against the locked Tauri runtime.
