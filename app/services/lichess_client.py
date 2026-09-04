"""lichess API client.

Fetches games for a user via NDJSON streaming and yields normalized game dicts.
Supports incremental sync via the ``since`` millisecond timestamp parameter.
"""

import asyncio
from contextlib import aclosing
import json
import logging
from collections.abc import AsyncGenerator, AsyncIterator, Callable

import httpx
import sentry_sdk

from app.core.http import USER_AGENT
from app.core.rate_limiters import get_lichess_semaphore
from app.schemas.normalization import NormalizedGame
from app.services.normalization import normalize_lichess_game

logger = logging.getLogger(__name__)

LICHESS_API_URL = "https://lichess.org/api/games/user"

# Retry config for transient stream errors (e.g. "peer closed connection") and
# transient HTTP status failures (5xx, 429). Lichess NDJSON streams for large
# exports (10k+ games) can drop mid-transfer.
_MAX_RETRIES = 3
_RETRY_BACKOFF_BASE_SECONDS = 5
# Lichess docs: "If you receive an HTTP response with a 429 status, please wait
# a full minute before resuming API usage."
_RATE_LIMIT_BACKOFF_SECONDS = 60

# Status codes that represent transient server-side failures and should be retried
# with exponential backoff.
_RETRYABLE_STATUS_CODES = frozenset({500, 502, 503, 504})


class _RetryableStatusError(Exception):
    """Internal sentinel raised when lichess returns a retryable transient status.

    Caught by the retry loop in fetch_lichess_games. Distinct from RuntimeError
    so that unexpected non-200 codes (e.g. 401/403) fail loudly without retry,
    while 429/5xx are retried like stream-level connection drops.
    """

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def _raise_for_status(response: httpx.Response, username: str) -> None:
    """Raise if `response`'s status signals not-found, a retryable failure, or a fatal error.

    Returns normally on 200. Extracted from fetch_lichess_games's status-code
    branch chain (216-06, zero behavior change): same exception types, same
    ordering, same status codes as the inline code it replaces.
    """
    if response.status_code == 404:
        raise ValueError(f"lichess user '{username}' not found")

    # Check status BEFORE iterating lines. httpx.stream() does not
    # auto-raise on non-2xx, and aiter_lines() on an error body
    # would silently produce 0 games and advance last_synced_at.
    if response.status_code != 200:
        if response.status_code == 429:
            sentry_sdk.capture_message(
                "lichess 429 rate limit hit",
                level="warning",
                tags={"source": "import", "platform": "lichess"},
            )
            raise _RetryableStatusError(
                f"lichess returned 429 for {username}",
                status_code=429,
            )
        if response.status_code in _RETRYABLE_STATUS_CODES:
            raise _RetryableStatusError(
                f"lichess returned {response.status_code} for {username}",
                status_code=response.status_code,
            )
        # Unexpected non-200 (401/403/etc). Fail loudly rather than
        # masking it as "0 games imported".
        raise RuntimeError(
            f"lichess request for {username} returned unexpected status {response.status_code}"
        )


def _normalize_line(line: str, username: str, user_id: int) -> NormalizedGame | None:
    """Parse and normalize one NDJSON line, or return `None` to signal skip.

    Extracted from fetch_lichess_games's per-line parse+normalize block
    (216-06, zero behavior change): swallows exactly `json.JSONDecodeError`
    (malformed line) and `Exception` (normalization failure, captured to
    Sentry), same as the inline code it replaces.
    """
    try:
        game = json.loads(line)
    except json.JSONDecodeError:
        # Skip malformed lines without aborting the stream
        return None

    # Item 4 (Phase 148): normalize_lichess_game does direct
    # dict lookups (e.g. game["players"]) with no fallback,
    # so a single structurally-malformed (but valid-JSON)
    # game raised an uncaught KeyError that aborted the
    # whole import. Mirror the per-game PGN-parse precedent
    # (import_service.py) — skip the bad game, keep going.
    # Leave the json.JSONDecodeError guard above untouched.
    try:
        normalized = normalize_lichess_game(game, username, user_id)
    except Exception as exc:
        logger.warning("Failed to normalize lichess game for user_id=%s", user_id)
        sentry_sdk.set_context("import", {"platform": "lichess", "user_id": user_id})
        sentry_sdk.capture_exception(exc)
        return None
    return normalized


def _noop() -> None:
    """Default per-game hook when the caller passes none."""


async def _stream_one_attempt(
    client: httpx.AsyncClient,
    url: str,
    params: dict[str, str | bool],
    headers: dict[str, str],
    username: str,
    user_id: int,
) -> AsyncGenerator[NormalizedGame, None]:
    """Stream and normalize one attempt's NDJSON games, raising on status/stream failure.

    Extracted from fetch_lichess_games's semaphore+stream+per-line loop
    (216-06) so the outer retry loop's try/except and fetched-game callback
    stay under the depth-4 gate (D-13/D-14): two helpers alone (`_raise_for_status`,
    `_normalize_line`) still left the outer generator's yield+callback chain at
    depth 5, so this third helper takes the per-NDJSON-line seam further, per
    the plan's own escape valve ("take the second seam further rather than
    adding a pragma"). Zero behavior change: the same exception types raised by
    `_raise_for_status` propagate unchanged to the caller's retry handling.
    """
    async with (
        get_lichess_semaphore(),
        client.stream("GET", url, params=params, headers=headers, timeout=300.0) as response,
    ):
        _raise_for_status(response, username)

        async for line in response.aiter_lines():
            if not line.strip():
                continue

            normalized = _normalize_line(line, username, user_id)
            if normalized is not None:
                yield normalized


async def fetch_lichess_games(
    client: httpx.AsyncClient,
    username: str,
    user_id: int,
    since_ms: int | None = None,
    until_ms: int | None = None,
    max_games: int | None = None,
    perf_type: str | None = None,
    on_game_fetched: Callable[[], None] | None = None,
) -> AsyncIterator[NormalizedGame]:
    """Async generator that yields normalized NormalizedGame objects for a lichess user.

    Streams NDJSON from the lichess API line-by-line using httpx streaming,
    so large exports never need to be buffered in memory. Retries on transient
    connection drops and 5xx/429 responses — already-imported games are
    deduplicated downstream by bulk_insert_games.

    Args:
        client: Shared httpx.AsyncClient instance.
        username: The lichess username to fetch games for.
        user_id: Internal database user ID (denormalized into each game dict).
        since_ms: If provided, only games created at or after this Unix millisecond
            timestamp are returned (lichess ``since`` parameter).
        until_ms: If provided, only games played at or before this Unix millisecond
            timestamp are returned (lichess ``until`` parameter). Phase 186 Plan 02
            (IMPORT-03, D-06): used by the backward-fetch backlog walk. Purely
            additive to the existing streaming/retry loop — lichess defaults to
            ``sort=dateDesc`` (newest-first), so combined with ``max_games`` the
            LAST game yielded in a bounded call is the OLDEST one in that chunk;
            its ``played_at`` becomes the next ``until_ms`` cursor for the caller's
            next backward-walk iteration.
        max_games: If provided, caps the number of games lichess returns
            (server-side ``max`` parameter). Used by benchmark ingest to truncate
            per-(user, TC) volume, and by the backward-walk to bound each chunk;
            forward/incremental user-facing imports leave this ``None``.
        perf_type: If provided, restricts results to one or more comma-separated
            perfTypes (``bullet``/``blitz``/``rapid``/``classical``/``correspondence``/...).
            Opt-in because this filter silently truncates: e.g. a bare
            ``perfType=classical`` excludes correspondence, chess960, and imported
            (fromPosition) games server-side (D-14). Benchmark ingest and the
            backward-walk want that server-side truncation as a bandwidth
            optimization; forward/incremental user-facing imports leave this
            ``None`` and rely solely on the post-fetch TC filter (D-02).
        on_game_fetched: Optional callback called once per yielded game.

    Raises:
        ValueError: If ``username`` is not found on lichess (HTTP 404).
        RuntimeError: If lichess returns persistent failure (5xx after retries,
            429 after retries, or unexpected non-200 such as 401/403). Raising
            halts the import so the job is marked ``failed`` and ``last_synced_at``
            is preserved — preventing silent data loss when an error body would
            otherwise be parsed as "0 games" and the cursor advanced. See
            ``.planning/debug/prod-import-missed-games.md`` for the chess.com
            sibling of this bug.
    """
    params: dict[str, str | bool] = {
        "pgnInJson": True,
        "moves": True,
        "tags": True,
        "opening": True,
        "clocks": True,  # include %clk annotations for time-per-move data
        "evals": True,  # include %eval annotations when prior computer analysis exists
        "accuracy": True,  # include per-player accuracy % for analyzed games
    }

    if since_ms is not None:
        params["since"] = str(since_ms)
    if until_ms is not None:
        params["until"] = str(until_ms)
    if max_games is not None:
        params["max"] = str(max_games)
    if perf_type is not None:
        params["perfType"] = perf_type

    url = f"{LICHESS_API_URL}/{username}"
    # User-Agent is mandatory: since ~2026-07-22 lichess answers generic client UAs
    # (python-httpx default) with a fake 404 on this endpoint, which the 404 branch
    # below would misreport as "user not found" for users that exist.
    headers = {"Accept": "application/x-ndjson", "User-Agent": USER_AGENT}

    # Initialize with a sentinel so raise always has a valid exception even if no
    # attempt captured a specific error (e.g., _MAX_RETRIES == 0).
    last_attempt_error: Exception = Exception("Exhausted retries without capturing an error")
    # A no-op default keeps the per-game hook unconditional inside the stream loop
    # (one nesting level fewer under the aclosing() block below).
    notify_game_fetched: Callable[[], None] = on_game_fetched or _noop

    for attempt in range(_MAX_RETRIES + 1):
        if attempt > 0:
            # Lichess asks for a full minute after a 429; use shorter exponential
            # backoff for stream/5xx errors.
            if (
                isinstance(last_attempt_error, _RetryableStatusError)
                and last_attempt_error.status_code == 429
            ):
                backoff = _RATE_LIMIT_BACKOFF_SECONDS
            else:
                backoff = _RETRY_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
            logger.warning(
                "Lichess fetch for %s failed (attempt %d/%d), retrying in %ds: %s",
                username,
                attempt,
                _MAX_RETRIES,
                backoff,
                last_attempt_error,
            )
            await asyncio.sleep(backoff)

        try:
            # Semaphore held for entire stream duration (inside _stream_one_attempt).
            # Lichess streams in one HTTP connection per job, so the semaphore limits
            # concurrent connections, not individual requests.
            # aclosing(): an `async for` does not aclose() its iterator when the loop
            # body raises (a DB write in import_service can), and the semaphore +
            # open HTTP stream now live in the inner generator's frame. Without this
            # their release would wait for GC of two abandoned generators instead of
            # unwinding deterministically as it did before the extraction (216 review WR-01).
            async with aclosing(
                _stream_one_attempt(client, url, params, headers, username, user_id)
            ) as stream:
                async for normalized in stream:
                    yield normalized
                    notify_game_fetched()

            # Stream completed successfully — no retry needed
            return

        except (httpx.RemoteProtocolError, httpx.ReadError, _RetryableStatusError) as exc:
            # Transient errors. Stream-level: "peer closed connection without
            # sending complete message body". Status-level: 5xx / 429.
            # Safe to retry because bulk_insert_games deduplicates already-
            # imported games.
            # Sentry capture omitted for stream errors — last-attempt error
            # propagates to run_import() top-level handler which calls
            # capture_exception (per D-02). Status-429 captures a warning above.
            last_attempt_error = exc
            continue

    # All retries exhausted. Convert internal _RetryableStatusError to RuntimeError
    # so callers see a consistent failure surface (matches chesscom_client).
    if isinstance(last_attempt_error, _RetryableStatusError):
        raise RuntimeError(
            f"lichess request for {username} failed after {_MAX_RETRIES} retries: "
            f"status {last_attempt_error.status_code}"
        ) from last_attempt_error
    raise last_attempt_error
