"""Read-only queries backing the activity dashboard.

Every function here takes an open ``AsyncConnection`` and returns plain JSON-able
data. No ORM models, no writes: the connection is opened with
``default_transaction_read_only`` so a stray statement fails loudly rather than
touching production.
"""

import datetime
from decimal import Decimal
from typing import Any, TypedDict

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from dashboard.config import FUNNEL_GAMES_THRESHOLD, MIN_GAMES_PER_ELO

# is_promoted is stamped by app/services/guest_service.py on both promotion
# paths (Google and email/password) in the same UPDATE that flips is_guest.
# Rows created before the column shipped were backfilled from the old
# Google-only detection rule (empty password hash), so the early part of the
# series is a floor rather than the true rate — see config.IS_PROMOTED_SINCE.
_PROMOTED_GUEST = "u.is_promoted"

# Cohort for the conversion queries below: rows that are still guest sessions,
# plus rows that were guest sessions and have since been promoted in place.
# Must use is_promoted (not the old password-hash test) or email/password
# converts fall out of the denominator and inflate the rate.
_GUEST_COHORT = "(u.is_guest OR u.is_promoted)"


class Payload(TypedDict):
    """The complete dashboard dataset, as served to the page."""

    generated_at: str
    launch_date: str
    promoted_since: str
    poll_interval_seconds: int
    days: list[str]
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


async def fetch_day_range(conn: AsyncConnection) -> tuple[datetime.date, list[str], int]:
    """Return the first tracked day, every day as ISO text, and the index of the
    last *complete* day.

    Today is always partial, so the tiles quote the day before it.
    """
    first = await _scalar_date(conn, "SELECT min(activity_date) FROM user_activity")
    last = await _scalar_date(conn, "SELECT max(activity_date) FROM user_activity")
    days = [
        (first + datetime.timedelta(days=offset)).isoformat()
        for offset in range((last - first).days + 1)
    ]
    today = datetime.datetime.now(datetime.timezone.utc).date()
    last_complete = len(days) - (2 if last >= today and len(days) > 1 else 1)
    return first, days, last_complete


async def fetch_activity(conn: AsyncConnection, first_day: datetime.date) -> list[list[int]]:
    """One row per (user, day): [day_index, is_guest, active_hours].

    The user id is dropped — the page only needs distinct-user counts per day,
    which it derives from the row identity, so no account identifier leaves the
    database.
    """
    rows = await _rows(
        conn,
        """
        SELECT a.user_id, (a.activity_date - CAST(:first AS date)) AS day_index,
               CASE WHEN u.is_guest THEN 1 ELSE 0 END AS is_guest,
               a.activity_count
        FROM user_activity a
        JOIN users u ON u.id = a.user_id
        ORDER BY a.activity_date, a.user_id
        """,
        first=first_day,
    )
    # user_id is kept only as a within-request identity for distinct counting;
    # it is renumbered densely so no real account id reaches the browser.
    dense: dict[int, int] = {}
    out: list[list[int]] = []
    for user_id, day_index, is_guest, hours in rows:
        dense.setdefault(user_id, len(dense))
        out.append([dense[user_id], int(day_index), int(is_guest), int(hours)])
    return out


async def fetch_signups(conn: AsyncConnection, first_day: datetime.date) -> list[list[Any]]:
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
            first=first_day,
        )
    )


async def fetch_bot_games(conn: AsyncConnection) -> list[list[Any]]:
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
            GROUP BY 1 ORDER BY 1
            """,
        )
    )


async def fetch_bot_players(conn: AsyncConnection) -> int:
    """Distinct humans who have played at least one bot game."""
    rows = await _rows(
        conn,
        """
        SELECT count(DISTINCT g.user_id) FROM bot_game_settings b
        JOIN games g ON g.id = b.game_id
        """,
    )
    return int(rows[0][0])


async def fetch_train(conn: AsyncConnection) -> list[list[Any]]:
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
            FROM drill_sessions GROUP BY 1 ORDER BY 1
            """,
        )
    )


async def fetch_solves(conn: AsyncConnection) -> list[list[Any]]:
    return _table(
        await _rows(
            conn,
            """
            SELECT CAST(solved_at AS date) AS day, count(*) AS solves,
                   count(DISTINCT user_id) AS users,
                   count(*) FILTER (WHERE correct_move) AS correct_move,
                   count(*) FILTER (WHERE correct_guess) AS correct_guess
            FROM drill_solves WHERE solved_at IS NOT NULL
            GROUP BY 1 ORDER BY 1
            """,
        )
    )


async def fetch_imports(conn: AsyncConnection, first_day: datetime.date) -> list[list[Any]]:
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
            first=first_day,
        )
    )


async def fetch_persona(conn: AsyncConnection) -> list[list[Any]]:
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
            GROUP BY 1 ORDER BY games DESC
            """,
        )
    )


async def fetch_elo(conn: AsyncConnection) -> list[list[int]]:
    rows = await _rows(
        conn,
        """
        SELECT b.nominal_elo AS elo, count(*) AS games,
               count(*) FILTER (WHERE (g.user_color::text = 'white' AND g.result::text = '1-0')
                                   OR (g.user_color::text = 'black' AND g.result::text = '0-1')) AS human_wins,
               count(*) FILTER (WHERE g.result::text = '1/2-1/2') AS draws
        FROM bot_game_settings b JOIN games g ON g.id = b.game_id
        GROUP BY 1 HAVING count(*) >= :floor ORDER BY 1
        """,
        floor=MIN_GAMES_PER_ELO,
    )
    return [[int(v) for v in row] for row in rows]


async def fetch_funnel(conn: AsyncConnection, first_day: datetime.date) -> list[list[Any]]:
    """Signup -> import funnel stages, counted for registered and guest cohorts.

    A promoted guest keeps its original ``created_at`` and counts as registered,
    because promotion happens in place on the same row.
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
            first=first_day,
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


async def fetch_time_to_import(conn: AsyncConnection, first_day: datetime.date) -> list[list[Any]]:
    """How long after account creation the first import job started."""
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
            first=first_day,
        )
    )[0]
    buckets = ["Under 5 min", "5–60 min", "1–24 h", "Later than a day", "Never"]
    return [[label, int(row[i]), int(row[i + 5])] for i, label in enumerate(buckets)]


async def fetch_stickiness(conn: AsyncConnection, first_day: datetime.date) -> list[list[Any]]:
    """Return rate for importers vs non-importers, per cohort.

    "Returned" means seen on at least two distinct days.
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
        first=first_day,
    )
    by_key = {(bool(r[0]), bool(r[1])): (int(r[2]), int(r[3])) for r in rows}
    out: list[list[Any]] = []
    for label, is_guest in (("Registered", False), ("Guest", True)):
        imported = by_key.get((is_guest, True), (0, 0))
        never = by_key.get((is_guest, False), (0, 0))
        out.append([label, imported[0], imported[1], never[0], never[1]])
    return out


async def fetch_conversion(conn: AsyncConnection, first_day: datetime.date) -> dict[str, Any]:
    """Guest -> registered conversion, from the stamped is_promoted flag."""
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
            first=first_day,
        )
    )[0]
    return {
        "sessions": int(row[0]),
        "converted": int(row[1]),
        "avg_days_converted": float(row[2] or 0),
        "avg_days_guest": float(row[3] or 0),
    }


async def fetch_conversion_compare(
    conn: AsyncConnection, first_day: datetime.date
) -> list[list[Any]]:
    """What converters did differently, as [metric, hits, total] per group."""
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
            first=first_day,
        )
    )[0]
    converted_total, guest_total = int(row[0]), int(row[1])
    metrics = ["Imported games", "Came back a 2nd day", "Played the bot"]
    return [
        [label, int(row[2 + i * 2]), converted_total, int(row[3 + i * 2]), guest_total]
        for i, label in enumerate(metrics)
    ]
