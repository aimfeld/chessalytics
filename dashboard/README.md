# Activity Pulse — activity dashboard

A read-only dashboard for production activity metrics: rolling DAU/WAU/MAU,
retention, the signup → import funnel, guest conversion, bot games, Train
sessions and imports.

This is an internal analytics tool, not a product feature. It has **two
consumers, one source**: the SQL (`queries.py`), the chart toolkit
(`static/charts.js`), the render layer (`static/app.js`) and the stylesheet
(`static/styles.css`) are shared verbatim — there is no forked copy.

| | Standalone (local) | Hosted (production) |
|---|---|---|
| Entry point | `dashboard/server.py` | `app/routers/admin_activity.py` |
| URL | `http://127.0.0.1:8899` | `https://flawchess.com/activity` |
| Database | `DATABASE_URL_PROD` (via SSH tunnel) | `settings.DATABASE_URL` (in-process) |
| Access | loopback only, no auth | `current_superuser` — 401 anon, 403 non-superuser |
| Cache TTL | 60s (`CACHE_TTL_SECONDS`) | 300s (`HOSTED_CACHE_TTL_SECONDS`) |
| Refresh | `boot.js` polls every 60s | manual only — React drives, **no poll** |
| Page shell | `static/index.html` | `frontend/src/pages/ActivityPage.tsx` |

The hosted page deliberately does not load `boot.js`. That is what keeps the
60-second poll off production — a structural guarantee rather than a convention
someone can undo by accident.

## Run it (standalone)

```bash
bin/prod_db_tunnel.sh                  # forwards prod Postgres to localhost:15432
uv run python -m dashboard.server      # http://127.0.0.1:8899
```

Options: `--port`, `--host`, `--cache-seconds`. Stop the tunnel afterwards with
`bin/prod_db_tunnel.sh stop`.

There is no autoreload: the process serves the payload shape it started with,
while `static/` is read from disk per request. After changing anything under
`dashboard/`, restart the server — otherwise new page JS runs against an old
payload and fields added in that change read as `undefined`.

The page polls `/api/stats` every 60 seconds and shows the last refresh time in
the masthead; "Refresh now" forces a re-query. If the tunnel is down the page
keeps the last good snapshot, marks itself stale, and says what to do.

**Checking mobile layout** — `node dashboard/check_layout.mjs` loads the real
`static/charts.js` through a minimal DOM shim and renders every chart with
synthetic worst-case fixture data at 320/360/390/414px CSS-pixel viewports. It
asserts that every chart's `<svg>` fits within its container width (no
horizontal scrolling), that no text is clipped outside the chart, and that no
two same-baseline labels (x-axis ticks, category labels) overlap — then exits
0, or prints the concrete violations and exits 1. It needs no server, no
database and no browser. Pass `--checks fit` or `--checks labels` to run one
assertion group at a time; the default is `all`.

## Safety

- **Read-only by construction.** BOTH consumers build their engine with
  `default_transaction_read_only` set on every connection, so any write is
  rejected by Postgres rather than reaching production. The hosted endpoint uses
  its own dedicated `pool_size=1` engine — it never borrows the app's request
  session. Verified: `CREATE TEMP TABLE` is refused.
- **The hosted route is superuser-gated at the API.** Auth is Bearer JWT, so the
  HTML document itself cannot be gated server-side; the hard gate is on
  `GET /api/admin/activity/stats` (`current_superuser`, which also 403s
  impersonation tokens). The page shell carries no data.
- **Standalone binds loopback only.** `127.0.0.1` by default; do not bind it to a
  public interface — the payload contains production usage data.
- **No account identifiers leave the database.** `user_id` is renumbered densely
  per request; the page only needs row identity for distinct-user counts.
- **One connection, cached.** Results are reused for `CACHE_TTL_SECONDS`, so
  open tabs do not multiply load on the production database.

## Layout

| File | Role |
|---|---|
| `config.py` | Constants: bind address, both cache TTLs, launch date, thresholds |
| `queries.py` | Every SQL query, returning JSON-able rows — **shared by both consumers** |
| `stats.py` | `build_readonly_engine()`, `build_payload()`, `StatsCache` — **shared by both consumers**; side-effect free so `app/` can import it |
| `server.py` | Standalone FastAPI app: builds its own engine at import time, mounts `static/` |
| `static/index.html` | Standalone page markup (all numbers filled at runtime) |
| `static/styles.css` | Stylesheet, every rule scoped under `.activity-dash` so it cannot leak into the SPA |
| `static/charts.js` | Chart toolkit: line, bar, grouped bar, funnel, sparkline. Classic script, not an ES module — `check_layout.mjs` loads it via `vm.runInContext` |
| `static/app.js` | Render layer only. Exposes `window.__fcApp.mount() → {update, destroy}` |
| `static/boot.js` | Standalone driver: fetch, poll, Refresh-now, error banner. **Not loaded by the hosted page** |
| `check_layout.mjs` | Headless layout harness — asserts chart geometry fits phone widths |

## Reading the numbers

- Activity tracking starts at the first row in `user_activity`; there is no
  history before it, so MAU fills its first window at the left edge.
- The current day is always partial.
- A guest promoted to a registered account keeps its original row and
  `created_at` (`app/services/guest_service.py`), so it counts as registered in
  the funnel. Both promotion paths (Google and email/password) stamp
  `users.promoted_at` on that same row (a nullable timestamp, not a boolean,
  so it also supports a promotion-date time series and time-to-conversion),
  and the conversion metric reads `promoted_at IS NOT NULL` directly. The
  migration backfill recovered history only for Google promotions (the
  pre-flag detection rule: not a guest, empty password hash) — and even for
  those, `promoted_at` was set to the row's `created_at` (signup date), not
  the true historical promotion date, which is unrecoverable. So the series
  before the flag shipped (`PROMOTED_AT_SINCE` in `config.py`) remains a
  floor, not the true rate, and any promotion-timing metric is only
  meaningful for rows promoted on or after that date.
- `LAUNCH_DATE` in `config.py` is a real-world event, not derived from the data.

## Query cost

`build_payload()` runs ~16 sequential aggregate queries over the full tracked
history. Measured against the **dev** database (25 users, 70 `user_activity`
rows, 59 tracked days, 163,781 games), three consecutive cold calls:

    0.40s (first, cold caches) / 0.03s / 0.03s

**Treat that as a floor, not a prediction.** The dev database has 70 activity
rows; production has orders of magnitude more, and the queries that dominate
scale with users × active days rather than with games. The hosted endpoint has
not been timed against production — do that before assuming the 300s cache is
sufficient.

Two things bound the cost in production: the 300s TTL (one query round per five
minutes no matter how many tabs are open) and the absence of a poll (a tab left
open costs nothing). Note also that `fetch_activity` returns **one row per
(user, day)** to the browser, which is what makes the client-side cohort and
retention maths possible — so the payload size, not just the query time, grows
with the active-user base. If the page ever feels slow, check the payload size
before optimising SQL.
