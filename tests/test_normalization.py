"""Tests for normalization utilities: parse_time_control, normalize_chesscom_game, normalize_lichess_game."""

import pytest


class TestParseTimeControl:
    """Tests for parse_time_control function."""

    def test_rapid_no_increment(self):
        """600+0 -> rapid (10+0 is standard rapid)."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("600+0")
        assert bucket == "rapid"
        assert seconds == 600

    def test_blitz_with_increment(self):
        """180+2 -> 180 + 2*40 = 260, which is blitz."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("180+2")
        assert bucket == "blitz"
        assert seconds == 260

    def test_bullet(self):
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("60+0")
        assert bucket == "bullet"
        assert seconds == 60

    def test_fractional_increment(self):
        """chess.com emits fractional increments like '10+0.1' — must not raise or return None."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("10+0.1")
        assert bucket == "bullet"
        assert seconds == 14  # 10 + 0.1 * 40 = 14

    def test_rapid_with_increment(self):
        """900+10 -> 900 + 10*40 = 1300, which is rapid."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("900+10")
        assert bucket == "rapid"
        assert seconds == 1300

    def test_daily_format(self):
        """Daily format '1/259200' should be classical with None seconds."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("1/259200")
        assert bucket == "classical"
        assert seconds is None

    def test_dash_returns_none(self):
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("-")
        assert bucket is None
        assert seconds is None

    def test_empty_string_returns_none(self):
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("")
        assert bucket is None
        assert seconds is None

    def test_bullet_boundary(self):
        """Exactly 180s -> blitz (180 is not < 180, so falls to blitz bucket)."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("180+0")
        assert bucket == "blitz"
        assert seconds == 180

    def test_179_is_bullet(self):
        """179+0 -> bullet (179 < 180)."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("179+0")
        assert bucket == "bullet"
        assert seconds == 179

    def test_600_is_rapid(self):
        """Exactly 600s -> rapid (10+0 is standard rapid)."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("600+0")
        assert bucket == "rapid"
        assert seconds == 600

    def test_599_is_blitz(self):
        """599s -> blitz (just below the 600s rapid threshold)."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("599+0")
        assert bucket == "blitz"
        assert seconds == 599

    def test_rapid_boundary(self):
        """Exactly 1800s -> rapid."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("1800+0")
        assert bucket == "rapid"
        assert seconds == 1800

    def test_classical(self):
        """Over 1800s -> classical."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("3600+0")
        assert bucket == "classical"
        assert seconds == 3600

    def test_no_increment(self):
        """No '+' in string, treat as base+0."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("300")
        assert bucket == "blitz"
        assert seconds == 300

    def test_invalid_string(self):
        """Non-parseable string returns None, None."""
        from app.services.normalization import parse_time_control

        bucket, seconds = parse_time_control("abc")
        assert bucket is None
        assert seconds is None


class TestNormalizeChesscomGame:
    """Tests for normalize_chesscom_game function."""

    def _make_chesscom_game(
        self,
        white_user="Magnus",
        black_user="Hikaru",
        white_result="win",
        black_result="checkmated",
        rules="chess",
        time_control="600+0",
        uuid="test-uuid-123",
        rated=True,
        white_is_computer=False,
        black_is_computer=False,
        pgn=None,
        event="Live Chess",
    ):
        white = {
            "username": white_user,
            "rating": 2800,
            "result": white_result,
        }
        black = {
            "username": black_user,
            "rating": 2750,
            "result": black_result,
        }
        if white_is_computer:
            white["is_computer"] = True
        if black_is_computer:
            black["is_computer"] = True
        if pgn is None:
            pgn = f'[Event "{event}"]\n[White "Magnus"]\n[Black "Hikaru"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 *'
        game = {
            "uuid": uuid,
            "url": f"https://www.chess.com/game/live/{uuid}",
            "pgn": pgn,
            "rules": rules,
            "time_control": time_control,
            "rated": rated,
            "end_time": 1700000000,  # Unix seconds
            "white": white,
            "black": black,
        }
        return game

    def test_returns_normalized_game_for_standard_game(self):
        from app.schemas.normalization import NormalizedGame
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game()
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert isinstance(result, NormalizedGame)

    def test_returns_none_for_chess960(self):
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(rules="chess960")
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is None

    def test_returns_none_for_bughouse(self):
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(rules="bughouse")
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is None

    def test_white_user_color(self):
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(white_user="Magnus", black_user="Hikaru")
        result = normalize_chesscom_game(game, "magnus", user_id=1)  # case insensitive
        assert result is not None
        assert result.user_color == "white"

    def test_black_user_color(self):
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(white_user="Magnus", black_user="Hikaru")
        result = normalize_chesscom_game(game, "hikaru", user_id=1)  # case insensitive
        assert result is not None
        assert result.user_color == "black"

    def test_win_on_white_gives_1_0(self):
        """When user plays white and result='win', result should be '1-0'."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(
            white_user="Magnus", white_result="win", black_result="checkmated"
        )
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.result == "1-0"

    def test_loss_on_white_gives_0_1(self):
        """When user plays white and result='checkmated', result should be '0-1'."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(
            white_user="Magnus", white_result="checkmated", black_result="win"
        )
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.result == "0-1"

    def test_draw_gives_1_2_1_2(self):
        """When result is a draw type, result should be '1/2-1/2'."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(
            white_user="Magnus", white_result="agreed", black_result="agreed"
        )
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.result == "1/2-1/2"

    def test_stalemate_is_draw(self):
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(
            white_user="Magnus", white_result="stalemate", black_result="stalemate"
        )
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.result == "1/2-1/2"

    def test_timeout_loss_for_black(self):
        """When white times out and black wins, result should be '0-1'."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(
            white_user="Magnus", black_user="Hikaru", white_result="timeout", black_result="win"
        )
        # From Hikaru's (black) perspective: black wins
        result = normalize_chesscom_game(game, "Hikaru", user_id=1)
        assert result is not None
        # white timed out -> black wins -> "0-1" (black wins in standard chess notation)
        assert result.result == "0-1"

    def test_platform_is_chesscom(self):
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game()
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.platform == "chess.com"

    def test_platform_game_id_is_uuid(self):
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(uuid="abc123")
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.platform_game_id == "abc123"

    def test_played_at_is_datetime(self):
        """end_time (Unix seconds) should be converted to a datetime."""
        import datetime
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game()
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert isinstance(result.played_at, datetime.datetime)

    def test_time_control_parsed(self):
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(time_control="600+0")
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        # "+0" suffix is normalized away
        assert result.time_control_str == "600"
        assert result.time_control_bucket == "rapid"
        assert result.time_control_seconds == 600

    def test_opening_eco_from_pgn(self):
        """ECO code should come from openings.tsv PGN matching (Italian Game = C50)."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(
            pgn='[Event "Live Chess"]\n[White "Magnus"]\n[Black "Hikaru"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 *'
        )
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.opening_eco == "C50"

    def test_user_id_included(self):
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game()
        result = normalize_chesscom_game(game, "Magnus", user_id=42)
        assert result is not None
        assert result.user_id == 42

    def test_computer_opponent_flagged(self):
        """User plays white, opponent (black) has is_computer=True -> is_computer_game=True."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(
            white_user="Magnus", black_user="StockfishBot", black_is_computer=True
        )
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.is_computer_game is True

    def test_computer_opponent_as_black_flagged(self):
        """User plays black, opponent (white) has is_computer=True -> is_computer_game=True."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(
            white_user="StockfishBot",
            black_user="Magnus",
            white_result="checkmated",
            black_result="win",
            white_is_computer=True,
        )
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.is_computer_game is True

    def test_human_opponent_not_flagged(self):
        """Neither player has is_computer field -> is_computer_game=False."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game()
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.is_computer_game is False

    def test_play_vs_coach_pgn_event_flagged(self):
        """PGN Event 'Play vs Coach' without is_computer field -> is_computer_game=True."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(event="Play vs Coach")
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.is_computer_game is True

    def test_play_vs_computer_pgn_event_flagged(self):
        """PGN Event 'Play vs Computer' without is_computer field -> is_computer_game=True."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(event="Play vs Computer")
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.is_computer_game is True

    def test_opening_name_from_pgn_match(self):
        """Game with known PGN moves gets correct opening_name from TSV (Italian Game)."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(
            pgn='[Event "Live Chess"]\n[White "Magnus"]\n[Black "Hikaru"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *'
        )
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        # 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 is covered by C50 Italian Game variants
        assert result.opening_name is not None

    def test_opening_none_when_no_moves_in_pgn(self):
        """Game with empty PGN gets opening_name=None and opening_eco=None."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(pgn="")
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.opening_name is None
        assert result.opening_eco is None


class TestChesscomAccuracy:
    """Tests for chess.com accuracy extraction in normalize_chesscom_game."""

    def _make_chesscom_game(self, accuracies=None):
        """Build a minimal chess.com game dict, optionally with accuracies field."""
        game = {
            "uuid": "test-uuid-acc",
            "url": "https://www.chess.com/game/live/test-uuid-acc",
            "pgn": '[Event "Live Chess"]\n[White "Magnus"]\n[Black "Hikaru"]\n[Result "1-0"]\n\n1. e4 e5 *',
            "rules": "chess",
            "time_control": "600+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Magnus", "rating": 2800, "result": "win"},
            "black": {"username": "Hikaru", "rating": 2750, "result": "checkmated"},
        }
        if accuracies is not None:
            game["accuracies"] = accuracies
        return game

    def test_accuracy_present(self):
        """Both accuracies present -> white_accuracy and black_accuracy extracted."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(accuracies={"white": 83.53, "black": 76.21})
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.white_accuracy == 83.53
        assert result.black_accuracy == 76.21

    def test_no_accuracies_key(self):
        """No accuracies key -> both accuracy fields are None."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game()  # no accuracies key
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.white_accuracy is None
        assert result.black_accuracy is None

    def test_partial_accuracies(self):
        """Only white accuracy present -> white_accuracy=float, black_accuracy=None."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(accuracies={"white": 90.0})
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.white_accuracy == 90.0
        assert result.black_accuracy is None

    def test_lichess_no_accuracy(self):
        """Lichess game without analysis returns None accuracy."""
        from app.services.normalization import normalize_lichess_game

        game = {
            "id": "q7ZvsdUF",
            "rated": True,
            "variant": {"key": "standard", "name": "Standard"},
            "speed": "blitz",
            "perf": "blitz",
            "createdAt": 1700000000000,
            "lastMoveAt": 1700000600000,
            "status": "mate",
            "winner": "white",
            "players": {
                "white": {"user": {"name": "Magnus", "id": "magnus"}, "rating": 2800},
                "black": {"user": {"name": "Hikaru", "id": "hikaru"}, "rating": 2750},
            },
            "moves": "e4 c5 Nf3",
            "pgn": '[Event "?"]\n[White "Magnus"]\n[Black "Hikaru"]\n\n1. e4 c5 *',
            "clock": {"initial": 600, "increment": 0, "totalTime": 600},
        }
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.white_accuracy is None
        assert result.black_accuracy is None

    def test_lichess_with_accuracy(self):
        """Lichess game with analysis returns accuracy values."""
        from app.services.normalization import normalize_lichess_game

        game = {
            "id": "q7ZvsdUF",
            "rated": True,
            "variant": {"key": "standard", "name": "Standard"},
            "speed": "blitz",
            "perf": "blitz",
            "createdAt": 1700000000000,
            "lastMoveAt": 1700000600000,
            "status": "mate",
            "winner": "white",
            "players": {
                "white": {
                    "user": {"name": "Magnus", "id": "magnus"},
                    "rating": 2800,
                    "analysis": {
                        "inaccuracy": 1,
                        "mistake": 0,
                        "blunder": 0,
                        "acpl": 15,
                        "accuracy": 94,
                    },
                },
                "black": {
                    "user": {"name": "Hikaru", "id": "hikaru"},
                    "rating": 2750,
                    "analysis": {
                        "inaccuracy": 2,
                        "mistake": 1,
                        "blunder": 0,
                        "acpl": 30,
                        "accuracy": 82,
                    },
                },
            },
            "moves": "e4 c5 Nf3",
            "pgn": '[Event "?"]\n[White "Magnus"]\n[Black "Hikaru"]\n\n1. e4 c5 *',
            "clock": {"initial": 600, "increment": 0, "totalTime": 600},
        }
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.white_accuracy == 94
        assert result.black_accuracy == 82


class TestLichessAnalysisMetrics:
    """Tests for lichess analysis metrics extraction (ACPL, inaccuracies, mistakes, blunders)."""

    def test_lichess_analysis_metrics_present(self):
        """Lichess game with analysis dict returns all 8 metric fields populated."""
        from app.services.normalization import normalize_lichess_game

        game = {
            "id": "q7ZvsdUF",
            "rated": True,
            "variant": {"key": "standard", "name": "Standard"},
            "speed": "blitz",
            "perf": "blitz",
            "createdAt": 1700000000000,
            "lastMoveAt": 1700000600000,
            "status": "mate",
            "winner": "white",
            "players": {
                "white": {
                    "user": {"name": "Magnus", "id": "magnus"},
                    "rating": 2800,
                    "analysis": {
                        "inaccuracy": 1,
                        "mistake": 0,
                        "blunder": 0,
                        "acpl": 15,
                        "accuracy": 94,
                    },
                },
                "black": {
                    "user": {"name": "Hikaru", "id": "hikaru"},
                    "rating": 2750,
                    "analysis": {
                        "inaccuracy": 2,
                        "mistake": 1,
                        "blunder": 0,
                        "acpl": 30,
                        "accuracy": 82,
                    },
                },
            },
            "moves": "e4 c5 Nf3",
            "pgn": '[Event "?"]\n[White "Magnus"]\n[Black "Hikaru"]\n\n1. e4 c5 *',
            "clock": {"initial": 600, "increment": 0, "totalTime": 600},
        }
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.white_acpl == 15
        assert result.black_acpl == 30
        assert result.white_inaccuracies == 1
        assert result.black_inaccuracies == 2
        assert result.white_mistakes == 0
        assert result.black_mistakes == 1
        assert result.white_blunders == 0
        assert result.black_blunders == 0

    def test_lichess_analysis_metrics_absent(self):
        """Lichess game without analysis key returns all 8 metric fields as None."""
        from app.services.normalization import normalize_lichess_game

        game = {
            "id": "q7ZvsdUF",
            "rated": True,
            "variant": {"key": "standard", "name": "Standard"},
            "speed": "blitz",
            "perf": "blitz",
            "createdAt": 1700000000000,
            "lastMoveAt": 1700000600000,
            "status": "mate",
            "winner": "white",
            "players": {
                "white": {"user": {"name": "Magnus", "id": "magnus"}, "rating": 2800},
                "black": {"user": {"name": "Hikaru", "id": "hikaru"}, "rating": 2750},
            },
            "moves": "e4 c5 Nf3",
            "pgn": '[Event "?"]\n[White "Magnus"]\n[Black "Hikaru"]\n\n1. e4 c5 *',
            "clock": {"initial": 600, "increment": 0, "totalTime": 600},
        }
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.white_acpl is None
        assert result.black_acpl is None
        assert result.white_inaccuracies is None
        assert result.black_inaccuracies is None
        assert result.white_mistakes is None
        assert result.black_mistakes is None
        assert result.white_blunders is None
        assert result.black_blunders is None

    def test_chesscom_no_analysis_metrics(self):
        """Chess.com normalized game does NOT contain the 8 analysis metric keys."""
        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test-uuid-123",
            "url": "https://www.chess.com/game/live/test-uuid-123",
            "pgn": '[Event "Live Chess"]\n[White "Magnus"]\n[Black "Hikaru"]\n[Result "1-0"]\n\n1. e4 e5 *',
            "rules": "chess",
            "time_control": "600+0",
            "end_time": 1700000600,
            "rated": True,
            "white": {"username": "Magnus", "rating": 2800, "result": "win"},
            "black": {"username": "Hikaru", "rating": 2750, "result": "checkmated"},
        }
        result = normalize_chesscom_game(game, "Magnus", user_id=1)
        assert result is not None
        assert "white_acpl" not in result
        assert "black_acpl" not in result
        assert "white_inaccuracies" not in result
        assert "black_inaccuracies" not in result
        assert "white_mistakes" not in result
        assert "black_mistakes" not in result
        assert "white_blunders" not in result
        assert "black_blunders" not in result


class TestNormalizeLichessGame:
    """Tests for normalize_lichess_game function."""

    def _make_lichess_game(
        self,
        white_user="Magnus",
        black_user="Hikaru",
        winner=None,
        variant_key="standard",
        clock_initial=600,
        clock_increment=0,
        game_id="q7ZvsdUF",
        rated=True,
        white_title=None,
        black_title=None,
    ):
        white_user_obj = {"name": white_user, "id": white_user.lower()}
        black_user_obj = {"name": black_user, "id": black_user.lower()}
        if white_title is not None:
            white_user_obj["title"] = white_title
        if black_title is not None:
            black_user_obj["title"] = black_title
        game = {
            "id": game_id,
            "rated": rated,
            "variant": {"key": variant_key, "name": variant_key.title()},
            "speed": "blitz",
            "perf": "blitz",
            "createdAt": 1700000000000,  # ms timestamp
            "lastMoveAt": 1700000600000,
            "status": "mate",
            "players": {
                "white": {
                    "user": white_user_obj,
                    "rating": 2800,
                },
                "black": {
                    "user": black_user_obj,
                    "rating": 2750,
                },
            },
            "moves": "e4 c5 Nf3",
            "pgn": '[Event "?"]\n[White "Magnus"]\n[Black "Hikaru"]\n\n1. e4 c5 2. Nf3 *',
            "clock": {
                "initial": clock_initial,
                "increment": clock_increment,
                "totalTime": clock_initial,
            },
        }
        if winner is not None:
            game["winner"] = winner
        return game

    def test_returns_normalized_game_for_standard_game(self):
        from app.schemas.normalization import NormalizedGame
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game()
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert isinstance(result, NormalizedGame)

    def test_returns_none_for_chess960(self):
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(variant_key="chess960")
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is None

    def test_returns_none_for_crazyhouse(self):
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(variant_key="crazyhouse")
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is None

    def test_white_user_color(self):
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(white_user="Magnus", black_user="Hikaru")
        result = normalize_lichess_game(game, "magnus", user_id=1)
        assert result is not None
        assert result.user_color == "white"

    def test_black_user_color(self):
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(white_user="Magnus", black_user="Hikaru")
        result = normalize_lichess_game(game, "Hikaru", user_id=1)
        assert result is not None
        assert result.user_color == "black"

    def test_white_wins(self):
        """winner='white' -> result='1-0'."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(winner="white")
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.result == "1-0"

    def test_black_wins(self):
        """winner='black' -> result='0-1'."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(winner="black")
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.result == "0-1"

    def test_draw_no_winner(self):
        """No winner field -> result='1/2-1/2'."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(winner=None)  # No winner key
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.result == "1/2-1/2"

    def test_played_at_from_ms(self):
        """createdAt in ms should be converted to datetime."""
        import datetime
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game()
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert isinstance(result.played_at, datetime.datetime)
        # 1700000000000 ms = 1700000000 s
        expected = datetime.datetime.fromtimestamp(1700000000, tz=datetime.timezone.utc)
        assert result.played_at == expected

    def test_platform_is_lichess(self):
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game()
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.platform == "lichess"

    def test_platform_url_constructed(self):
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(game_id="q7ZvsdUF")
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.platform_url == "https://lichess.org/q7ZvsdUF"

    def test_platform_game_id(self):
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(game_id="q7ZvsdUF")
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.platform_game_id == "q7ZvsdUF"

    def test_time_control_str_formatted(self):
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(clock_initial=600, clock_increment=5)
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.time_control_str == "600+5"

    def test_opening_eco_and_name_from_pgn(self):
        """Opening ECO and name come from openings.tsv PGN matching, not lichess API field."""
        from app.services.normalization import normalize_lichess_game

        # The game PGN has "1. e4 c5 2. Nf3 *" which matches B27 Sicilian Defense
        game = self._make_lichess_game()
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.opening_eco == "B27"
        assert result.opening_name == "Sicilian Defense"

    def test_user_id_included(self):
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game()
        result = normalize_lichess_game(game, "Magnus", user_id=99)
        assert result is not None
        assert result.user_id == 99

    def test_no_clock_handles_gracefully(self):
        """Games without clock info should still normalize (no crash)."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game()
        del game["clock"]
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.time_control_str is None
        assert result.time_control_bucket is None

    def test_bot_opponent_flagged(self):
        """Opponent (black) has title='BOT' -> is_computer_game=True."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(
            white_user="Magnus", black_user="Stockfish", black_title="BOT"
        )
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.is_computer_game is True

    def test_human_opponent_not_flagged(self):
        """No title field on opponent -> is_computer_game=False."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game()
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.is_computer_game is False

    def test_bot_title_case_insensitive(self):
        """Opponent title='bot' (lowercase) -> is_computer_game=True."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(
            white_user="Magnus", black_user="Stockfish", black_title="bot"
        )
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.is_computer_game is True

    def test_correspondence_bucketed_as_classical(self):
        """Correspondence games have no clock — bucket as classical, mirror chess.com daily format."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game()
        del game["clock"]
        game["speed"] = "correspondence"
        game["perf"] = "correspondence"
        game["daysPerTurn"] = 3
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.time_control_bucket == "classical"
        assert result.time_control_str == "1/259200"  # 3 days * 86400 sec/day
        assert result.time_control_seconds is None

    def test_correspondence_without_days_per_turn(self):
        """Unlimited correspondence (no daysPerTurn) still buckets as classical with null tc_str."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game()
        del game["clock"]
        game["speed"] = "correspondence"
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.time_control_bucket == "classical"
        assert result.time_control_str is None
        assert result.time_control_seconds is None

    def test_ai_opponent_gets_name_and_computer_flag(self):
        """AI opponents have no `user` object — only `aiLevel`. Surface as 'lichess AI level N' and flag as computer."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game()
        game["players"]["black"] = {"aiLevel": 6}
        result = normalize_lichess_game(game, "Magnus", user_id=1)
        assert result is not None
        assert result.black_username == "lichess AI level 6"
        assert result.is_computer_game is True


class TestChesscomTermination:
    """Tests for termination extraction from chess.com games."""

    def _make_chesscom_game(self, white_result="win", black_result="checkmated"):
        return {
            "uuid": "test-uuid",
            "url": "https://www.chess.com/game/live/test-uuid",
            "pgn": '[Event "Live Chess"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 *',
            "rules": "chess",
            "time_control": "600+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": white_result},
            "black": {"username": "Bob", "rating": 1500, "result": black_result},
        }

    def test_checkmate_termination(self):
        """white_result='win', black_result='checkmated' -> termination='checkmate'."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(white_result="win", black_result="checkmated")
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.termination_raw == "checkmated"
        assert result.termination == "checkmate"

    def test_resignation_termination(self):
        """black_result='resigned' -> termination='resignation'."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(white_result="win", black_result="resigned")
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.termination_raw == "resigned"
        assert result.termination == "resignation"

    def test_draw_agreed_termination(self):
        """Both results='agreed' -> termination='draw'."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(white_result="agreed", black_result="agreed")
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.termination_raw == "agreed"
        assert result.termination == "draw"

    def test_timeout_termination(self):
        """black_result='timeout' -> termination='timeout'."""
        from app.services.normalization import normalize_chesscom_game

        game = self._make_chesscom_game(white_result="win", black_result="timeout")
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.termination_raw == "timeout"
        assert result.termination == "timeout"


class TestLichessTermination:
    """Tests for termination extraction from lichess games."""

    def _make_lichess_game(self, status="mate", winner="white"):
        game = {
            "id": "testgame1",
            "rated": True,
            "variant": {"key": "standard", "name": "Standard"},
            "speed": "blitz",
            "perf": "blitz",
            "createdAt": 1700000000000,
            "lastMoveAt": 1700000600000,
            "status": status,
            "players": {
                "white": {"user": {"name": "Alice", "id": "alice"}, "rating": 1500},
                "black": {"user": {"name": "Bob", "id": "bob"}, "rating": 1500},
            },
            "pgn": '[Event "?"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 *',
            "clock": {"initial": 600, "increment": 0, "totalTime": 600},
        }
        if winner is not None:
            game["winner"] = winner
        return game

    def test_checkmate_termination(self):
        """status='mate' -> termination='checkmate'."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(status="mate", winner="white")
        result = normalize_lichess_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.termination_raw == "mate"
        assert result.termination == "checkmate"

    def test_resignation_termination(self):
        """status='resign' -> termination='resignation'."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(status="resign", winner="white")
        result = normalize_lichess_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.termination_raw == "resign"
        assert result.termination == "resignation"

    def test_timeout_termination(self):
        """status='outoftime' -> termination='timeout'."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(status="outoftime", winner="white")
        result = normalize_lichess_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.termination_raw == "outoftime"
        assert result.termination == "timeout"

    def test_draw_termination(self):
        """status='draw' -> termination='draw'."""
        from app.services.normalization import normalize_lichess_game

        game = self._make_lichess_game(status="draw", winner=None)
        result = normalize_lichess_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.termination_raw == "draw"
        assert result.termination == "draw"


class TestNormalizeTcStr:
    """Tests for _normalize_tc_str helper."""

    def test_drops_plus_zero_suffix(self):
        from app.services.normalization import _normalize_tc_str

        assert _normalize_tc_str("600+0") == "600"

    def test_keeps_nonzero_increment(self):
        from app.services.normalization import _normalize_tc_str

        assert _normalize_tc_str("600+5") == "600+5"

    def test_no_increment_passthrough(self):
        from app.services.normalization import _normalize_tc_str

        assert _normalize_tc_str("180") == "180"

    def test_empty_string_returns_none(self):
        from app.services.normalization import _normalize_tc_str

        assert _normalize_tc_str("") is None

    def test_dash_returns_none(self):
        from app.services.normalization import _normalize_tc_str

        assert _normalize_tc_str("-") is None


class TestTcStrConsistency:
    """Integration tests ensuring no '+0' suffix on either platform for zero-increment games."""

    def test_chesscom_zero_increment_no_plus_zero(self):
        """chess.com game with '180+0' time_control -> time_control_str = '180'."""
        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test-uuid",
            "url": "https://chess.com/test",
            "pgn": '[Event "Live Chess"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 *',
            "rules": "chess",
            "time_control": "180+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "win"},
            "black": {"username": "Bob", "rating": 1500, "result": "checkmated"},
        }
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.time_control_str == "180"
        assert "+" not in result.time_control_str

    def test_lichess_zero_increment_no_plus_zero(self):
        """lichess game with clock_increment=0 -> time_control_str has no '+0' suffix."""
        from app.services.normalization import normalize_lichess_game

        game = {
            "id": "testgame1",
            "rated": True,
            "variant": {"key": "standard", "name": "Standard"},
            "speed": "blitz",
            "perf": "blitz",
            "createdAt": 1700000000000,
            "lastMoveAt": 1700000600000,
            "status": "mate",
            "winner": "white",
            "players": {
                "white": {"user": {"name": "Alice", "id": "alice"}, "rating": 1500},
                "black": {"user": {"name": "Bob", "id": "bob"}, "rating": 1500},
            },
            "pgn": '[Event "?"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 *',
            "clock": {"initial": 600, "increment": 0, "totalTime": 600},
        }
        result = normalize_lichess_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.time_control_str == "600"
        assert "+" not in result.time_control_str

    def test_chesscom_and_lichess_consistent_for_same_time_control(self):
        """Both platforms produce same time_control_str for equivalent zero-increment games."""
        from app.services.normalization import normalize_chesscom_game, normalize_lichess_game

        chesscom_game = {
            "uuid": "test-uuid",
            "url": "https://chess.com/test",
            "pgn": '[Event "Live Chess"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 *',
            "rules": "chess",
            "time_control": "600+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "win"},
            "black": {"username": "Bob", "rating": 1500, "result": "checkmated"},
        }
        lichess_game = {
            "id": "testgame1",
            "rated": True,
            "variant": {"key": "standard", "name": "Standard"},
            "speed": "blitz",
            "perf": "blitz",
            "createdAt": 1700000000000,
            "lastMoveAt": 1700000600000,
            "status": "mate",
            "winner": "white",
            "players": {
                "white": {"user": {"name": "Alice", "id": "alice"}, "rating": 1500},
                "black": {"user": {"name": "Bob", "id": "bob"}, "rating": 1500},
            },
            "pgn": '[Event "?"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 *',
            "clock": {"initial": 600, "increment": 0, "totalTime": 600},
        }
        cc = normalize_chesscom_game(chesscom_game, "Alice", user_id=1)
        li = normalize_lichess_game(lichess_game, "Alice", user_id=1)
        assert cc is not None and li is not None
        assert cc.time_control_str == li.time_control_str == "600"


class TestNormalizeChesscomResult:
    """Tests for chess.com result string mapping."""

    def test_win_result_white_wins(self):
        """White has 'win' -> result '1-0'."""
        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test",
            "url": "https://chess.com/test",
            "pgn": "",
            "rules": "chess",
            "time_control": "600+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "win"},
            "black": {"username": "Bob", "rating": 1500, "result": "checkmated"},
        }
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.result == "1-0"

    def test_resigned_as_loss(self):
        """Black has 'resigned' -> white wins -> '1-0'."""
        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test",
            "url": "https://chess.com/test",
            "pgn": "",
            "rules": "chess",
            "time_control": "600+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "win"},
            "black": {"username": "Bob", "rating": 1500, "result": "resigned"},
        }
        result = normalize_chesscom_game(game, "Bob", user_id=1)
        assert result is not None
        # Bob plays black and resigned -> white wins = "1-0"
        assert result.result == "1-0"

    def test_insufficient_material_is_draw(self):
        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test",
            "url": "https://chess.com/test",
            "pgn": "",
            "rules": "chess",
            "time_control": "600+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "insufficient"},
            "black": {"username": "Bob", "rating": 1500, "result": "insufficient"},
        }
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.result == "1/2-1/2"

    def test_repetition_is_draw(self):
        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test",
            "url": "https://chess.com/test",
            "pgn": "",
            "rules": "chess",
            "time_control": "600+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "repetition"},
            "black": {"username": "Bob", "rating": 1500, "result": "repetition"},
        }
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.result == "1/2-1/2"

    def test_unrecognized_result_pair_returns_none(self):
        """PRUNE-03: an unmapped white/black result pair must NOT fabricate a draw.

        Neither result string is a "win" or a known draw string, so
        _normalize_chesscom_result signals unknown (None) and the game
        must be skipped rather than persisted as '1/2-1/2'.
        """
        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test",
            "url": "https://chess.com/test",
            "pgn": "",
            "rules": "chess",
            "time_control": "600+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "some_new_unmapped_status"},
            "black": {"username": "Bob", "rating": 1500, "result": "some_new_unmapped_status"},
        }
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is None

    def test_unrecognized_result_pair_captures_sentry_with_context_not_message(self):
        """The unknown branch emits exactly one Sentry capture with white_result/
        black_result carried via set_context — never interpolated into the
        message string (Sentry grouping rule)."""
        from unittest.mock import patch

        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test",
            "url": "https://chess.com/test",
            "pgn": "",
            "rules": "chess",
            "time_control": "600+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "some_new_unmapped_status"},
            "black": {"username": "Bob", "rating": 1500, "result": "another_unmapped_status"},
        }

        with (
            patch("app.services.normalization.sentry_sdk.set_context") as mock_set_context,
            patch("app.services.normalization.sentry_sdk.capture_message") as mock_capture,
        ):
            result = normalize_chesscom_game(game, "Alice", user_id=1)

        assert result is None
        mock_capture.assert_called_once()
        # Message string must be a constant with no interpolated result values.
        message = mock_capture.call_args.args[0]
        assert "some_new_unmapped_status" not in message
        assert "another_unmapped_status" not in message
        mock_set_context.assert_called_once_with(
            "chesscom_result",
            {"white_result": "some_new_unmapped_status", "black_result": "another_unmapped_status"},
        )

    def test_genuine_draw_is_not_captured_to_sentry(self):
        """A real draw must normalize to '1/2-1/2' without any Sentry capture."""
        from unittest.mock import patch

        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test",
            "url": "https://chess.com/test",
            "pgn": "",
            "rules": "chess",
            "time_control": "600+0",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "agreed"},
            "black": {"username": "Bob", "rating": 1500, "result": "agreed"},
        }

        with (
            patch("app.services.normalization.sentry_sdk.set_context") as mock_set_context,
            patch("app.services.normalization.sentry_sdk.capture_message") as mock_capture,
        ):
            result = normalize_chesscom_game(game, "Alice", user_id=1)

        assert result is not None
        assert result.result == "1/2-1/2"
        mock_set_context.assert_not_called()
        mock_capture.assert_not_called()


class TestParseBaseAndIncrement:
    """Tests for parse_base_and_increment function."""

    def test_plain_base_no_increment(self):
        """'600' (no '+') -> (600, 0)."""
        from app.services.normalization import parse_base_and_increment

        base, inc = parse_base_and_increment("600")
        assert base == 600
        assert inc == 0

    def test_base_plus_zero(self):
        """'600+0' -> (600, 0)."""
        from app.services.normalization import parse_base_and_increment

        base, inc = parse_base_and_increment("600+0")
        assert base == 600
        assert inc == 0

    def test_base_plus_nonzero(self):
        """'600+5' -> (600, 5)."""
        from app.services.normalization import parse_base_and_increment

        base, inc = parse_base_and_increment("600+5")
        assert base == 600
        assert inc == 5

    def test_rapid_with_increment(self):
        """'900+10' -> (900, 10)."""
        from app.services.normalization import parse_base_and_increment

        base, inc = parse_base_and_increment("900+10")
        assert base == 900
        assert inc == 10

    def test_fractional_increment_preserved(self):
        """'10+0.1' -> (10, 0.1): fractional increment preserved as float."""
        from app.services.normalization import parse_base_and_increment

        base, inc = parse_base_and_increment("10+0.1")
        assert base == 10
        assert inc == 0.1

    def test_daily_format_returns_none(self):
        """'1/259200' (daily) -> (None, None): no fixed base clock."""
        from app.services.normalization import parse_base_and_increment

        base, inc = parse_base_and_increment("1/259200")
        assert base is None
        assert inc is None

    def test_empty_string_returns_none(self):
        """'' -> (None, None)."""
        from app.services.normalization import parse_base_and_increment

        base, inc = parse_base_and_increment("")
        assert base is None
        assert inc is None

    def test_dash_returns_none(self):
        """'-' -> (None, None)."""
        from app.services.normalization import parse_base_and_increment

        base, inc = parse_base_and_increment("-")
        assert base is None
        assert inc is None

    def test_invalid_string_returns_none(self):
        """Non-parseable string -> (None, None)."""
        from app.services.normalization import parse_base_and_increment

        base, inc = parse_base_and_increment("abc+def")
        assert base is None
        assert inc is None


class TestBaseAndIncrementInNormalizers:
    """Integration tests: normalizers populate base_time_seconds / increment_seconds."""

    def test_chesscom_standard_game_populates_fields(self):
        """normalize_chesscom_game with '600+5' -> base_time_seconds=600, increment_seconds=5."""
        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test-uuid",
            "url": "https://chess.com/test",
            "pgn": '[Event "Live Chess"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 *',
            "rules": "chess",
            "time_control": "600+5",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "win"},
            "black": {"username": "Bob", "rating": 1500, "result": "checkmated"},
        }
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.base_time_seconds == 600
        assert result.increment_seconds == 5

    def test_chesscom_daily_game_has_none_base_time(self):
        """normalize_chesscom_game with daily format -> base_time_seconds=None."""
        from app.services.normalization import normalize_chesscom_game

        game = {
            "uuid": "test-uuid",
            "url": "https://chess.com/test",
            "pgn": '[Event "Daily Chess"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 *',
            "rules": "chess",
            "time_control": "1/259200",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "win"},
            "black": {"username": "Bob", "rating": 1500, "result": "checkmated"},
        }
        result = normalize_chesscom_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.base_time_seconds is None
        assert result.increment_seconds is None

    def test_lichess_standard_game_populates_fields(self):
        """normalize_lichess_game with clock 600+5 -> base_time_seconds=600, increment_seconds=5."""
        from app.services.normalization import normalize_lichess_game

        game = {
            "id": "testgame1",
            "rated": True,
            "variant": {"key": "standard", "name": "Standard"},
            "speed": "rapid",
            "perf": "rapid",
            "createdAt": 1700000000000,
            "lastMoveAt": 1700000600000,
            "status": "mate",
            "winner": "white",
            "players": {
                "white": {"user": {"name": "Alice", "id": "alice"}, "rating": 1500},
                "black": {"user": {"name": "Bob", "id": "bob"}, "rating": 1500},
            },
            "pgn": '[Event "?"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 *',
            "clock": {"initial": 600, "increment": 5, "totalTime": 800},
        }
        result = normalize_lichess_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.base_time_seconds == 600
        assert result.increment_seconds == 5

    def test_lichess_correspondence_has_none_base_time(self):
        """normalize_lichess_game for correspondence -> base_time_seconds=None."""
        from app.services.normalization import normalize_lichess_game

        game = {
            "id": "testgame2",
            "rated": True,
            "variant": {"key": "standard", "name": "Standard"},
            "speed": "correspondence",
            "perf": "correspondence",
            "createdAt": 1700000000000,
            "lastMoveAt": 1700000600000,
            "status": "mate",
            "winner": "white",
            "players": {
                "white": {"user": {"name": "Alice", "id": "alice"}, "rating": 1500},
                "black": {"user": {"name": "Bob", "id": "bob"}, "rating": 1500},
            },
            "pgn": '[Event "?"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 *',
            "daysPerTurn": 3,
        }
        result = normalize_lichess_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.base_time_seconds is None
        assert result.increment_seconds is None


# ---------------------------------------------------------------------------
# Phase 210 (SEED-042): extract_initial_fen + the migration's SQL mirror
# ---------------------------------------------------------------------------

# A genuinely custom start: the Evans Gambit thematic position shape that caused
# the production eviction (Sentry FLAWCHESS-5E).
CUSTOM_START_FEN = "r1bqk1nr/pppp1ppp/2n5/2b1p3/1PB1P3/5N2/P1PP1PPP/RNBQK2R b KQkq b3 0 4"
STANDARD_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def _pgn_with_headers(headers: str, movetext: str = "1. e4 e5 *") -> str:
    return f'[Event "Test"]\n[White "A"]\n[Black "B"]\n{headers}\n\n{movetext}'


class TestExtractInitialFen:
    """extract_initial_fen is the single producer of games.initial_fen (D-06)."""

    def test_setup_and_fen_pair_returns_the_fen(self):
        from app.services.normalization import extract_initial_fen

        pgn = _pgn_with_headers(f'[SetUp "1"]\n[FEN "{CUSTOM_START_FEN}"]')
        assert extract_initial_fen(pgn) == CUSTOM_START_FEN

    def test_no_headers_returns_none(self):
        from app.services.normalization import extract_initial_fen

        assert extract_initial_fen(_pgn_with_headers('[Result "1-0"]')) is None

    def test_fen_without_setup_marker_returns_none(self):
        """Per the PGN spec a [FEN] tag alone does not establish a custom start."""
        from app.services.normalization import extract_initial_fen

        pgn = _pgn_with_headers(f'[FEN "{CUSTOM_START_FEN}"]')
        assert extract_initial_fen(pgn) is None

    def test_setup_naming_the_standard_start_returns_none(self):
        """D-05: producers do emit this, and such a game is NOT custom-start.

        It must stay eligible as an opening-transition sample representative,
        which is exactly what `initial_fen IS NULL` gates.
        """
        from app.services.normalization import extract_initial_fen

        pgn = _pgn_with_headers(f'[SetUp "1"]\n[FEN "{STANDARD_START_FEN}"]')
        assert extract_initial_fen(pgn) is None

    def test_standard_start_with_different_counters_still_returns_none(self):
        """canonical_root_fen ignores the halfmove clock, fullmove number and the
        inconsistently-emitted en-passant field, so those can't fake a custom start."""
        from app.services.normalization import extract_initial_fen

        variant = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 7 12"
        pgn = _pgn_with_headers(f'[SetUp "1"]\n[FEN "{variant}"]')
        assert extract_initial_fen(pgn) is None

    def test_malformed_fen_returns_none_rather_than_raising(self):
        """A broken header must not fail an import (landmine 5)."""
        from app.services.normalization import extract_initial_fen

        pgn = _pgn_with_headers('[SetUp "1"]\n[FEN "not-a-fen"]')
        assert extract_initial_fen(pgn) is None

    def test_empty_fen_value_returns_none(self):
        from app.services.normalization import extract_initial_fen

        pgn = _pgn_with_headers('[SetUp "1"]\n[FEN ""]')
        assert extract_initial_fen(pgn) is None

    def test_tolerates_header_whitespace_variation(self):
        from app.services.normalization import extract_initial_fen

        pgn = _pgn_with_headers(f'[ SetUp  "1" ]\n[ FEN  "{CUSTOM_START_FEN}" ]')
        assert extract_initial_fen(pgn) == CUSTOM_START_FEN


class TestNormalizersPopulateInitialFen:
    """All four NormalizedGame producers agree on the initial_fen contract."""

    def _chesscom_game(self, pgn: str) -> dict:
        return {
            "rules": "chess",
            "uuid": "abc-123",
            "url": "https://chess.com/game/1",
            "pgn": pgn,
            "time_control": "600",
            "time_class": "rapid",
            "rated": True,
            "end_time": 1700000000,
            "white": {"username": "Alice", "rating": 1500, "result": "win"},
            "black": {"username": "Bob", "rating": 1500, "result": "checkmated"},
        }

    def test_chesscom_custom_start_populates(self):
        from app.services.normalization import normalize_chesscom_game

        pgn = _pgn_with_headers(f'[SetUp "1"]\n[FEN "{CUSTOM_START_FEN}"]')
        result = normalize_chesscom_game(self._chesscom_game(pgn), "Alice", user_id=1)
        assert result is not None
        assert result.initial_fen == CUSTOM_START_FEN

    def test_chesscom_standard_start_stays_none(self):
        from app.services.normalization import normalize_chesscom_game

        result = normalize_chesscom_game(
            self._chesscom_game(_pgn_with_headers('[Result "1-0"]')), "Alice", user_id=1
        )
        assert result is not None
        assert result.initial_fen is None

    def test_lichess_custom_start_populates(self):
        from app.services.normalization import normalize_lichess_game

        pgn = _pgn_with_headers(f'[SetUp "1"]\n[FEN "{CUSTOM_START_FEN}"]')
        game = {
            "id": "lichessid1",
            "rated": True,
            "variant": {"key": "standard", "name": "Standard"},
            "speed": "blitz",
            "perf": "blitz",
            "createdAt": 1700000000000,
            "lastMoveAt": 1700000600000,
            "status": "mate",
            "winner": "white",
            "clock": {"initial": 300, "increment": 0, "totalTime": 300},
            "players": {
                "white": {"user": {"name": "Alice", "id": "alice"}, "rating": 1500},
                "black": {"user": {"name": "Bob", "id": "bob"}, "rating": 1500},
            },
            "pgn": pgn,
        }
        result = normalize_lichess_game(game, "Alice", user_id=1)
        assert result is not None
        assert result.initial_fen == CUSTOM_START_FEN

    def test_pasted_custom_start_populates_from_the_derived_root(self):
        """normalize_pasted_game sources the root from game.board(), not the header
        regex — but must land on the same value (D-06)."""
        from app.services.normalization import normalize_pasted_game

        # Bxb4 is the main Evans Gambit acceptance from CUSTOM_START_FEN; a
        # concrete [Result] is required because a "*" with a non-terminal final
        # board has no honest result and normalize_pasted_game returns None.
        pgn = _pgn_with_headers(
            f'[SetUp "1"]\n[FEN "{CUSTOM_START_FEN}"]\n[Result "1-0"]',
            movetext="4... Bxb4 5. c3 Ba5 1-0",
        )
        result = normalize_pasted_game(pgn, user_id=1, user_color="black")
        assert result is not None
        assert result.initial_fen is not None
        # python-chess re-emits the FEN, so compare on the identity-relevant
        # prefix rather than byte equality.
        from app.services.normalization import canonical_root_fen

        assert canonical_root_fen(result.initial_fen) == canonical_root_fen(CUSTOM_START_FEN)

    def test_pasted_standard_start_stays_none(self):
        from app.services.normalization import normalize_pasted_game

        pgn = _pgn_with_headers('[Result "1-0"]', movetext="1. e4 e5 2. Nf3 Nc6 1-0")
        result = normalize_pasted_game(pgn, user_id=1, user_color="white")
        assert result is not None
        assert result.initial_fen is None


class TestMigrationBackfillSqlMatchesPythonHelper:
    """D-06: the Phase 210 migration's SQL backfill and extract_initial_fen must
    agree, or existing rows and newly-imported rows get different answers.

    The migration exports its own UPDATE as BACKFILL_SQL precisely so this test
    can execute the exact statement that ran in production, rather than a
    paraphrase that could silently drift from it.
    """

    @pytest.mark.asyncio
    async def test_sql_and_python_agree_on_shared_fixtures(self, db_session) -> None:
        import importlib.util
        import pathlib

        from sqlalchemy import select, text

        from app.models.game import Game
        from app.models.user import User
        from app.services.normalization import extract_initial_fen

        # alembic/versions is not an importable package (the filenames start with
        # a digit), so load the revision module by path.
        migration_path = (
            pathlib.Path(__file__).parent.parent
            / "alembic"
            / "versions"
            / "20260815_084711_0ac0176294fd_phase_210_games_initial_fen.py"
        )
        spec = importlib.util.spec_from_file_location("_phase_210_migration", migration_path)
        assert spec is not None and spec.loader is not None
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)

        # Each fixture is a PGN plus the answer extract_initial_fen gives; the
        # SQL must land on the same value for every one of them.
        pgns = [
            _pgn_with_headers(f'[SetUp "1"]\n[FEN "{CUSTOM_START_FEN}"]'),
            _pgn_with_headers(f'[SetUp "1"]\n[FEN "{STANDARD_START_FEN}"]'),
            _pgn_with_headers(f'[FEN "{CUSTOM_START_FEN}"]'),
            _pgn_with_headers('[Result "1-0"]'),
            _pgn_with_headers(f'[ SetUp  "1" ]\n[ FEN  "{CUSTOM_START_FEN}" ]'),
            # Malformed FEN: python-chess raises so the helper returns None. The
            # SQL must reach the same answer, or a backfilled row would carry an
            # unparseable root that `new Chess(fen)` throws on downstream.
            _pgn_with_headers('[SetUp "1"]\n[FEN "not-a-fen"]'),
            _pgn_with_headers('[SetUp "1"]\n[FEN ""]'),
        ]

        user = User(
            email="migration-agreement@test.local",
            hashed_password="",
            is_active=True,
            is_superuser=False,
            is_verified=False,
        )
        db_session.add(user)
        await db_session.flush()

        game_ids: list[int] = []
        for i, pgn in enumerate(pgns):
            game = Game(
                user_id=user.id,
                platform="chess.com",
                platform_game_id=f"migration-agreement-{i}",
                pgn=pgn,
                result="1-0",
                user_color="white",
                rated=True,
                white_username="a",
                black_username="b",
                initial_fen=None,  # as an un-backfilled row would be
            )
            db_session.add(game)
            await db_session.flush()
            game_ids.append(game.id)

        # Run the migration's own UPDATE against these rows.
        await db_session.execute(text(migration.BACKFILL_SQL))

        rows = (
            await db_session.execute(
                select(Game.id, Game.pgn, Game.initial_fen).where(Game.id.in_(game_ids))
            )
        ).all()
        assert len(rows) == len(pgns)

        for _, pgn, sql_result in rows:
            assert sql_result == extract_initial_fen(pgn), (
                "the migration's SQL and extract_initial_fen disagree on this PGN — "
                "backfilled rows and freshly-imported rows would diverge"
            )

        # And the fixture set must actually exercise both outcomes, or the
        # agreement above would be vacuous.
        results = [r[2] for r in rows]
        assert any(r is not None for r in results)
        assert any(r is None for r in results)
