# Task list performance

The task list separates data scheduling from its bounded 100-row DOM window.
The implementation stays in classic JavaScript and adds no runtime dependencies.

## Design references

- [TanStack Virtual](https://tanstack.com/virtual/latest/docs/api/virtualizer): stable item keys and bounded overscan.
- [TanStack Query prefetching](https://tanstack.com/query/latest/docs/framework/react/guides/prefetching): populate nearby query caches before navigation, bound freshness, and tolerate speculative failures.
- [web.dev layout guidance](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing): avoid geometry reads immediately after repeated DOM writes.

These are design references, not imported libraries. The inherited native pipe
uses a bounded long-poll request for change notification, rather than adding a
second socket transport or granting new permissions to auxiliary windows.

## Data flow and bounds

`aria2 -> Manager snapshot -> change waiter -> current page -> keyed rows`

Engine sampling remains one second. `GET /tasks/changes?after=revision` wakes on
Manager revisions or returns after ten seconds. There is one frontend waiter and
at most eight API waiters; a twelve-second native task-read deadline sits inside
the existing fifteen-second frontend GET deadline. Failed waits use the existing
2.5-second active polling fallback. Successful waits coexist with ten-second
recovery polling. Notification bursts have a 100ms resubscribe delay.

The page store retains at most eight bodies and 1,048,576 serialized UTF-16 code
units, plus at most two foreground responses and one speculative response in
flight. Only the latest unsent foreground request is retained. Same-page requests
share work. Native requests retain their slots until completion; abandoning a JS
promise is not treated as canceling native work. Navigation, hiding and successful
mutations invalidate old generations and drop unsent work.

The viewport prefetches one 40-row step in the scroll direction. Cache entries
expire after ten seconds; a viewport can display a retained page immediately and
revalidate it. Entries younger than 500ms need no additional viewport read.
Rendering stays bounded to 100 real rows and two noninteractive spacer cells.

## Coherence

- Core epoch prevents reuse after a core restart.
- Global revision covers all task/overview changes and wakes waiters.
- Order version covers task membership/status, searchable names/links, groups,
  and all revisions when sorting by progress. Newer incompatible order versions
  evict cached ranges; late incompatible responses cannot restore them.
- Row version covers ordered task IDs and their revisions. A matching retained
  body permits an overview-only response (`rowsUnchanged: true`).
- ETags are always stored/evicted with their body. A 304 cannot invent page data.
- Current route, query and load generation gate rendering independently of caching.
- Cached overview values never replace a newer accepted overview.

Row controls retain ID identity, focus, selection and pending actions. Nodes are
looked up once per row shape, unchanged task revisions skip dynamic updates, and
placeholder geometry is remeasured only when layout, theme or row shape changes.

Program updates and engine switches cancel and drain read-only task-change waits
before applying; other active requests retain their admission protection. This
prevents a continuous notification subscription from starving automatic updates.

## Verification

- `node --test tests/taskData.test.mjs tests/frontendAudit.test.mjs tests/dashboardUi.test.mjs`
- `npm run test:viewport` in `truedown/desktop`: 2,400 tasks at 1200/960/390px,
  latest-position rendering while an old request is blocked, notification latency,
  cold-cache placeholders, return navigation, row identity and reduced motion.
- `go test ./internal/downloader ./internal/api`: wakeups, cancellation, versions,
  API bounds and global category sorting/pagination.
- `go test ./internal/downloader -run '^$' -bench 'Benchmark(PageTaskSnapshots|CategoryPage)' -benchmem`

Browser timing fixtures exercise the production UI with a synthetic transport;
they do not measure packaged WebView IPC or live engine end-to-end latency.
