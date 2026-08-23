# Activity Pulse — local live dashboard

A read-only dashboard for production activity metrics: rolling DAU/WAU/MAU,
retention, the signup → import funnel, guest conversion, bot games, Train
sessions and imports.

This is an internal analytics tool. It is **not** part of the product app, is
never deployed, and nothing in `app/` imports it.

## Run it

```bash
bin/prod_db_tunnel.sh                  # forwards prod Postgres to localhost:15432
uv run python -m dashboard.server      # http://127.0.0.1:8899
```

Options: `--port`, `--host`, `--cache-seconds`. Stop the tunnel afterwards with
`bin/prod_db_tunnel.sh stop`.

The page polls `/api/stats` every 60 seconds and shows the last refresh time in
the masthead; "Refresh now" forces a re-query. If the tunnel is down the page
keeps the last good snapshot, marks itself stale, and says what to do.

## Safety

- **Read-only by construction.** The engine sets `default_transaction_read_only`
  on every connection, so any write is rejected by Postgres rather than reaching
  production. Verified: `CREATE TEMP TABLE` is refused.
- **Loopback only.** Binds `127.0.0.1` by default; do not bind it to a public
  interface — the payload contains production usage data.
- **No account identifiers leave the database.** `user_id` is renumbered densely
  per request; the page only needs row identity for distinct-user counts.
- **One connection, cached.** Results are reused for `CACHE_TTL_SECONDS`, so
  open tabs do not multiply load on the production database.

## Layout

| File | Role |
|---|---|
| `config.py` | Constants: bind address, cache TTL, launch date, thresholds |
| `queries.py` | Every SQL query, returning JSON-able rows |
| `server.py` | FastAPI app, read-only engine, cache, static mount |
| `static/index.html` | Page markup (all numbers filled at runtime) |
| `static/charts.js` | Chart toolkit: line, bar, grouped bar, funnel, sparkline |
| `static/app.js` | Fetches `/api/stats`, renders, polls, handles failures |

## Reading the numbers

- Activity tracking starts at the first row in `user_activity`; there is no
  history before it, so MAU fills its first window at the left edge.
- The current day is always partial.
- A guest promoted to a registered account keeps its original row and
  `created_at` (`app/services/guest_service.py`), so it counts as registered in
  the funnel. Both promotion paths (Google and email/password) stamp
  `users.is_promoted` on that same row, and the conversion metric reads that
  column directly. The migration backfill recovered history only for Google
  promotions (the pre-flag detection rule: not a guest, empty password hash),
  so the series before the flag shipped (`IS_PROMOTED_SINCE` in `config.py`)
  remains a floor, not the true rate.
- `LAUNCH_DATE` in `config.py` is a real-world event, not derived from the data.
