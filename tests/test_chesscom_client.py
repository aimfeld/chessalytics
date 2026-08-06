"""Tests for the chess.com API client.

Uses unittest.mock to patch httpx.AsyncClient.get to avoid real HTTP calls.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.chesscom_client import (
    fetch_chesscom_games,
    fetch_chesscom_games_backward,
    _archive_before_timestamp,
    _fetch_chesscom_player_joined,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_game(
    uuid: str = "game-uuid-1",
    rules: str = "chess",
    username: str = "testuser",
    white_username: str = "testuser",
    black_username: str = "opponent",
    time_control: str = "600+0",
    rated: bool = True,
) -> dict:
    """Build a minimal chess.com game dict."""
    return {
        "uuid": uuid,
        "url": f"https://www.chess.com/game/live/{uuid}",
        "pgn": '[White "testuser"]\n1. e4 e5 *',
        "time_control": time_control,
        "rated": rated,
        "rules": rules,
        "white": {
            "username": white_username,
            "rating": 1200,
            "result": "win" if white_username == username else "checkmated",
        },
        "black": {
            "username": black_username,
            "rating": 1100,
            "result": "checkmated" if white_username == username else "win",
        },
        "end_time": 1700000000,
        "eco": "https://www.chess.com/openings/C50",
    }


def _make_response(json_data: dict, status_code: int = 200) -> MagicMock:
    """Build a mock httpx response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data
    resp.raise_for_status = MagicMock()
    return resp


# ---------------------------------------------------------------------------
# _archive_before_timestamp helper
# ---------------------------------------------------------------------------


class TestArchiveBeforeTimestamp:
    def test_old_archive_is_before(self):
        """An archive from 2020/01 should be before a 2024 timestamp."""
        since = datetime(2024, 1, 1, tzinfo=timezone.utc)
        url = "https://api.chess.com/pub/player/testuser/games/2020/01"
        assert _archive_before_timestamp(url, since) is True

    def test_current_archive_is_not_before(self):
        """An archive from the same month as since should NOT be skipped."""
        since = datetime(2024, 3, 15, tzinfo=timezone.utc)
        url = "https://api.chess.com/pub/player/testuser/games/2024/03"
        assert _archive_before_timestamp(url, since) is False

    def test_future_archive_is_not_before(self):
        """A future archive is not before since."""
        since = datetime(2023, 6, 1, tzinfo=timezone.utc)
        url = "https://api.chess.com/pub/player/testuser/games/2024/01"
        assert _archive_before_timestamp(url, since) is False

    def test_previous_month_is_before(self):
        """An archive from the month before since should be skipped."""
        since = datetime(2024, 4, 1, tzinfo=timezone.utc)
        url = "https://api.chess.com/pub/player/testuser/games/2024/03"
        assert _archive_before_timestamp(url, since) is True


# ---------------------------------------------------------------------------
# fetch_chesscom_games
# ---------------------------------------------------------------------------


class TestFetchChesscomGames:
    @pytest.mark.asyncio
    async def test_valid_username_yields_normalized_games(self):
        """Should yield a normalized game dict for a standard chess game."""
        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        games_resp = _make_response({"games": [_make_game()]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, games_resp])

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            results = []
            async for game in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                results.append(game)

        assert len(results) == 1
        assert results[0].platform == "chess.com"
        assert results[0].platform_game_id == "game-uuid-1"
        assert results[0].user_id == 1

    @pytest.mark.asyncio
    async def test_malformed_game_skipped_and_continues(self):
        """A malformed game (missing the 'white' key -> KeyError in normalize)
        is skipped; the remaining good games are still yielded and one Sentry
        capture is recorded for the bad game (item 4, Phase 148)."""
        good1 = _make_game(uuid="game-uuid-1")
        malformed = _make_game(uuid="game-uuid-bad")
        del malformed["white"]
        good2 = _make_game(uuid="game-uuid-2")

        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        games_resp = _make_response({"games": [good1, malformed, good2]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, games_resp])

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client.sentry_sdk.capture_exception") as mock_capture,
        ):
            results = []
            async for game in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                results.append(game)

        assert [g.platform_game_id for g in results] == ["game-uuid-1", "game-uuid-2"]
        assert mock_capture.call_count == 1

    @pytest.mark.asyncio
    async def test_404_raises_value_error(self):
        """Should raise ValueError when the chess.com user is not found.

        Empty-body 404 falls into the ambiguous branch (no 'not found' substring),
        so the player endpoint is probed. Mock it as 404 to exercise the fallback
        'not found' path.
        """
        # Archives endpoint: 404 with empty body (ambiguous — no "not found" text)
        archives_not_found_resp = _make_response({}, status_code=404)
        # Player endpoint: also 404 (user truly absent — fallback)
        player_not_found_resp = _make_response({}, status_code=404)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_not_found_resp, player_not_found_resp])

        with pytest.raises(ValueError, match="chess.com user 'unknown_user' not found"):
            async for _ in fetch_chesscom_games(mock_client, "unknown_user", user_id=1):
                pass

    @pytest.mark.asyncio
    async def test_404_with_user_not_found_body_raises_not_found_error(self):
        """404 with body containing 'not found' text raises immediately without
        probing the player endpoint."""
        archives_resp = _make_response({"message": 'User "unknown" not found.'}, status_code=404)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=archives_resp)

        with pytest.raises(ValueError, match="chess.com user 'unknown' not found"):
            async for _ in fetch_chesscom_games(mock_client, "unknown", user_id=1):
                pass

        # Player endpoint must NOT be called — the body already disambiguates
        assert mock_client.get.call_count == 1

    @pytest.mark.asyncio
    async def test_404_with_internal_error_body_and_player_200_falls_back_to_enumeration(self):
        """404 with ambiguous internal-error body, player endpoint returns 200 (user exists).
        Should NOT raise — instead falls back to month enumeration (260425-lwz).
        Player has no 'joined' field, so enumeration starts at 2007-01. 'now' is
        patched to (2007, 1) to keep the test fast (only one month synthesized, which 404s).
        """
        archives_resp = _make_response(
            {"message": "An internal error has occurred. Please contact support."},
            status_code=404,
        )
        # exists probe — 200 but no 'joined' field
        exists_resp = _make_response(
            {"username": "wasterram", "player_id": 123456}, status_code=200
        )
        # _fetch_chesscom_player_joined — same endpoint, also no 'joined' → None
        joined_resp = _make_response(
            {"username": "wasterram", "player_id": 123456}, status_code=200
        )
        # Synthesized archive 2007/01 → 404 (skipped)
        archive_resp = _make_response({}, status_code=404)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[archives_resp, exists_resp, joined_resp, archive_resp]
        )

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2007, 1)),
        ):
            results = []
            async for game in fetch_chesscom_games(mock_client, "wasterram", user_id=1):
                results.append(game)

        # No raise; 0 games (archive 404'd); correct call count
        assert results == []
        assert mock_client.get.call_count == 4

    @pytest.mark.asyncio
    async def test_404_with_internal_error_body_and_player_404_falls_back_to_not_found(self):
        """404 with ambiguous body, player endpoint also 404: user truly absent.
        Should raise the standard 'user not found' ValueError."""
        archives_resp = _make_response(
            {"message": "An internal error has occurred."},
            status_code=404,
        )
        player_resp = _make_response({}, status_code=404)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, player_resp])

        with pytest.raises(ValueError, match="chess.com user 'ghostuser' not found"):
            async for _ in fetch_chesscom_games(mock_client, "ghostuser", user_id=1):
                pass

    @pytest.mark.asyncio
    async def test_404_with_internal_error_body_and_player_500_raises_request_failed(self):
        """404 with ambiguous body, player endpoint returns 5xx: treat as transient failure.
        Should raise 'request failed' ValueError so last_synced_at is preserved."""
        archives_resp = _make_response(
            {"message": "An internal error has occurred."},
            status_code=404,
        )
        player_resp = _make_response({}, status_code=500)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, player_resp])

        with pytest.raises(ValueError, match="chess.com request failed"):
            async for _ in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                pass

    @pytest.mark.asyncio
    async def test_user_agent_header_sent(self):
        """Should include the User-Agent header on every request."""
        archives_resp = _make_response({"archives": []})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=archives_resp)

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            async for _ in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                pass

        call_kwargs = mock_client.get.call_args_list[0][1]
        headers = call_kwargs.get("headers", {})
        assert "User-Agent" in headers
        assert "FlawChess" in headers["User-Agent"]

    @pytest.mark.asyncio
    async def test_incremental_sync_skips_old_months(self):
        """Should skip archive months that end before since_timestamp."""
        # Two archives: one old (should be skipped), one current (should be fetched)
        archives_resp = _make_response(
            {
                "archives": [
                    "https://api.chess.com/pub/player/testuser/games/2020/01",  # old
                    "https://api.chess.com/pub/player/testuser/games/2024/03",  # current
                ]
            }
        )
        games_resp = _make_response({"games": [_make_game()]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, games_resp])

        since = datetime(2024, 1, 1, tzinfo=timezone.utc)

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            results = []
            async for game in fetch_chesscom_games(
                mock_client, "testuser", user_id=1, since_timestamp=since
            ):
                results.append(game)

        # Only the 2024/03 archive should have been fetched (1 game)
        # The archives call + 1 game archive call = 2 total calls (not 3)
        assert mock_client.get.call_count == 2
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_non_standard_variant_games_skipped(self):
        """Games with rules != 'chess' should be filtered out."""
        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        games_resp = _make_response(
            {
                "games": [
                    _make_game(uuid="chess960-game", rules="chess960"),
                    _make_game(uuid="standard-game", rules="chess"),
                ]
            }
        )

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, games_resp])

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            results = []
            async for game in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                results.append(game)

        assert len(results) == 1
        assert results[0].platform_game_id == "standard-game"

    @pytest.mark.asyncio
    async def test_on_game_fetched_callback_called(self):
        """on_game_fetched should be called once for each yielded game."""
        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        games_resp = _make_response({"games": [_make_game(uuid="g1"), _make_game(uuid="g2")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, games_resp])

        callback = MagicMock()

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            async for _ in fetch_chesscom_games(
                mock_client, "testuser", user_id=1, on_game_fetched=callback
            ):
                pass

        assert callback.call_count == 2

    @pytest.mark.asyncio
    async def test_429_backs_off_and_retries(self):
        """On 429 response, should sleep 60s then retry once."""
        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        rate_limited_resp = _make_response({}, status_code=429)
        games_resp = _make_response({"games": [_make_game()]})

        mock_client = AsyncMock()
        # archives OK, first archive call → 429, retry → success
        mock_client.get = AsyncMock(side_effect=[archives_resp, rate_limited_resp, games_resp])

        sleep_mock = AsyncMock()
        with patch("app.services.chesscom_client.asyncio.sleep", new=sleep_mock):
            results = []
            async for game in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                results.append(game)

        # Should have slept at least once for 60 seconds (backoff)
        sleep_calls = [call.args[0] for call in sleep_mock.call_args_list]
        assert 60 in sleep_calls
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_429_persistent_raises_runtime_error(self):
        """Persistent 429 across all retries should raise RuntimeError, not silently
        skip. Silent skip would advance last_synced_at and permanently lose any games
        in that archive (see prod-import-missed-games debug session)."""
        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        rate_limited_resp = _make_response({}, status_code=429)

        mock_client = AsyncMock()
        # archives OK, then every retry returns 429
        mock_client.get = AsyncMock(side_effect=[archives_resp] + [rate_limited_resp] * 10)

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            with pytest.raises(RuntimeError, match="rate-limited"):
                async for _ in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                    pass

    @pytest.mark.asyncio
    async def test_empty_archives_yields_nothing(self):
        """A user with no archives should yield nothing."""
        archives_resp = _make_response({"archives": []})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=archives_resp)

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            results = []
            async for game in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                results.append(game)

        assert results == []

    @pytest.mark.asyncio
    async def test_410_on_archives_raises_value_error(self):
        """410 on archives endpoint (e.g. email-format username) should raise ValueError."""
        gone_resp = _make_response({}, status_code=410)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=gone_resp)

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            with pytest.raises(ValueError, match="chess.com request failed"):
                async for _ in fetch_chesscom_games(mock_client, "user@domain.com", user_id=1):
                    pass

    @pytest.mark.asyncio
    async def test_403_on_archives_raises_value_error(self):
        """403 on archives endpoint should raise ValueError."""
        forbidden_resp = _make_response({}, status_code=403)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=forbidden_resp)

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            with pytest.raises(ValueError, match="chess.com request failed"):
                async for _ in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                    pass

    @pytest.mark.asyncio
    async def test_500_on_archives_raises_value_error(self):
        """500 on archives endpoint should raise ValueError."""
        server_error_resp = _make_response({}, status_code=500)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=server_error_resp)

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            with pytest.raises(ValueError, match="chess.com request failed"):
                async for _ in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                    pass

    @pytest.mark.asyncio
    async def test_500_on_archive_fetch_retries_then_raises(self):
        """Persistent 500 on a per-archive fetch should raise RuntimeError after
        retries — NOT silently skip the archive. Silent-skip combined with
        last_synced_at advancement caused permanent data loss in prod
        (see prod-import-missed-games debug session)."""
        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        server_error_resp = _make_response({}, status_code=500)

        mock_client = AsyncMock()
        # archives OK, then every retry returns 500 (more 500s than _MAX_RETRIES)
        mock_client.get = AsyncMock(side_effect=[archives_resp] + [server_error_resp] * 10)

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            with pytest.raises(RuntimeError, match="status 500"):
                async for _ in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                    pass

    @pytest.mark.asyncio
    async def test_503_on_archive_fetch_retries_then_succeeds(self):
        """A transient 503 should retry and succeed when the next attempt returns 200.
        This is the common Cloudflare/origin-hiccup scenario the silent-skip behavior
        used to mask."""
        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        server_error_resp = _make_response({}, status_code=503)
        games_resp = _make_response({"games": [_make_game()]})

        mock_client = AsyncMock()
        # archives OK, archive 503, retry → 200 with one game
        mock_client.get = AsyncMock(side_effect=[archives_resp, server_error_resp, games_resp])

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            results = []
            async for game in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                results.append(game)

        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_410_on_archive_fetch_skips_archive(self):
        """410 on a per-archive fetch should skip that archive gracefully — this is a
        permanent client error meaning the archive is gone, not a transient failure
        that risks data loss for the rest of the import.

        D-05: also asserts the skip is REPORTED via on_archive_skipped, not just
        silently dropped — distinguishes "skipped and remembered" from "skipped
        and forgotten" (results == [] alone stays true under a broken D-03 fix)."""
        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        gone_resp = _make_response({}, status_code=410)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, gone_resp])

        skipped_months: list[tuple[int, int]] = []

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            results = []
            async for game in fetch_chesscom_games(
                mock_client,
                "testuser",
                user_id=1,
                on_archive_skipped=skipped_months.append,
            ):
                results.append(game)

        assert results == []
        assert skipped_months == [(2024, 3)]

    @pytest.mark.asyncio
    async def test_404_on_archive_skip_reports_sentry_context_before_message(self):
        """D-02: a skipped archive attaches an 'import' Sentry context carrying
        archive_url, status, user_id and platform BEFORE capture_message fires,
        and the capture_message text stays the literal 'chess.com archive
        skipped' with zero interpolated variables so FLAWCHESS-39 keeps its
        existing grouping (CLAUDE.md Sentry rule)."""
        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        not_found_resp = _make_response({}, status_code=404)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, not_found_resp])

        call_order: list[str] = []

        def _record_context(*args: object, **kwargs: object) -> None:
            call_order.append("set_context")

        def _record_message(*args: object, **kwargs: object) -> None:
            call_order.append("capture_message")

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch(
                "app.services.chesscom_client.sentry_sdk.set_context",
                side_effect=_record_context,
            ) as mock_set_context,
            patch(
                "app.services.chesscom_client.sentry_sdk.capture_message",
                side_effect=_record_message,
            ) as mock_capture_message,
        ):
            async for _ in fetch_chesscom_games(mock_client, "testuser", user_id=42):
                pass

        assert call_order == ["set_context", "capture_message"]

        context_args = mock_set_context.call_args
        assert context_args.args[0] == "import"
        context_payload = context_args.args[1]
        assert context_payload["archive_url"] == (
            "https://api.chess.com/pub/player/testuser/games/2024/03"
        )
        assert context_payload["status"] == 404
        assert context_payload["user_id"] == 42
        assert context_payload["platform"] == "chess.com"

        message_args = mock_capture_message.call_args
        assert message_args.args[0] == "chess.com archive skipped"

    @pytest.mark.asyncio
    async def test_forward_skip_reports_month_and_still_yields_later_games(self):
        """D-03 forward: a 404'd month fires on_archive_skipped exactly once with
        its (year, month) and the walk still yields games from a later month."""
        archives_resp = _make_response(
            {
                "archives": [
                    "https://api.chess.com/pub/player/testuser/games/2024/03",
                    "https://api.chess.com/pub/player/testuser/games/2024/04",
                ]
            }
        )
        not_found_resp = _make_response({}, status_code=404)
        april_resp = _make_response({"games": [_make_game(uuid="april-game")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, not_found_resp, april_resp])

        skipped_months: list[tuple[int, int]] = []

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            results = []
            async for game in fetch_chesscom_games(
                mock_client,
                "testuser",
                user_id=1,
                on_archive_skipped=skipped_months.append,
            ):
                results.append(game)

        assert skipped_months == [(2024, 3)]
        assert [g.platform_game_id for g in results] == ["april-game"]

    @pytest.mark.asyncio
    async def test_forward_empty_200_month_is_not_a_skip(self):
        """D-03 forward: a 200 with an empty games array is NOT a skip — Pitfall 1
        must not be reintroduced as an infinite re-fetch loop for legitimately
        empty months."""
        archives_resp = _make_response(
            {
                "archives": [
                    "https://api.chess.com/pub/player/testuser/games/2024/03",
                    "https://api.chess.com/pub/player/testuser/games/2024/04",
                ]
            }
        )
        empty_march_resp = _make_response({"games": []})
        april_resp = _make_response({"games": [_make_game(uuid="april-game")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, empty_march_resp, april_resp])

        skipped_months: list[tuple[int, int]] = []

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            results = []
            async for game in fetch_chesscom_games(
                mock_client,
                "testuser",
                user_id=1,
                on_archive_skipped=skipped_months.append,
            ):
                results.append(game)

        assert skipped_months == []
        assert [g.platform_game_id for g in results] == ["april-game"]

    @pytest.mark.asyncio
    async def test_404_on_archive_fetch_skips_archive(self):
        """404 on a per-archive fetch (e.g. archive disappeared) should skip rather
        than fail the whole import."""
        archives_resp = _make_response(
            {
                "archives": [
                    "https://api.chess.com/pub/player/testuser/games/2024/03",
                    "https://api.chess.com/pub/player/testuser/games/2024/04",
                ]
            }
        )
        not_found_resp = _make_response({}, status_code=404)
        games_resp = _make_response({"games": [_make_game(uuid="april-game")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, not_found_resp, games_resp])

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            results = []
            async for game in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                results.append(game)

        # 2024/03 was 404 (skipped), 2024/04 succeeded with one game
        assert len(results) == 1
        assert results[0].platform_game_id == "april-game"

    @pytest.mark.asyncio
    async def test_unexpected_status_on_archive_fetch_raises(self):
        """An unexpected non-200 (e.g. 401) on a per-archive fetch should raise rather
        than silently skip. We explicitly enumerate which statuses are safe to skip."""
        archives_resp = _make_response(
            {"archives": ["https://api.chess.com/pub/player/testuser/games/2024/03"]}
        )
        unauthorized_resp = _make_response({}, status_code=401)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[archives_resp, unauthorized_resp])

        with patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()):
            with pytest.raises(RuntimeError, match="unexpected status 401"):
                async for _ in fetch_chesscom_games(mock_client, "testuser", user_id=1):
                    pass

    # -----------------------------------------------------------------------
    # Month-enumeration fallback (260425-lwz)
    # -----------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_archives_404_ambiguous_with_player_200_enumerates_months_from_joined(self):
        """When archives-list 404s with an ambiguous body and the player endpoint returns 200,
        fetch_chesscom_games should enumerate monthly archive URLs from the player's
        joined date to 'now' and yield games from those archives.

        wasterram joined 2026-03-22, 'now' frozen to 2026-04-25: expect 2026/03 and 2026/04.

        Note: the player endpoint is called twice — once by _user_exists_on_chesscom
        and once by _fetch_chesscom_player_joined. Both are mocked.
        """
        from datetime import datetime, timezone as tz

        # Unix timestamp for 2026-03-22T00:00:00Z
        joined_ts = int(datetime(2026, 3, 22, tzinfo=tz.utc).timestamp())

        archives_resp = _make_response(
            {"message": "An internal error has occurred."},
            status_code=404,
        )
        # First player call: _user_exists_on_chesscom (200, no joined needed)
        exists_resp = _make_response({"username": "wasterram"}, status_code=200)
        # Second player call: _fetch_chesscom_player_joined (200, with joined)
        joined_resp = _make_response(
            {"username": "wasterram", "joined": joined_ts},
            status_code=200,
        )
        march_resp = _make_response({"games": [_make_game(uuid="march-game")]})
        april_resp = _make_response({"games": [_make_game(uuid="april-game")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[archives_resp, exists_resp, joined_resp, march_resp, april_resp]
        )

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2026, 4)),
        ):
            results = []
            async for game in fetch_chesscom_games(mock_client, "wasterram", user_id=1):
                results.append(game)

        assert len(results) == 2
        # archives + exists-probe + joined-probe + 2 months = 5
        assert mock_client.get.call_count == 5

        called_urls = [call.args[0] for call in mock_client.get.call_args_list]
        assert any("/games/2026/03" in url for url in called_urls)
        assert any("/games/2026/04" in url for url in called_urls)
        assert not any("/games/2026/02" in url for url in called_urls)

    @pytest.mark.asyncio
    async def test_fallback_enumeration_truncates_to_since_timestamp(self):
        """When since_timestamp is provided, enumeration starts at max(joined_month,
        since_timestamp_month), not at joined_month directly.

        joined = 2024-01-01, since_timestamp = 2026-03-01, now = 2026-04-25.
        Expect only 2026/03 and 2026/04 (not 28 months from 2024/01).

        Note: player endpoint called twice (exists-probe + joined-probe).
        """
        from datetime import datetime, timezone as tz

        joined_ts = int(datetime(2024, 1, 1, tzinfo=tz.utc).timestamp())

        archives_resp = _make_response(
            {"message": "An internal error has occurred."},
            status_code=404,
        )
        exists_resp = _make_response({"username": "wasterram"}, status_code=200)
        joined_resp = _make_response(
            {"username": "wasterram", "joined": joined_ts},
            status_code=200,
        )
        march_resp = _make_response({"games": [_make_game(uuid="march-game")]})
        april_resp = _make_response({"games": [_make_game(uuid="april-game")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[archives_resp, exists_resp, joined_resp, march_resp, april_resp]
        )

        since = datetime(2026, 3, 1, tzinfo=tz.utc)

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2026, 4)),
        ):
            results = []
            async for game in fetch_chesscom_games(
                mock_client, "wasterram", user_id=1, since_timestamp=since
            ):
                results.append(game)

        # archives + exists-probe + joined-probe + 2 months = 5
        assert mock_client.get.call_count == 5
        assert len(results) == 2

        called_urls = [call.args[0] for call in mock_client.get.call_args_list]
        assert any("/games/2026/03" in url for url in called_urls)
        assert any("/games/2026/04" in url for url in called_urls)
        assert not any("/games/2024/01" in url for url in called_urls)

    @pytest.mark.asyncio
    async def test_fallback_enumeration_uses_earliest_when_joined_missing(self):
        """When the player JSON has no 'joined' field, enumeration starts at
        _CHESSCOM_EARLIEST_ARCHIVE_YEAR_MONTH (2007, 1).

        Freeze 'now' to 2007-03-15 for a tight 3-month window. Every month 404s
        (skipped by _fetch_archive_with_retries). Expect 0 games, no exception.

        Note: player endpoint called twice (exists-probe returns 200 without joined;
        joined-probe also returns 200 without joined → None → fall back to 2007-01).
        Total calls: archives + exists-probe + joined-probe + 3 months = 6.
        """
        archives_resp = _make_response(
            {"message": "An internal error has occurred."},
            status_code=404,
        )
        exists_resp = _make_response({"username": "nojoined"}, status_code=200)
        joined_resp = _make_response({"username": "nojoined"}, status_code=200)
        not_found_resp = _make_response({}, status_code=404)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[
                archives_resp,
                exists_resp,
                joined_resp,
                not_found_resp,  # 2007/01
                not_found_resp,  # 2007/02
                not_found_resp,  # 2007/03
            ]
        )

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2007, 3)),
        ):
            results = []
            async for game in fetch_chesscom_games(mock_client, "nojoined", user_id=1):
                results.append(game)

        assert results == []
        # archives + exists-probe + joined-probe + 3 months = 6
        assert mock_client.get.call_count == 6

    @pytest.mark.asyncio
    async def test_fallback_per_month_404_skips_and_continues(self):
        """When one synthesized monthly archive 404s, it is skipped and the next
        month's archive is still fetched (no exception raised).

        2026/03 → 404 (skip), 2026/04 → 200 with one game. Expect 1 game.

        Note: player endpoint called twice (exists-probe + joined-probe).
        """
        from datetime import datetime, timezone as tz

        joined_ts = int(datetime(2026, 3, 1, tzinfo=tz.utc).timestamp())

        archives_resp = _make_response(
            {"message": "An internal error has occurred."},
            status_code=404,
        )
        exists_resp = _make_response({"username": "wasterram"}, status_code=200)
        joined_resp = _make_response({"username": "wasterram", "joined": joined_ts})
        march_404 = _make_response({}, status_code=404)
        april_resp = _make_response({"games": [_make_game(uuid="april-game")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[archives_resp, exists_resp, joined_resp, march_404, april_resp]
        )

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2026, 4)),
        ):
            results = []
            async for game in fetch_chesscom_games(mock_client, "wasterram", user_id=1):
                results.append(game)

        assert len(results) == 1
        assert results[0].platform_game_id == "april-game"

    @pytest.mark.asyncio
    async def test_fallback_emits_sentry_info_capture_message(self):
        """When the month-enumeration fallback fires, sentry_sdk.capture_message must
        be called with level='info', tags containing source='import' and
        platform='chess.com', and a message containing 'archives-list 404'.

        Note: player endpoint called twice (exists-probe + joined-probe).
        """
        from datetime import datetime, timezone as tz

        joined_ts = int(datetime(2026, 3, 22, tzinfo=tz.utc).timestamp())

        archives_resp = _make_response(
            {"message": "An internal error has occurred."},
            status_code=404,
        )
        exists_resp = _make_response({"username": "wasterram"}, status_code=200)
        joined_resp = _make_response({"username": "wasterram", "joined": joined_ts})
        month_resp = _make_response({"games": []})

        mock_client = AsyncMock()
        # archives + exists-probe + joined-probe + 2026/03 + 2026/04 = 5
        mock_client.get = AsyncMock(
            side_effect=[archives_resp, exists_resp, joined_resp, month_resp, month_resp]
        )

        capture_mock = MagicMock()

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2026, 4)),
            patch("app.services.chesscom_client.sentry_sdk.capture_message", capture_mock),
        ):
            async for _ in fetch_chesscom_games(mock_client, "wasterram", user_id=1):
                pass

        # Find calls that include "archives-list 404" in the message (positional arg 0)
        fallback_calls = [
            c for c in capture_mock.call_args_list if "archives-list 404" in str(c.args[0])
        ]
        assert len(fallback_calls) >= 1

        call_kwargs = fallback_calls[0].kwargs
        assert call_kwargs.get("level") == "info"
        tags = call_kwargs.get("tags", {})
        assert tags.get("source") == "import"
        assert tags.get("platform") == "chess.com"


# ---------------------------------------------------------------------------
# fetch_chesscom_games_backward (Phase 186 Plan 02, IMPORT-03, D-06/D-07)
# ---------------------------------------------------------------------------


def _make_async_recorder(sink: list[tuple[int, int]]):
    """Build an async on_month_attempted callback that appends to `sink`.

    fetch_chesscom_games_backward awaits on_month_attempted (it typically
    persists the cursor via a DB write), so a plain sync list.append cannot
    be passed directly.
    """

    async def _record(ym: tuple[int, int]) -> None:
        sink.append(ym)

    return _record


class TestFetchChesscomGamesBackward:
    @pytest.mark.asyncio
    async def test_backward_visits_archives_newest_to_oldest(self):
        """With should_stop always False and joined at 2024-01, the backward walk
        visits 2024/03, 2024/02, 2024/01 in that order (newest -> oldest, D-06)."""
        joined_ts = int(datetime(2024, 1, 15, tzinfo=timezone.utc).timestamp())
        joined_resp = _make_response({"joined": joined_ts})
        march_resp = _make_response({"games": [_make_game(uuid="march-game")]})
        feb_resp = _make_response({"games": [_make_game(uuid="feb-game")]})
        jan_resp = _make_response({"games": [_make_game(uuid="jan-game")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[joined_resp, march_resp, feb_resp, jan_resp])

        visited_months: list[tuple[int, int]] = []

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2024, 3)),
        ):
            results = []
            async for game in fetch_chesscom_games_backward(
                mock_client,
                "testuser",
                user_id=1,
                oldest_attempted_ym=None,
                should_stop=lambda: False,
                on_month_attempted=_make_async_recorder(visited_months),
            ):
                results.append(game)

        assert [g.platform_game_id for g in results] == ["march-game", "feb-game", "jan-game"]
        assert visited_months == [(2024, 3), (2024, 2), (2024, 1)]

    @pytest.mark.asyncio
    async def test_backward_on_month_attempted_fires_for_zero_match_month(self):
        """A month whose archive yields zero games still fires on_month_attempted
        (Pitfall 1 -- persist attempts, not stored rows, or Sync would re-fetch
        the same empty period forever)."""
        joined_ts = int(datetime(2024, 2, 1, tzinfo=timezone.utc).timestamp())
        joined_resp = _make_response({"joined": joined_ts})
        empty_month_resp = _make_response({"games": []})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[joined_resp, empty_month_resp])

        visited_months: list[tuple[int, int]] = []

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2024, 2)),
        ):
            results = []
            async for game in fetch_chesscom_games_backward(
                mock_client,
                "testuser",
                user_id=1,
                oldest_attempted_ym=None,
                should_stop=lambda: False,
                on_month_attempted=_make_async_recorder(visited_months),
            ):
                results.append(game)

        assert results == []
        assert visited_months == [(2024, 2)]

    @pytest.mark.asyncio
    async def test_backward_skip_freezes_cursor_but_keeps_walking_older_months(self):
        """D-03 backward (load-bearing): a 404'd month stops on_month_attempted from
        firing for that month AND every older month in this same walk, so the
        persisted cursor cannot move past the skip -- but the walk itself keeps
        fetching and yielding games from older months within the run."""
        joined_ts = int(datetime(2024, 1, 15, tzinfo=timezone.utc).timestamp())
        joined_resp = _make_response({"joined": joined_ts})
        march_resp = _make_response({"games": [_make_game(uuid="march-game")]})
        feb_404 = _make_response({}, status_code=404)
        jan_resp = _make_response({"games": [_make_game(uuid="jan-game")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[joined_resp, march_resp, feb_404, jan_resp])

        visited_months: list[tuple[int, int]] = []

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2024, 3)),
        ):
            results = []
            async for game in fetch_chesscom_games_backward(
                mock_client,
                "testuser",
                user_id=1,
                oldest_attempted_ym=None,
                should_stop=lambda: False,
                on_month_attempted=_make_async_recorder(visited_months),
            ):
                results.append(game)

        # Only March (before the skip) is remembered -- Feb and Jan are absent,
        # so the persisted cursor cannot advance past the skipped Feb month.
        assert visited_months == [(2024, 3)]
        # But the walk itself did not stall: both March and January games were
        # still fetched and yielded within this run.
        assert [g.platform_game_id for g in results] == ["march-game", "jan-game"]

    @pytest.mark.asyncio
    async def test_backward_should_stop_halts_before_next_month_fetch(self):
        """should_stop() returning True after the first month halts the walk
        before the second (older) month is fetched (D-07, month granularity)."""
        joined_ts = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp())
        joined_resp = _make_response({"joined": joined_ts})
        march_resp = _make_response({"games": [_make_game(uuid="march-game")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[joined_resp, march_resp])

        # should_stop() is checked once up front (cheap short-circuit) and once
        # per month in the loop -- allow the first two calls through (pre-check +
        # 2024/03) and stop on the third (before 2024/02 would be fetched).
        call_count = [0]

        def _should_stop() -> bool:
            call_count[0] += 1
            return call_count[0] > 2

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2024, 3)),
        ):
            results = []
            async for game in fetch_chesscom_games_backward(
                mock_client,
                "testuser",
                user_id=1,
                oldest_attempted_ym=None,
                should_stop=_should_stop,
            ):
                results.append(game)

        assert [g.platform_game_id for g in results] == ["march-game"]
        # joined-probe + one archive fetch (2024/03) only -- 2024/02 never fetched.
        assert mock_client.get.call_count == 2

    @pytest.mark.asyncio
    async def test_backward_should_stop_true_immediately_performs_zero_requests(self):
        """When should_stop() is already True, the walk performs zero HTTP calls --
        not even the player-joined probe -- so a Sync with full budgets is cheap."""
        mock_client = AsyncMock()
        mock_client.get = AsyncMock()

        results = []
        async for game in fetch_chesscom_games_backward(
            mock_client,
            "testuser",
            user_id=1,
            oldest_attempted_ym=None,
            should_stop=lambda: True,
        ):
            results.append(game)

        assert results == []
        mock_client.get.assert_not_called()

    @pytest.mark.asyncio
    async def test_backward_resumes_just_before_oldest_attempted_ym(self):
        """A persisted cursor at (2024, 2) resumes at 2024/01, skipping the
        already-attempted 2024/02 and 2024/03 months."""
        joined_ts = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp())
        joined_resp = _make_response({"joined": joined_ts})
        jan_resp = _make_response({"games": [_make_game(uuid="jan-game")]})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[joined_resp, jan_resp])

        visited_months: list[tuple[int, int]] = []

        with (
            patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
            patch("app.services.chesscom_client._current_year_month", return_value=(2024, 3)),
        ):
            results = []
            async for game in fetch_chesscom_games_backward(
                mock_client,
                "testuser",
                user_id=1,
                oldest_attempted_ym=(2024, 2),
                should_stop=lambda: False,
                on_month_attempted=_make_async_recorder(visited_months),
            ):
                results.append(game)

        assert [g.platform_game_id for g in results] == ["jan-game"]
        assert visited_months == [(2024, 1)]


# ---------------------------------------------------------------------------
# _fetch_chesscom_player_joined
# ---------------------------------------------------------------------------


class TestFetchChesscomPlayerJoined:
    @pytest.mark.asyncio
    async def test_returns_datetime_when_joined_present(self):
        """Player 200 with a valid 'joined' Unix timestamp returns a UTC datetime."""
        joined_ts = int(datetime(2020, 6, 15, tzinfo=timezone.utc).timestamp())
        player_resp = _make_response({"username": "someone", "joined": joined_ts})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=player_resp)

        result = await _fetch_chesscom_player_joined(mock_client, "someone")

        assert result is not None
        assert result.year == 2020
        assert result.month == 6
        assert result.tzinfo == timezone.utc

    @pytest.mark.asyncio
    async def test_returns_none_when_joined_missing(self):
        """Player 200 without a 'joined' field returns None."""
        player_resp = _make_response({"username": "someone"})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=player_resp)

        result = await _fetch_chesscom_player_joined(mock_client, "someone")

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_404(self):
        """Player 404 returns None."""
        player_resp = _make_response({}, status_code=404)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=player_resp)

        result = await _fetch_chesscom_player_joined(mock_client, "ghost")

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_network_error(self):
        """Network exception on the player request returns None."""
        import httpx

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timed out"))

        result = await _fetch_chesscom_player_joined(mock_client, "someone")

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_non_int_joined(self):
        """Player 200 with a non-integer 'joined' value returns None."""
        player_resp = _make_response({"username": "someone", "joined": "not-a-number"})

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=player_resp)

        result = await _fetch_chesscom_player_joined(mock_client, "someone")

        assert result is None
