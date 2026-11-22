# Desktop updates, dragging and large task lists

- During an application update, the desktop shell follows core shutdown through startup and checks that the replacement main window is ready. If startup fails, the updater waits for the replacement to exit before rolling back.
- Windows now uses Aria2 NEXT 3.1.1 for the NEXT engine option. Failed HTTP retries start with a fresh engine task after the previous result and checkpoint have been retired.

- Sidebar categories, modules, task headings, column resizing and image panning share pointer ownership and frame scheduling. A release outside the window frees the gesture. External drop feedback resumes after browser back navigation.
- Media progress, recording time and engine requirements refresh in the task table. File actions use the selected language and preserve literal filenames. Custom category names remain readable in the sidebar, task rows and filtered heading.
- Clearing a selection releases its offscreen links and statuses immediately. Batch operations discard each processed response after recording its counts. The toolbar identifies selections that include tasks outside the loaded rows.
- Unchanged sidebar notices preserve their translated text and live announcements. Hidden tooltips stop observing document mutations. Open settings pickers observe their options and anchor path and dismiss when their control becomes unavailable.

## Verification

- Chromium exercised both themes, keyboard and pointer ordering, narrow and expanded rails, window-edge release, resize cancellation and cached-page drop feedback. Thirty pointer moves in one frame produced one column layout.
- The selection regression covers 50,000 entries. The optional viewport memory check repeatedly selects and clears 2,400 tasks, scrolls across pages, dismisses pickers and cancels drags. It checks retired DOM nodes after garbage collection and summarizes a renderer heap snapshot.
- Windows verified helper exit after manual and automatic updates and three rollback scenarios. The separate window smoke test isolates its download directory and automatic-update preferences, checks task creation and core recovery, and opens task details at a desktop viewport.
