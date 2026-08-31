"""Read-only queries backing the activity dashboard.

Every function here takes an open ``AsyncConnection`` and returns plain JSON-able
data. No ORM models, no writes: the connection is opened with
``default_transaction_read_only`` so a stray statement fails loudly rather than
touching production.
"""

import datetime
from decimal import Decimal
from typing import Any, Final, Literal, NamedTuple, TypedDict

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

# Bot ratings with fewer games than this are dropped from the score-by-rating
# chart -- below it a single session swings the number by tens of points.
MIN_GAMES_PER_ELO: Final[int] = 10

# "Imported a real library" threshold for the last funnel stage.
FUNNEL_GAMES_THRESHOLD: Final[int] = 100

# The four presets the global time-range filter offers (Quick 260831-p7x, D1).
# No custom range, no "Today", no fifth preset -- exactly these four, ever.
RangeKey = Literal["all", "d90", "d30", "d7"]

# Window length in calendar days per range key, `None` for the all-time key
# (which has no fixed span -- its window always starts at the data's first
# tracked day). The only place 7/30/90 may appear in a window expression.
RANGE_WINDOW_DAYS: Final[dict[RangeKey, int | None]] = {
    "all": None,
    "d90": 90,
    "d30": 30,
    "d7": 7,
}

# The widest rolling window on the page is the 30-day MAU; 29 PRIOR days (its
# own day already counts toward the 30) are enough lookback for the window's
# first visible day to already be a correct 30-day MAU and a correct 7-day
# rolling Train/solve accuracy, without shipping a whole extra window's worth
# of data the client would have to plot and then hide.
ROLLING_LEAD_IN_DAYS: Final[int] = 29

# promoted_at is stamped by app/services/guest_service.py on both promotion
# paths (Google and email/password) in the same UPDATE that flips is_guest;
# NULL means never promoted. Rows created before the column shipped were
# backfilled from the old Google-only detection rule (empty password hash)
# with promoted_at set to the row's created_at (signup date, not the true
# historical promotion date — that is unrecoverable), so the early part of
# the series is a floor rather than the true rate, and a promotion-date time
# series is only meaningful from activity_stats.PROMOTED_AT_SINCE onward.
_PROMOTED_GUEST = "u.promoted_at IS NOT NULL"

# Cohort for the conversion queries below: rows that are still guest sessions,
# plus rows that were guest sessions and have since been promoted in place.
# Must use promoted_at (not the old password-hash test) or email/password
# converts fall out of the denominator and inflate the rate.
_GUEST_COHORT = "(u.is_guest OR u.promoted_at IS NOT NULL)"


class Payload(TypedDict):
    """The complete dashboard dataset, as served to the page."""

    generated_at: str
    promoted_since: str
    range: RangeKey
    data_start: str
    days: list[str]
    window_start_index: int
    last_complete_index: int
    activity: list[list[int]]
    signups: list[list[Any]]
    bot: list[list[Any]]
    train: list[list[Any]]
    solves: list[list[Any]]
    imports: list[list[Any]]
    persona: list[list[Any]]
    bot_players: int
    elo: list[list[int]]
    funnel: list[list[Any]]
    tti: list[list[Any]]
    stick: list[list[Any]]
    conversion: dict[str, Any]
    conversion_compare: list[list[Any]]


async def _scalar_date(conn: AsyncConnection, sql: str) -> datetime.date:
    result = await conn.execute(text(sql))
    value = result.scalar_one()
    assert isinstance(value, datetime.date)
    return value


async def _rows(conn: AsyncConnection, sql: str, **params: Any) -> list[Any]:
    result = await conn.execute(text(sql), params)
    return list(result.all())


def _json_safe(value: Any) -> Any:
    """Coerce a DB value into something ``json`` can encode.

    Dates become YYYY-MM-DD. Postgres ``numeric`` (from round/avg) arrives as
    ``Decimal``, which the JSON encoder rejects, so it is narrowed to int when
    integral and float otherwise.
    """
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


def _table(rows: list[Any]) -> list[list[Any]]:
    return [[_json_safe(v) for v in row] for row in rows]


class ResolvedWindow(NamedTuple):
    """A range key turned into concrete dates against a real dataset."""

    range_key: RangeKey
    data_start: datetime.date
    lead_in_start: datetime.date
    window_start: datetime.date
    days: list[str]
    window_start_index: int
    last_complete_index: int


def resolve_window(
    range_key: RangeKey,
    now_utc: datetime.datetime,
    data_start: datetime.date,
    data_end: datetime.date,
) -> ResolvedWindow:
    """Turn a range key into concrete window dates.

    Two clamps make the result provably safe regardless of the dataset shape:

    - `window_start` is clamped UP to `data_start` so a wide window (e.g. a
      90-day window over a 10-day-old dataset) never starts before any data
      exists -- the window degrades to "all the data there is" rather than
      producing a negative-width result (the short-dataset case).
    - `window_start` is also clamped DOWN to `data_end` so a dataset with no
      recent activity at all (e.g. a 7-day window requested weeks after the
      last tracked row) still yields a `window_start_index` inside
      `[0, len(days) - 1]` instead of pointing past the end of `days`
      (the stale-dataset case).

    `today` is taken from `now_utc`, never from an inline clock read, so the
    window is reproducible under the dev-clock override.
    """
    today = now_utc.date()
    span = RANGE_WINDOW_DAYS[range_key]
    raw_cutoff = data_start if span is None else today - datetime.timedelta(days=span - 1)
    window_start = min(max(raw_cutoff, data_start), data_end)
    lead_in_start = max(window_start - datetime.timedelta(days=ROLLING_LEAD_IN_DAYS), data_start)
    days = [
        (lead_in_start + datetime.timedelta(days=offset)).isoformat()
        for offset in range((data_end - lead_in_start).days + 1)
    ]
    window_start_index = (window_start - lead_in_start).days
    last_complete_index = len(days) - (2 if data_end >= today and len(days) > 1 else 1)
    return ResolvedWindow(
        range_key=range_key,
        data_start=data_start,
        lead_in_start=lead_in_start,
        window_start=window_start,
        days=days,
        window_start_index=window_start_index,
        last_complete_index=last_complete_index,
    )


async def fetch_window(
    conn: AsyncConnection, range_key: RangeKey, now_utc: datetime.datetime
) -> ResolvedWindow:
    """Read the dataset's real span and resolve `range_key` against it."""
    data_start = await _scalar_date(conn, "SELECT min(activity_date) FROM user_activity")
    data_end = await _scalar_date(conn, "SELECT max(activity_date) FROM user_activity")
    return resolve_window(range_key, now_utc, data_start, data_end)


async def fetch_activity(
    conn: AsyncConnection, lead_in_start: datetime.date, window_start: datetime.date
) -> list[list[int]]:
    """One row per (user, day): [day_index, is_guest, active_hours, is_entrant].

    ``is_entrant`` is 1 when the user's global first tracked day -- computed
    over the WHOLE `user_activity` table, not just the rows scanned here -- is
    on or after `window_start`. That is what lets render.js's `retention()`
    treat "first tracked day inside the selected window" as the cohort per D3;
    it is 1 for every row when the range is all-time, since `window_start`
    then equals `data_start`.

    The user id is dropped — the page only needs distinct-user counts per day,
    which it derives from the row identity, so no account identifier leaves the
    database.
    """
    rows = await _rows(
        conn,
        """
        WITH first_seen AS (
            SELECT user_id, min(activity_date) AS first_day
            FROM user_activity
            GROUP BY 1
        )
        SELECT a.user_id, (a.activity_date - CAST(:lead_in AS date)) AS day_index,
               CASE WHEN u.is_guest THEN 1 ELSE 0 END AS is_guest,
               a.activity_count,
               CASE WHEN f.first_day >= CAST(:window_start AS date) THEN 1 ELSE 0 END AS is_entrant
        FROM user_activity a
        JOIN users u ON u.id = a.user_id
        JOIN first_seen f ON f.user_id = a.user_id
        WHERE a.activity_date >= CAST(:lead_in AS date)
        ORDER BY a.activity_date, a.user_id
        """,
        lead_in=lead_in_start,
        window_start=window_start,
    )
    # user_id is kept only as a within-request identity for distinct counting;
    # it is renumbered densely so no real account id reaches the browser.
    dense: dict[int, int] = {}
    out: list[list[int]] = []
    for user_id, day_index, is_guest, hours, is_entrant in rows:
        dense.setdefault(user_id, len(dense))
        out.append([dense[user_id], int(day_index), int(is_guest), int(hours), int(is_entrant)])
    return out


async def fetch_signups(conn: AsyncConnection, window_start: datetime.date) -> list[list[Any]]:
    return _table(
        await _rows(
            conn,
            """
            SELECT CAST(created_at AS date) AS day,
                   count(*) FILTER (WHERE NOT is_guest) AS registered,
                   count(*) FILTER (WHERE is_guest) AS guests
            FROM users WHERE created_at >= CAST(:first AS date)
            GROUP BY 1 ORDER BY 1
            """,
            first=window_start,
        )
    )


async def fetch_bot_games(conn: AsyncConnection, window_start: datetime.date) -> list[list[Any]]:
    """Daily bot games. Result is stored from White's side, so the human's
    score is recovered by comparing ``user_color`` against ``result``."""
    return _table(
        await _rows(
            conn,
            """
            SELECT CAST(g.played_at AS date) AS day, count(*) AS games,
                   count(DISTINCT g.user_id) AS users,
                   round(avg(b.nominal_elo)) AS avg_elo,
                   count(*) FILTER (WHERE (g.user_color::text = 'white' AND g.result::text = '1-0')
                                       OR (g.user_color::text = 'black' AND g.result::text = '0-1')) AS human_wins,
                   count(*) FILTER (WHERE g.result::text = '1/2-1/2') AS draws
            FROM bot_game_settings b JOIN games g ON g.id = b.game_id
            WHERE g.played_at >= CAST(:cutoff AS date)
            GROUP BY 1 ORDER BY 1
            """,
            cutoff=window_start,
        )
    )


async def fetch_bot_players(conn: AsyncConnection, window_start: datetime.date) -> int:
    """Distinct humans who have played at least one bot game in the window."""
    rows = await _rows(
        conn,
        """
        SELECT count(DISTINCT g.user_id) FROM bot_game_settings b
        JOIN games g ON g.id = b.game_id
        WHERE g.played_at >= CAST(:cutoff AS date)
        """,
        cutoff=window_start,
    )
    return int(rows[0][0])


async def fetch_train(conn: AsyncConnection, window_start: datetime.date) -> list[list[Any]]:
    return _table(
        await _rows(
            conn,
            """
            SELECT session_date AS day, count(*) AS sessions,
                   count(DISTINCT user_id) AS users,
                   count(*) FILTER (WHERE status = 'completed') AS completed,
                   count(*) FILTER (WHERE status = 'expired') AS expired,
                   count(*) FILTER (WHERE status = 'open') AS still_open,
                   sum(puzzle_count) AS puzzles
            FROM drill_sessions
            WHERE session_date >= CAST(:cutoff AS date)
            GROUP BY 1 ORDER BY 1
            """,
            cutoff=window_start,
        )
    )


async def fetch_solves(conn: AsyncConnection, lead_in_start: datetime.date) -> list[list[Any]]:
    return _table(
        await _rows(
            conn,
            """
            SELECT CAST(solved_at AS date) AS day, count(*) AS solves,
                   count(DISTINCT user_id) AS users,
                   count(*) FILTER (WHERE correct_move) AS correct_move,
                   count(*) FILTER (WHERE correct_guess) AS correct_guess
            FROM drill_solves
            WHERE solved_at IS NOT NULL AND solved_at >= CAST(:lead_in AS date)
            GROUP BY 1 ORDER BY 1
            """,
            lead_in=lead_in_start,
        )
    )


async def fetch_imports(conn: AsyncConnection, window_start: datetime.date) -> list[list[Any]]:
    return _table(
        await _rows(
            conn,
            """
            SELECT CAST(started_at AS date) AS day, count(*) AS jobs,
                   count(DISTINCT user_id) AS users,
                   coalesce(sum(games_imported), 0) AS games,
                   count(*) FILTER (WHERE status = 'failed') AS failed
            FROM import_jobs WHERE started_at >= CAST(:first AS date)
            GROUP BY 1 ORDER BY 1
            """,
            first=window_start,
        )
    )


async def fetch_persona(conn: AsyncConnection, window_start: datetime.date) -> list[list[Any]]:
    """Bot games by persona style. ``persona_id`` is NULL for custom-mode games."""
    return _table(
        await _rows(
            conn,
            """
            SELECT initcap(split_part(coalesce(g.persona_id, 'custom'), '-', 1)) AS style,
                   count(*) AS games, count(DISTINCT g.user_id) AS users,
                   count(*) FILTER (WHERE (g.user_color::text = 'white' AND g.result::text = '1-0')
                                       OR (g.user_color::text = 'black' AND g.result::text = '0-1')) AS human_wins,
                   count(*) FILTER (WHERE g.result::text = '1/2-1/2') AS draws
            FROM bot_game_settings b JOIN games g ON g.id = b.game_id
            WHERE g.played_at >= CAST(:cutoff AS date)
            GROUP BY 1 ORDER BY games DESC
            """,
            cutoff=window_start,
        )
    )


async def fetch_elo(conn: AsyncConnection, window_start: datetime.date) -> list[list[int]]:
    rows = await _rows(
        conn,
        """
        SELECT b.nominal_elo AS elo, count(*) AS games,
               count(*) FILTER (WHERE (g.user_color::text = 'white' AND g.result::text = '1-0')
                                   OR (g.user_color::text = 'black' AND g.result::text = '0-1')) AS human_wins,
               count(*) FILTER (WHERE g.result::text = '1/2-1/2') AS draws
        FROM bot_game_settings b JOIN games g ON g.id = b.game_id
        WHERE g.played_at >= CAST(:cutoff AS date)
        GROUP BY 1 HAVING count(*) >= :floor ORDER BY 1
        """,
        cutoff=window_start,
        floor=MIN_GAMES_PER_ELO,
    )
    return [[int(v) for v in row] for row in rows]


async def fetch_funnel(conn: AsyncConnection, window_start: datetime.date) -> list[list[Any]]:
    """Signup -> import funnel stages, counted for registered and guest cohorts.

    A promoted guest keeps its original ``created_at`` and counts as registered,
    because promotion happens in place on the same row.

    Cohort card (D3): only the ``users.created_at`` predicate below constrains
    the window, by cohort ENTRY. The joined `import_jobs`/`games` CTEs stay
    unfiltered so a user who entered inside the window is followed forward to
    today — do not add a date filter to those CTEs.
    """
    row = (
        await _rows(
            conn,
            """
            WITH u AS (
              SELECT id, is_guest,
                     (chess_com_username IS NOT NULL OR lichess_username IS NOT NULL) AS linked
              FROM users WHERE created_at >= CAST(:first AS date)),
            j AS (SELECT user_id, coalesce(sum(games_imported), 0) AS total
                  FROM import_jobs GROUP BY 1),
            g AS (SELECT user_id, count(*) AS games FROM games
                  WHERE platform IN ('chess.com', 'lichess') GROUP BY 1)
            SELECT
              count(*) FILTER (WHERE NOT u.is_guest) AS r_created,
              count(*) FILTER (WHERE NOT u.is_guest AND u.linked) AS r_linked,
              count(*) FILTER (WHERE NOT u.is_guest AND j.user_id IS NOT NULL) AS r_started,
              count(*) FILTER (WHERE NOT u.is_guest AND coalesce(j.total, 0) > 0) AS r_imported,
              count(*) FILTER (WHERE NOT u.is_guest AND coalesce(g.games, 0) >= :threshold) AS r_library,
              count(*) FILTER (WHERE u.is_guest) AS g_created,
              count(*) FILTER (WHERE u.is_guest AND u.linked) AS g_linked,
              count(*) FILTER (WHERE u.is_guest AND j.user_id IS NOT NULL) AS g_started,
              count(*) FILTER (WHERE u.is_guest AND coalesce(j.total, 0) > 0) AS g_imported,
              count(*) FILTER (WHERE u.is_guest AND coalesce(g.games, 0) >= :threshold) AS g_library
            FROM u LEFT JOIN j ON j.user_id = u.id LEFT JOIN g ON g.user_id = u.id
            """,
            first=window_start,
            threshold=FUNNEL_GAMES_THRESHOLD,
        )
    )[0]
    labels = [
        "Account created",
        "Chess account linked",
        "Import started",
        "At least 1 game imported",
        f"{FUNNEL_GAMES_THRESHOLD}+ games imported",
    ]
    return [[label, int(row[i]), int(row[i + 5])] for i, label in enumerate(labels)]


async def fetch_time_to_import(
    conn: AsyncConnection, window_start: datetime.date
) -> list[list[Any]]:
    """How long after account creation the first import job started.

    Cohort card (D3): windowed on ``users.created_at`` (entry) only; the
    joined `import_jobs` CTE stays unfiltered so entrants are followed
    forward to today — do not add a date filter to that CTE.
    """
    row = (
        await _rows(
            conn,
            """
            WITH u AS (SELECT id, is_guest, created_at FROM users
                       WHERE created_at >= CAST(:first AS date)),
            j AS (SELECT user_id, min(started_at) AS first_job FROM import_jobs GROUP BY 1)
            SELECT
              count(*) FILTER (WHERE NOT u.is_guest AND j.first_job < u.created_at + interval '5 min') AS r0,
              count(*) FILTER (WHERE NOT u.is_guest AND j.first_job >= u.created_at + interval '5 min'
                               AND j.first_job < u.created_at + interval '1 hour') AS r1,
              count(*) FILTER (WHERE NOT u.is_guest AND j.first_job >= u.created_at + interval '1 hour'
                               AND j.first_job < u.created_at + interval '1 day') AS r2,
              count(*) FILTER (WHERE NOT u.is_guest AND j.first_job >= u.created_at + interval '1 day') AS r3,
              count(*) FILTER (WHERE NOT u.is_guest AND j.first_job IS NULL) AS r4,
              count(*) FILTER (WHERE u.is_guest AND j.first_job < u.created_at + interval '5 min') AS g0,
              count(*) FILTER (WHERE u.is_guest AND j.first_job >= u.created_at + interval '5 min'
                               AND j.first_job < u.created_at + interval '1 hour') AS g1,
              count(*) FILTER (WHERE u.is_guest AND j.first_job >= u.created_at + interval '1 hour'
                               AND j.first_job < u.created_at + interval '1 day') AS g2,
              count(*) FILTER (WHERE u.is_guest AND j.first_job >= u.created_at + interval '1 day') AS g3,
              count(*) FILTER (WHERE u.is_guest AND j.first_job IS NULL) AS g4
            FROM u LEFT JOIN j ON j.user_id = u.id
            """,
            first=window_start,
        )
    )[0]
    buckets = ["Under 5 min", "5–60 min", "1–24 h", "Later than a day", "Never"]
    return [[label, int(row[i]), int(row[i + 5])] for i, label in enumerate(buckets)]


async def fetch_stickiness(conn: AsyncConnection, window_start: datetime.date) -> list[list[Any]]:
    """Return rate for importers vs non-importers, per cohort.

    "Returned" means seen on at least two distinct days.

    Cohort card (D3): windowed on ``users.created_at`` (entry) only; the
    joined `import_jobs`/`user_activity` CTEs stay unfiltered so entrants are
    followed forward to today — do not add a date filter to those CTEs.
    """
    rows = await _rows(
        conn,
        """
        WITH u AS (SELECT id, is_guest FROM users WHERE created_at >= CAST(:first AS date)),
        j AS (SELECT user_id, coalesce(sum(games_imported), 0) AS total FROM import_jobs GROUP BY 1),
        a AS (SELECT user_id, count(DISTINCT activity_date) AS days FROM user_activity GROUP BY 1)
        SELECT u.is_guest, (coalesce(j.total, 0) > 0) AS imported, count(*) AS users,
               count(*) FILTER (WHERE coalesce(a.days, 0) >= 2) AS returned
        FROM u LEFT JOIN j ON j.user_id = u.id LEFT JOIN a ON a.user_id = u.id
        GROUP BY 1, 2
        """,
        first=window_start,
    )
    by_key = {(bool(r[0]), bool(r[1])): (int(r[2]), int(r[3])) for r in rows}
    out: list[list[Any]] = []
    for label, is_guest in (("Registered", False), ("Guest", True)):
        imported = by_key.get((is_guest, True), (0, 0))
        never = by_key.get((is_guest, False), (0, 0))
        out.append([label, imported[0], imported[1], never[0], never[1]])
    return out


async def fetch_conversion(conn: AsyncConnection, window_start: datetime.date) -> dict[str, Any]:
    """Guest -> registered conversion, from the stamped promoted_at column.

    Cohort card (D3): windowed on ``users.created_at`` (entry) only; the
    joined `user_activity` CTE stays unfiltered so entrants are followed
    forward to today — do not add a date filter to that CTE.
    """
    row = (
        await _rows(
            conn,
            f"""
            WITH u AS (
              SELECT id, ({_PROMOTED_GUEST}) AS converted
              FROM users u
              WHERE created_at >= CAST(:first AS date) AND {_GUEST_COHORT}),
            a AS (SELECT user_id, count(DISTINCT activity_date) AS days FROM user_activity GROUP BY 1)
            SELECT count(*) AS sessions,
                   count(*) FILTER (WHERE u.converted) AS converted,
                   round(avg(coalesce(a.days, 0)) FILTER (WHERE u.converted), 2) AS days_converted,
                   round(avg(coalesce(a.days, 0)) FILTER (WHERE NOT u.converted), 2) AS days_guest
            FROM u LEFT JOIN a ON a.user_id = u.id
            """,
            first=window_start,
        )
    )[0]
    return {
        "sessions": int(row[0]),
        "converted": int(row[1]),
        "avg_days_converted": float(row[2] or 0),
        "avg_days_guest": float(row[3] or 0),
    }


async def fetch_conversion_compare(
    conn: AsyncConnection, window_start: datetime.date
) -> list[list[Any]]:
    """What converters did differently, as [metric, hits, total] per group.

    Cohort card (D3): windowed on ``users.created_at`` (entry) only; the
    joined `import_jobs`/`bot_game_settings`/`user_activity` CTEs stay
    unfiltered so entrants are followed forward to today — do not add a date
    filter to those CTEs.
    """
    row = (
        await _rows(
            conn,
            f"""
            WITH u AS (
              SELECT id, ({_PROMOTED_GUEST}) AS converted
              FROM users u
              WHERE created_at >= CAST(:first AS date) AND {_GUEST_COHORT}),
            j AS (SELECT user_id, coalesce(sum(games_imported), 0) AS total FROM import_jobs GROUP BY 1),
            b AS (SELECT g.user_id, count(*) AS n FROM bot_game_settings s
                  JOIN games g ON g.id = s.game_id GROUP BY 1),
            a AS (SELECT user_id, count(DISTINCT activity_date) AS days FROM user_activity GROUP BY 1)
            SELECT count(*) FILTER (WHERE u.converted) AS c_total,
                   count(*) FILTER (WHERE NOT u.converted) AS g_total,
                   count(*) FILTER (WHERE u.converted AND coalesce(j.total, 0) > 0) AS c_import,
                   count(*) FILTER (WHERE NOT u.converted AND coalesce(j.total, 0) > 0) AS g_import,
                   count(*) FILTER (WHERE u.converted AND coalesce(a.days, 0) >= 2) AS c_return,
                   count(*) FILTER (WHERE NOT u.converted AND coalesce(a.days, 0) >= 2) AS g_return,
                   count(*) FILTER (WHERE u.converted AND coalesce(b.n, 0) > 0) AS c_bot,
                   count(*) FILTER (WHERE NOT u.converted AND coalesce(b.n, 0) > 0) AS g_bot
            FROM u LEFT JOIN j ON j.user_id = u.id LEFT JOIN b ON b.user_id = u.id
                   LEFT JOIN a ON a.user_id = u.id
            """,
            first=window_start,
        )
    )[0]
    converted_total, guest_total = int(row[0]), int(row[1])
    metrics = ["Imported games", "Came back a 2nd day", "Played the bot"]
    return [
        [label, int(row[2 + i * 2]), converted_total, int(row[3 + i * 2]), guest_total]
        for i, label in enumerate(metrics)
    ]
