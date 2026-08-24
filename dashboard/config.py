"""Configuration constants for the local activity dashboard."""

from typing import Final

# Bind to loopback only: this server exposes production data and must never be
# reachable from the network.
HOST: Final[str] = "127.0.0.1"
PORT: Final[int] = 8899

# Prod is queried at most once per this window; every request inside it is
# served from the in-process cache. The page polls a little faster than this,
# so a poll costs nothing unless the cache has expired.
CACHE_TTL_SECONDS: Final[int] = 60
POLL_INTERVAL_SECONDS: Final[int] = 60

# The hosted /activity page (app/routers/admin_activity.py) shares the same
# StatsCache implementation but uses a 5x longer TTL than the standalone
# tunnel tool above: build_payload runs ~16 sequential full-history aggregate
# queries, and the hosted endpoint sits directly against the production
# database with no rate-limiting SSH tunnel in front of it and no 60s poll
# driving it (D-6, manual refresh only) — a short TTL there would put a real
# standing query load on prod every time a superuser has the tab open. 300s
# bounds that load while still refreshing within a normal monitoring session.
HOSTED_CACHE_TTL_SECONDS: Final[int] = 300

# The public launch. A real event, not derivable from the data, so it is a
# constant here and rendered as an annotation on every time chart.
LAUNCH_DATE: Final[str] = "2026-07-23"

# The date users.promoted_at started recording (see the migration in
# alembic/versions/). Production only begins stamping rows at the first
# deploy on or after this date, so guest-conversion history before it is a
# floor (Google-only, recovered by the migration backfill with the row's
# signup date standing in for the unrecoverable true promotion date), not
# the true rate.
PROMOTED_AT_SINCE: Final[str] = "2026-08-23"

# Bot ratings with fewer games than this are dropped from the score-by-rating
# chart — below it a single session swings the number by tens of points.
MIN_GAMES_PER_ELO: Final[int] = 10

# Rolling windows for the active-user chart, in days.
WAU_WINDOW_DAYS: Final[int] = 7
MAU_WINDOW_DAYS: Final[int] = 30

# "Imported a real library" threshold for the last funnel stage.
FUNNEL_GAMES_THRESHOLD: Final[int] = 100
