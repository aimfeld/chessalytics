"""chess.com API client.

Fetches game archives for a user and yields normalized game dicts.
Rate limits are respected by sleeping 150ms between archive fetches,
with a 60-second backoff on 429 responses.

When chess.com's /games/archives index endpoint 404s for a real user (ambiguous
body, player endpoint returns 200), the client falls back to enumerating monthly
archive URLs from the player's joined date to the current month. Individual
monthly archives that 404 are skipped; transient 5xx/429 errors are retried by
the existing per-archive loop.
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime, timezone

import httpx
import sentry_sdk

from app.core.http import USER_AGENT
from app.core.rate_limiters import get_chesscom_semaphore
from app.schemas.normalization import NormalizedGame
from app.services.normalization import normalize_chesscom_game

logger = logging.getLogger(__name__)

BASE_URL = "https://api.chess.com/pub/player"

_HEADERS = {"User-Agent": USER_AGENT}
_MAX_RETRIES = 3
_RETRY_BACKOFF_BASE_SECONDS = 5
_RATE_LIMIT_BACKOFF_SECONDS = 60

# Transient network errors worth retrying (same set as lichess client)
_RETRYABLE_EXCEPTIONS = (httpx.TimeoutException, httpx.RemoteProtocolError, httpx.ReadError)

# Substring (case-insensitive) we expect in the chess.com 404 body when the user truly
# does not exist. Anything else on a 404 is treated as ambiguous and probed via the
# player endpoint. Avoids a magic string per CLAUDE.md "no magic numbers/strings".
_CHESSCOM_NOT_FOUND_MARKER = "not found"

# Status codes that represent transient server-side failures and should be retried
# with exponential backoff. We treat these like network errors — chess.com / Cloudflare
# occasionally returns 5xx for a single archive while the rest of the API is healthy.
_RETRYABLE_STATUS_CODES = frozenset({500, 502, 503, 504})

# Status codes that mean "this archive is gone / not available" but the rest of the
# user's archives may still be fetchable. Skip the archive with a warning rather
# than failing the entire import.
_SKIPPABLE_ARCHIVE_STATUS_CODES = frozenset({404, 410})

# chess.com launched in May 2007. Use January as a conservative floor for accounts
# whose /pub/player response has no 'joined' field.
_CHESSCOM_EARLIEST_ARCHIVE_YEAR_MONTH: tuple[int, int] = (2007, 1)


async def _user_exists_on_chesscom(client: httpx.AsyncClient, api_username: str) -> bool | None:
    """Probe /pub/player/{username} to disambiguate a 404 on /games/archives.

    Returns:
        True  — player endpoint returned 200, user exists.
        False — player endpoint returned 404, user truly absent.
        None  — player endpoint returned anything else (5xx / network);
                caller should treat as 'request failed' so the import is
                marked failed and last_synced_at is preserved (f69842b).
    """
    url = f"{BASE_URL}/{api_username}"
    try:
        resp = await client.get(url, headers=_HEADERS)
    except _RETRYABLE_EXCEPTIONS:
        # Network-level error on the probe — surface as 'unknown'.
        return None
    if resp.status_code == 200:
        return True
    if resp.status_code == 404:
        return False
    return None


async def _fetch_chesscom_player_joined(
    client: httpx.AsyncClient, api_username: str
) -> datetime | None:
    """Fetch the player's account creation date from /pub/player/{username}.

    The chess.com player API returns a 'joined' field as a Unix timestamp in
    seconds (not milliseconds). This helper converts it to a UTC datetime.

    Returns:
        A timezone-aware UTC datetime representing the month the user joined,
        or None if the 'joined' field is absent, non-integer, the endpoint is
        unreachable, or returns a non-200 status.
    """
    url = f"{BASE_URL}/{api_username}"
    try:
        resp = await client.get(url, headers=_HEADERS)
    except _RETRYABLE_EXCEPTIONS:
        return None
    if resp.status_code != 200:
        return None
    try:
        body = resp.json()
        joined = body.get("joined") if isinstance(body, dict) else None
        if joined is None:
            return None
        return datetime.fromtimestamp(int(joined), tz=timezone.utc)
    except ValueError, TypeError:
        return None


def _archive_before_timestamp(archive_url: str, since: datetime) -> bool:
    """Return True if the archive month ends before ``since``.

    Chess.com archive URLs end in ``/YYYY/MM``, e.g.:
        https://api.chess.com/pub/player/testuser/games/2024/03

    A month "ends" at the start of the *following* month. So the 2024/03
    archive ends at 2024-04-01T00:00:00Z. If ``since`` is on or after that
    point, the archive contains no games we care about.
    """
    parts = archive_url.rstrip("/").split("/")
    # Expect last two path segments to be year and month
    year = int(parts[-2])
    month = int(parts[-1])

    # The archive covers games up to (but not including) the first day of the
    # next month. Compute that boundary naively.
    if month == 12:
        end_year, end_month = year + 1, 1
    else:
        end_year, end_month = year, month + 1

    # Make since timezone-aware if it isn't already
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)

    archive_end = datetime(end_year, end_month, 1, tzinfo=timezone.utc)
    return archive_end <= since


def _month_before(ym: tuple[int, int]) -> tuple[int, int]:
    """Return the (year, month) immediately preceding ``ym``.

    Phase 186 Plan 02: used to compute the backward walk's end boundary --
    "just before the persisted oldest-attempted cursor" (Pitfall 1).
    """
    year, month = ym
    if month == 1:
        return year - 1, 12
    return year, month - 1


def _parse_archive_year_month(archive_url: str) -> tuple[int, int]:
    """Extract the (year, month) tuple from a chess.com monthly-archive URL.

    Mirrors the path-parsing logic in ``_archive_before_timestamp``.
    """
    parts = archive_url.rstrip("/").split("/")
    return int(parts[-2]), int(parts[-1])


def _current_year_month() -> tuple[int, int]:
    """Return the current UTC (year, month) tuple.

    Extracted as a separate function so tests can patch it without replacing
    the entire ``datetime`` class (which would break ``datetime(y, m, 1, ...)``
    constructor calls inside ``_archive_before_timestamp``).
    """
    now = datetime.now(timezone.utc)
    return now.year, now.month


def _enumerate_archive_urls(
    api_username: str,
    start_ym: tuple[int, int],
    end_ym: tuple[int, int],
) -> list[str]:
    """Synthesize monthly archive URLs from start_ym to end_ym inclusive.

    Args:
        api_username: Lowercase chess.com username.
        start_ym: (year, month) of the first archive to include.
        end_ym: (year, month) of the last archive to include (inclusive).

    Returns:
        List of URLs in the form ``{BASE_URL}/{api_username}/games/YYYY/MM``,
        one per calendar month from start_ym to end_ym inclusive.
        Returns an empty list if start_ym > end_ym.
    """
    urls: list[str] = []
    year, month = start_ym
    end_year, end_month = end_ym
    while (year, month) <= (end_year, end_month):
        urls.append(f"{BASE_URL}/{api_username}/games/{year:04d}/{month:02d}")
        if month == 12:
            year, month = year + 1, 1
        else:
            month += 1
    return urls


async def fetch_chesscom_games(
    client: httpx.AsyncClient,
    username: str,
    user_id: int,
    since_timestamp: datetime | None = None,
    on_game_fetched: Callable[[], None] | None = None,
    on_archive_skipped: Callable[[tuple[int, int]], None] | None = None,
) -> AsyncIterator[NormalizedGame]:
    """Async generator that yields normalized NormalizedGame objects for a chess.com user.

    When the archives-list endpoint 404s with an ambiguous body but the player endpoint
    confirms the user exists, falls back to enumerating monthly archive URLs from the
    player's joined date to the current month. All-empty results (every month 404s) are
    treated as a normal success yielding zero games rather than raising.

    Args:
        client: Shared httpx.AsyncClient instance.
        username: The chess.com username to fetch games for.
        user_id: Internal database user ID (denormalized into each game dict).
        since_timestamp: If provided, skip archive months that ended before this time.
            Also applies during month-enumeration fallback: enumeration starts at
            max(joined_month, since_timestamp_month).
        on_game_fetched: Optional callback called once per yielded game (for progress tracking).
        on_archive_skipped: Optional callback invoked with the (year, month) of each
            monthly archive skipped due to a 404/410 (D-03). Lets the caller hold
            `last_synced_at` back to the earliest skipped month instead of letting
            it advance past a month that was never actually fetched.

    Raises:
        ValueError: Two distinct cases on archives-list failure:
            - "user not found" — 404 with body identifying the user as absent, or
              404 with ambiguous body and player endpoint confirms user is absent.
            - "request failed" — non-200 archives response, or ambiguous 404 where
              the player probe also failed; last_synced_at is preserved in both cases.
        RuntimeError: If a per-archive fetch fails persistently (5xx after retries, or
            429 after retries, or unexpected non-200). Raising halts the import so the
            job is marked ``failed`` and ``last_synced_at`` is preserved — preventing
            silent data loss when chess.com / Cloudflare hiccups for a single archive.
            See ``.planning/debug/prod-import-missed-games.md``.
    """
    # chess.com API requires lowercase usernames (returns 301 for mixed case)
    api_username = username.lower()
    archives_url = f"{BASE_URL}/{api_username}/games/archives"
    for attempt in range(_MAX_RETRIES):
        try:
            archives_resp = await client.get(archives_url, headers=_HEADERS)
            break
        except _RETRYABLE_EXCEPTIONS as exc:
            if attempt < _MAX_RETRIES - 1:
                backoff = _RETRY_BACKOFF_BASE_SECONDS * (2**attempt)
                logger.warning(
                    "chess.com archives list for %s failed (attempt %d/%d), retrying in %ds: %s",
                    username,
                    attempt + 1,
                    _MAX_RETRIES,
                    backoff,
                    exc,
                )
                await asyncio.sleep(backoff)
            else:
                # Sentry capture omitted — last-attempt error re-raises to run_import()
                # top-level handler which calls capture_exception (per D-02).
                raise

    if archives_resp.status_code == 404:
        # chess.com returns 404 on /games/archives in TWO distinct cases:
        #   1. User truly absent — body: {"message": "User \"X\" not found."}
        #   2. Real user, archives unavailable (no public archives, or transient
        #      chess.com error) — body: {"message": "An internal error has occurred..."}
        # Pre-2026-04-25 this branch conflated both as "user not found", which sent
        # users with valid accounts on a fruitless typo hunt. We now parse the body
        # and, on ambiguity, probe /pub/player/{username} to disambiguate.
        # See .planning/quick/260425-lii-fix-misleading-chess-com-user-not-found-.
        try:
            body = archives_resp.json()
            message = str(body.get("message", "")) if isinstance(body, dict) else ""
        except ValueError:
            message = ""

        if _CHESSCOM_NOT_FOUND_MARKER in message.lower():
            raise ValueError(f"chess.com user '{username}' not found")

        # Ambiguous body — confirm existence via the player endpoint.
        exists = await _user_exists_on_chesscom(client, api_username)
        if exists is True:
            # Workaround: chess.com's /games/archives endpoint silently 404s for some
            # real accounts (e.g. user 'wasterram', confirmed 2026-04-25) while the
            # individual /games/YYYY/MM endpoints still return games normally. Rather
            # than raising, enumerate months from the player's joined date to today and
            # feed them into the existing per-archive loop. The loop already handles
            # per-month 404/410 (skip), 5xx (retry), and 429 (backoff). Frequency is
            # monitored via a Sentry info-level capture_message.
            joined_at = await _fetch_chesscom_player_joined(client, api_username)
            if joined_at is not None:
                start_ym: tuple[int, int] = (joined_at.year, joined_at.month)
            else:
                start_ym = _CHESSCOM_EARLIEST_ARCHIVE_YEAR_MONTH

            if since_timestamp is not None:
                since_ym = (since_timestamp.year, since_timestamp.month)
                start_ym = max(start_ym, since_ym)

            archive_urls: list[str] = _enumerate_archive_urls(
                api_username, start_ym, _current_year_month()
            )

            logger.info(
                "chess.com archives-list 404 for %s, falling back to month enumeration (%d months)",
                username,
                len(archive_urls),
            )
            sentry_sdk.capture_message(
                "chess.com archives-list 404 — falling back to month enumeration",
                level="info",
                tags={"source": "import", "platform": "chess.com"},
            )
        elif exists is False:
            raise ValueError(f"chess.com user '{username}' not found")
        else:
            # exists is None — player endpoint also failed; treat as transient.
            raise ValueError(
                f"chess.com request failed (status 404, player endpoint unreachable) "
                f"for user '{username}'"
            )
    elif archives_resp.status_code != 200:
        raise ValueError(
            f"chess.com request failed (status {archives_resp.status_code}) for user '{username}'"
        )
    else:
        archive_urls = archives_resp.json().get("archives", [])

    for archive_url in archive_urls:
        # Incremental sync: skip months that are entirely before since_timestamp
        if since_timestamp is not None and _archive_before_timestamp(archive_url, since_timestamp):
            continue

        # Shared rate limiter: limits concurrent archive fetches across all users
        async with get_chesscom_semaphore():
            resp = await _fetch_archive_with_retries(client, archive_url, user_id)

        # _fetch_archive_with_retries returns None only for skippable client errors
        # (404/410). Transient/persistent failures raise RuntimeError instead — this
        # is the fix for the silent-data-loss bug where a transient 5xx on one
        # archive completed the import with 0 games and advanced last_synced_at.
        if resp is None:
            # D-03: report the skipped month so the forward-pass caller can hold
            # last_synced_at back to it instead of letting it advance past a month
            # that was never actually fetched.
            if on_archive_skipped is not None:
                on_archive_skipped(_parse_archive_year_month(archive_url))
            continue

        games = resp.json().get("games", [])
        for game in games:
            # Item 4 (Phase 148): normalize_chesscom_game does direct-subscript
            # lookups (e.g. game["white"]) with no .get() fallback, so a single
            # malformed chess.com game raised an uncaught KeyError that aborted
            # the whole import. Mirror the existing per-game PGN-parse precedent
            # (import_service.py) — skip the bad game, keep the import going.
            try:
                normalized = normalize_chesscom_game(game, username, user_id)
            except Exception as exc:
                logger.warning("Failed to normalize chess.com game for user_id=%s", user_id)
                sentry_sdk.set_context("import", {"platform": "chess.com", "user_id": user_id})
                sentry_sdk.capture_exception(exc)
                continue
            if normalized is not None:
                yield normalized
                if on_game_fetched is not None:
                    on_game_fetched()


async def _yield_games_from_archive(
    resp: httpx.Response, username: str, user_id: int
) -> AsyncIterator[NormalizedGame]:
    """Normalize and yield each game in one already-fetched month archive response.

    Extracted from fetch_chesscom_games_backward's per-month fetch loop body
    (216-06, zero behavior change): same per-game try/except swallow-and-
    continue on normalization failure as the inline code it replaces, mirroring
    fetch_lichess_games's per-line extraction (Task 1 of this plan). Callers
    still own the fetched-game callback since this generator has no visibility
    into the outer retry-attempt vs. per-yield distinction.
    """
    games = resp.json().get("games", [])
    for game in games:
        try:
            normalized = normalize_chesscom_game(game, username, user_id)
        except Exception as exc:
            logger.warning("Failed to normalize chess.com game for user_id=%s", user_id)
            sentry_sdk.set_context("import", {"platform": "chess.com", "user_id": user_id})
            sentry_sdk.capture_exception(exc)
            continue
        if normalized is not None:
            yield normalized


async def fetch_chesscom_games_backward(
    client: httpx.AsyncClient,
    username: str,
    user_id: int,
    oldest_attempted_ym: tuple[int, int] | None,
    should_stop: Callable[[], bool],
    on_game_fetched: Callable[[], None] | None = None,
    on_month_attempted: Callable[[tuple[int, int]], Awaitable[None]] | None = None,
) -> AsyncIterator[NormalizedGame]:
    """Async generator that walks chess.com monthly archives newest -> oldest.

    Phase 186 Plan 02 (IMPORT-03, D-06/D-07). Mirror-image of
    ``fetch_chesscom_games``'s forward (oldest -> newest) walk: this directly
    enumerates archive months (via ``_enumerate_archive_urls``, same as the
    archives-list-404 fallback) rather than consulting the ``/games/archives``
    index, since we need to iterate in reverse from an arbitrary resume point.

    Starts just before ``oldest_attempted_ym`` (or at the current month when the
    cursor is ``None`` -- first backward walk for this user+platform) and walks
    down to the player's joined month. ``should_stop`` is checked BEFORE every
    month fetch (including the very first) so a caller whose budgets are
    already full performs zero HTTP requests. ``on_month_attempted`` fires
    after every attempted month up to and excluding the first skipped
    (404/410) month, regardless of whether it yielded any TC-matching games --
    Pitfall 1: the persisted cursor must track fetch ATTEMPTS, not successful
    inserts, or a month with zero matches would be re-fetched forever. D-03:
    once a month is skipped, the cursor must not advance past it, so the
    callback stops firing for that month and every OLDER month in this walk.

    Args:
        client: Shared httpx.AsyncClient instance.
        username: The chess.com username to fetch games for.
        user_id: Internal database user ID (denormalized into each game dict).
        oldest_attempted_ym: The (year, month) of the oldest month already
            attempted in a previous walk, or None on the very first backward
            walk for this user+platform.
        should_stop: Synchronous closure returning True once the caller's
            per-(platform, TC) budgets are all full (D-07). Checked at month
            granularity only -- a single month's archive may push a budget
            from under-cap to over-cap in one shot (Pitfall 3, accepted).
        on_game_fetched: Optional callback called once per yielded game.
        on_month_attempted: Optional ASYNC callback awaited with the
            (year, month) of each month AFTER it has been fetched (or
            skipped -- as a zero-match 200), so the caller can persist the new
            oldest-attempted cursor incrementally (typically an awaited DB
            write). Stops firing from the first 404/410-skipped month onward
            (D-03) -- a 200-with-zero-games month still fires normally.

    Raises:
        RuntimeError: If a per-archive fetch fails persistently (5xx after
            retries, 429 after retries, or unexpected non-200) -- mirrors
            ``fetch_chesscom_games``'s failure contract so the import job is
            marked failed and the previously-persisted cursor is preserved.
    """
    if should_stop():
        return

    api_username = username.lower()

    joined_at = await _fetch_chesscom_player_joined(client, api_username)
    if joined_at is not None:
        start_ym: tuple[int, int] = (joined_at.year, joined_at.month)
    else:
        start_ym = _CHESSCOM_EARLIEST_ARCHIVE_YEAR_MONTH

    end_ym = (
        _month_before(oldest_attempted_ym)
        if oldest_attempted_ym is not None
        else _current_year_month()
    )

    if start_ym > end_ym:
        # Cursor already sits at (or before) the player's joined month --
        # history for this user is fully attempted.
        return

    archive_urls = _enumerate_archive_urls(api_username, start_ym, end_ym)

    # D-03: once a month's fetch is skipped (404/410), the cursor must not move
    # past it or that month is lost permanently. Suppressing on_month_attempted
    # for the remainder of this walk (months only get OLDER from here, since
    # the walk is newest -> oldest) pins the persisted cursor to the last clean
    # month. Re-walking already-attempted older months next Sync is deliberate
    # and safe: bulk_insert_games is ON CONFLICT DO NOTHING, and the CR-01 dedup
    # in _admit_backward_game means an already-imported platform_game_id never
    # counts against the budget again -- re-attempts cost time, not correctness.
    skipped_any = False

    for archive_url in reversed(archive_urls):
        if should_stop():
            break

        # Shared rate limiter: limits concurrent archive fetches across all users.
        async with get_chesscom_semaphore():
            resp = await _fetch_archive_with_retries(client, archive_url, user_id)

        year, month = _parse_archive_year_month(archive_url)

        # _fetch_archive_with_retries returns None only for skippable client
        # errors (404/410) -- treat as an attempted-but-empty month, not a stop.
        if resp is not None:
            async for normalized in _yield_games_from_archive(resp, username, user_id):
                yield normalized
                if on_game_fetched is not None:
                    on_game_fetched()
        else:
            skipped_any = True

        if on_month_attempted is not None and not skipped_any:
            await on_month_attempted((year, month))


async def _fetch_archive_with_retries(
    client: httpx.AsyncClient, archive_url: str, user_id: int
) -> httpx.Response | None:
    """Fetch a single monthly archive with retry policy.

    Args:
        client: Shared httpx.AsyncClient instance.
        archive_url: Full monthly archive URL, e.g. .../games/2024/03.
        user_id: Internal database user ID, attached to the skip-event Sentry
            context (D-02) so a skip is triageable without reconstructing the
            user + month from the event timestamp against import_jobs.

    Returns:
        The 200 response on success, or ``None`` if the archive returned a permanent
        client error (404/410) that should be skipped without failing the import.

    Raises:
        RuntimeError: If retries are exhausted on a transient error (5xx or 429), or
            an unexpected non-200 status is returned. Raising halts the import so the
            job is marked failed and last_synced_at is preserved.
        Exception: Re-raises the last network exception if all retry attempts threw
            connection-level errors.
    """
    last_status: int | None = None
    last_exc: Exception | None = None

    for attempt in range(_MAX_RETRIES):
        # Rate-limit delay between requests (also acts as inter-attempt pacing).
        await asyncio.sleep(0.15)

        try:
            resp = await client.get(archive_url, headers=_HEADERS)
        except _RETRYABLE_EXCEPTIONS as exc:
            last_exc = exc
            if attempt < _MAX_RETRIES - 1:
                backoff = _RETRY_BACKOFF_BASE_SECONDS * (2**attempt)
                logger.warning(
                    "chess.com archive %s failed (attempt %d/%d), retrying in %ds: %s",
                    archive_url,
                    attempt + 1,
                    _MAX_RETRIES,
                    backoff,
                    exc,
                )
                await asyncio.sleep(backoff)
                continue
            # Last attempt: re-raise so run_import() captures and fails the job.
            raise

        if resp.status_code == 200:
            return resp

        last_status = resp.status_code

        # Permanent client errors — skip this archive but keep going. Visible in logs
        # and Sentry (warning) so we can still notice if it becomes systemic.
        if resp.status_code in _SKIPPABLE_ARCHIVE_STATUS_CODES:
            logger.warning(
                "chess.com archive %s returned %d, skipping",
                archive_url,
                resp.status_code,
            )
            # Bug fix (FLAWCHESS-39, quick-260806-p9n): a 404 on /games/YYYY/MM for a
            # valid user is a chess.com server-side fault, not an empty month —
            # genuinely empty and pre-join months both return 200 with {"games": []}
            # (probed live 2026-08-06 for ocnafr: 2025/09 and 2020/01 returned 200-empty,
            # while 2025/11 returned a persistent 404 with the same ambiguous "internal
            # error" body the archives-list handler above already distrusts, despite
            # 2025/11 being listed in that player's archives index). Treating it as
            # attempted-but-empty was silent data loss of the same class as the 5xx bug
            # in .planning/debug/prod-import-missed-games.md, and the event was
            # untriageable from Sentry alone because it previously carried only
            # source/platform tags. Context must be set BEFORE capture_message, and the
            # message string must stay a literal with no interpolation (CLAUDE.md Sentry
            # rule) so this issue keeps its existing grouping.
            sentry_sdk.set_context(
                "import",
                {
                    "platform": "chess.com",
                    "user_id": user_id,
                    "archive_url": archive_url,
                    "status": resp.status_code,
                },
            )
            sentry_sdk.capture_message(
                "chess.com archive skipped",
                level="warning",
                tags={"source": "import", "platform": "chess.com"},
            )
            return None

        # Rate-limited: back off and retry.
        if resp.status_code == 429:
            logger.warning(
                "chess.com 429 rate-limited on %s (attempt %d/%d), backing off %ds",
                archive_url,
                attempt + 1,
                _MAX_RETRIES,
                _RATE_LIMIT_BACKOFF_SECONDS,
            )
            sentry_sdk.capture_message(
                "chess.com 429 rate limit hit",
                level="warning",
                tags={"source": "import", "platform": "chess.com"},
            )
            if attempt < _MAX_RETRIES - 1:
                await asyncio.sleep(_RATE_LIMIT_BACKOFF_SECONDS)
                continue
            # Final attempt still 429 — fail loudly rather than silently dropping
            # the archive (would otherwise advance last_synced_at and lose games).
            raise RuntimeError(
                f"chess.com archive {archive_url} rate-limited after {_MAX_RETRIES} attempts"
            )

        # Transient server errors — retry with exponential backoff.
        if resp.status_code in _RETRYABLE_STATUS_CODES:
            if attempt < _MAX_RETRIES - 1:
                backoff = _RETRY_BACKOFF_BASE_SECONDS * (2**attempt)
                logger.warning(
                    "chess.com archive %s returned %d (attempt %d/%d), retrying in %ds",
                    archive_url,
                    resp.status_code,
                    attempt + 1,
                    _MAX_RETRIES,
                    backoff,
                )
                await asyncio.sleep(backoff)
                continue
            raise RuntimeError(
                f"chess.com archive {archive_url} returned "
                f"status {resp.status_code} after {_MAX_RETRIES} attempts"
            )

        # Any other unexpected non-200 (e.g. 401, 403). Don't silently skip — fail
        # loudly so a regression in chess.com's API surface is investigated rather
        # than masked as "0 games imported".
        raise RuntimeError(
            f"chess.com archive {archive_url} returned unexpected status {resp.status_code}"
        )

    # Loop exhausted without returning — shouldn't happen because each branch above
    # either returns, continues, or raises. Treat as failure for safety.
    raise RuntimeError(
        f"chess.com archive {archive_url} fetch exhausted retries "
        f"(last_status={last_status}, last_exc={last_exc!r})"
    )
