# Activity Pulse

The superuser-only activity dashboard at **https://flawchess.com/activity**:
rolling DAU/WAU/MAU, retention, the signup → import funnel, guest conversion,
bot games, Train sessions and imports. An internal analytics page, not a product
feature.

It is an ordinary page of the app — no separate server, no separate deployable.
It ships with the SPA and reads the production database in-process.

## Layout

| File | Role |
|---|---|
| `app/services/activity_queries.py` | Every SQL query, returning JSON-able rows, plus the `Payload` TypedDict |
| `app/services/activity_stats.py` | `build_readonly_engine()`, `build_payload()`, `StatsCache`, and the two tuning constants (`CACHE_TTL_SECONDS`, `PROMOTED_AT_SINCE`) |
| `app/routers/admin_activity.py` | `GET /api/admin/activity/stats`, gated on `current_superuser` |
| `frontend/src/pages/activity/ActivityPage.tsx` | React host: page shell, data fetch, Refresh button |
| `frontend/src/pages/activity/charts.js` | Chart toolkit: line, bar, grouped bar, funnel, sparkline. Classic script, not an ES module — the layout harness loads it via `vm.runInContext` |
| `frontend/src/pages/activity/render.js` | Render layer. Exposes `window.__fcApp.mount() → {update, destroy}` |
| `frontend/src/pages/activity/styles.css` | Stylesheet, every rule scoped under `.activity-dash` so it cannot leak into the SPA |
| `frontend/src/types/activity.ts` | TypeScript mirror of the `Payload` TypedDict |
| `frontend/scripts/check-activity-layout.mjs` | Headless layout harness — asserts chart geometry fits phone widths |

### The React / imperative seam

React owns the static shell, the fetch, and the Refresh button. `render.js` owns
the charts, and addresses the DOM by id (`#c-actives`, `#t-funnel`, `#conv-big`,
`#tip`, …) — renaming an id in the JSX silently drops a chart.

The audience segmented control is the one place the two meet: `render.js` binds
its own click listeners and owns `aria-pressed`. React's `onClick` there is a
deliberate no-op so the element is still a real `<button>` with a testid. Do not
lift that state into React — dual ownership of one attribute is the bug the seam
exists to avoid.

`ActivityPage.tsx` also injects the dashboard's three Google faces on mount and
removes them on unmount. That is load-bearing, not cosmetic: the layout harness
estimates text width from ratios calibrated against IBM Plex Mono and Source
Sans 3.

## Checking mobile layout

```bash
cd frontend && npm run check:activity-layout
```

Loads the real `charts.js` through a minimal DOM shim and renders every chart
with synthetic worst-case fixture data at 320/360/390/414px CSS-pixel viewports.
It asserts that every chart's `<svg>` fits within its container width (no
horizontal scrolling), that no text is clipped outside the chart, and that no
two same-baseline labels (x-axis ticks, category labels) overlap — then exits 0,
or prints the concrete violations and exits 1. It needs no server, no database
and no browser. Pass `-- --checks fit` or `-- --checks labels` to run one
assertion group at a time; the default is `all`.

## Safety

- **Read-only by construction.** The engine sets `default_transaction_read_only`
  on every connection, so any write is rejected by Postgres rather than reaching
  production. It is a dedicated `pool_size=1` engine — it never borrows the
  app's request session. Verified: `CREATE TEMP TABLE` is refused.
- **Superuser-gated at the API.** Auth is Bearer JWT, so the HTML document
  itself cannot be gated server-side; the hard gate is on
  `GET /api/admin/activity/stats` (`current_superuser`, which also 403s
  impersonation tokens). The page shell carries no data.
- **No account identifiers leave the database.** `user_id` is renumbered densely
  per request; the page only needs row identity for distinct-user counts.
- **No poll.** The page fetches once on mount and again only when someone clicks
  Refresh — `staleTime: Infinity`, `refetchOnWindowFocus: false`,
  `refetchInterval: false`, all pinned explicitly rather than inherited from the
  query client's defaults. A tab left open costs nothing.
- **One connection, cached.** Results are reused for `CACHE_TTL_SECONDS` (300s),
  so open tabs do not multiply load on the production database.

## Reading the numbers

- Activity tracking starts at the first row in `user_activity`; there is no
  history before it, so MAU fills its first window at the left edge.
- The current day is always partial.
- A guest promoted to a registered account keeps its original row and
  `created_at` (`app/services/guest_service.py`), so it counts as registered in
  the funnel. Both promotion paths (Google and email/password) stamp
  `users.promoted_at` on that same row (a nullable timestamp, not a boolean, so
  it also supports a promotion-date time series and time-to-conversion), and the
  conversion metric reads `promoted_at IS NOT NULL` directly. The migration
  backfill recovered history only for Google promotions (the pre-flag detection
  rule: not a guest, empty password hash) — and even for those, `promoted_at`
  was set to the row's `created_at` (signup date), not the true historical
  promotion date, which is unrecoverable. So the series before the flag shipped
  (`PROMOTED_AT_SINCE` in `activity_stats.py`) remains a floor, not the true
  rate, and any promotion-timing metric is only meaningful for rows promoted on
  or after that date.

## Query cost

`build_payload()` runs ~16 sequential aggregate queries over the full tracked
history. Measured against the **dev** database (25 users, 70 `user_activity`
rows, 59 tracked days, 163,781 games), three consecutive cold calls:

    0.40s (first, cold caches) / 0.03s / 0.03s

**Treat that as a floor, not a prediction.** The dev database has 70 activity
rows; production has orders of magnitude more, and the queries that dominate
scale with users × active days rather than with games. The endpoint has not been
timed against production — do that before assuming the 300s cache is sufficient.

Two things bound the cost: that TTL (one query round per five minutes no matter
how many tabs are open) and the absence of a poll. Note also that
`fetch_activity` returns **one row per (user, day)** to the browser, which is
what makes the client-side cohort and retention maths possible — so the payload
size, not just the query time, grows with the active-user base. If the page ever
feels slow, check the payload size before optimising SQL.
