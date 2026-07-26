"""Pydantic v2 schemas for the Train API (Phase 189).

POOL-10 / P-01: `TrainPuzzle` is the pre-attempt payload and carries no
answer key — see its class docstring for the exact-equality contract this
schema exists to enforce.
"""

from __future__ import annotations

from datetime import date
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator


class TrainPuzzle(BaseModel):
    """One pre-attempt puzzle.

    POOL-10 / P-01 (LOCKED): the pre-attempt payload carries no answer key.
    `last_move_uci` (190-02, SOLV-02) describes the position's ARRIVAL — the
    half-move immediately before `ply`, i.e. the opponent's (or the user's
    own) prior move — so the solve screen can animate/highlight it. It does
    not reveal what to play next, so it does not reopen POOL-10. `best_move`,
    `pv`, `puzzle_type`, and `source` remain forbidden: adding any of them
    here re-opens the POOL-10 leak this schema exists to close — the
    client's exact-match/grading path runs entirely client-side against its
    own vendored Stockfish WASM output (see 189-01-PLAN.md P-01). Do not add
    fields here without re-reading that decision.
    """

    position: int
    game_id: int
    ply: int
    fen: str
    side_to_move: Literal["white", "black"]
    last_move_uci: str | None


class TrainSessionResponse(BaseModel):
    """Response for POST /train/sessions — a composed or resumed session.

    `session_id` is nullable: per the repository's explicit "write NO
    drill_sessions row when nothing qualifies" contract, a request that finds
    no eligible puzzle returns `session_id=None`, `puzzle_count=0`,
    `puzzles=[]` rather than a persisted empty session.

    `requested_count` is the settings value of N (`puzzles_per_session`);
    `blob_pending_count` is the number of the user's own qualifying blunders
    still waiting on opportunistic tier-4 analysis to populate their answer
    key. A caller seeing `puzzle_count < requested_count` MUST read
    `blob_pending_count` to tell "still analyzing" (non-zero) apart from
    "genuinely caught up" (zero) — removing either field re-hides the
    Pitfall 4 signal this schema exists to surface.
    """

    session_id: int | None
    session_date: date
    expires_on: date
    puzzle_count: int
    requested_count: int
    solved_count: int
    blob_pending_count: int
    puzzles: list[TrainPuzzle]


class SolveRequest(BaseModel):
    """Body for POST /train/sessions/{session_id}/solve.

    P-02 (LOCKED): the client asserts `correct_move` (the backend never
    grades the move — see the module/plan docstrings) but NEVER
    `correct_guess` or `puzzle_type` — those are computed server-side from
    the live `game_flaws` blob so the sharp/soft ground truth is never
    handed to the client before the attempt (T-189-18/T-189-11).
    """

    position: int
    guess: Literal["critical", "several"]
    # UCI move string: 4 chars normal (e.g. "e2e4"), 5 chars promotion (e.g. "e7e8q").
    played_move: str = Field(min_length=4, max_length=5)
    correct_move: bool


class SolveResponse(BaseModel):
    """Response for POST /train/sessions/{session_id}/solve.

    `item_status`/`streak`/`due_date` are None for a red-herring puzzle,
    which carries no SR bookkeeping (POOL-08). `correct_guess` is always the
    server-computed verdict, never an echo of the client's own guess.
    """

    correct_guess: bool
    correct_move: bool
    puzzle_type: Literal["sharp", "soft", "herring"]
    item_status: Literal["active", "mastered", "parked"] | None
    streak: int | None
    due_date: date | None
    session_complete: bool


class PuzzleRevealResponse(BaseModel):
    """Response for GET /train/sessions/{session_id}/puzzles/{position}/reveal.

    Reachable ONLY after the attempt is recorded (409 otherwise — T-189-17):
    the puzzle type and the in-game move are unreachable before `solved_at`
    is set.

    190.1-03 (D-01/D-05): this response is DELIBERATELY thin. The answer key
    it carries is the puzzle type, the in-game move (SAN + UCI), and a
    tactic-lines pointer — no `best_move`, `best_move_san`, or `pv` field.
    The best move, the best line, and every eval shown in the reveal panel
    are computed CLIENT-SIDE by the grading engine (`useTrainGradingEngine.ts`),
    never derived or stored here — a server-stored Stockfish eval and the
    client's own WASM search are not guaranteed to agree bit-for-bit
    (project_eval_nondeterminism), so this endpoint must never be a second,
    contradicting source of truth for a number the reveal panel displays.

    `played_in_game_move_uci` (190.1-01, D-05) is the UCI counterpart of
    `played_in_game_san`, behind the identical 409 gate — the client uses it
    to dispatch its own reveal-time engine search (T-190.1-01/T-190.1-02).

    `has_tactic_lines` is a POINTER, not a payload: when True, the client
    calls the existing `GET /api/library/flaws/{game_id}/{ply}/tactic-lines`
    endpoint for the steppable PV line. Train adds no second PV-fetching
    surface — see 189-05-PLAN.md's key_links.
    """

    game_id: int
    ply: int
    fen: str
    played_in_game_san: str | None
    played_in_game_move_uci: str | None
    puzzle_type: Literal["sharp", "soft", "herring"]
    source: Literal["sr_item", "red_herring"]
    has_tactic_lines: bool


class TrainSettingsResponse(BaseModel):
    """Response for GET/PUT /train/settings."""

    timezone: str
    weekday_mask: int
    puzzles_per_session: int


class TrainSettingsUpdate(BaseModel):
    """Body for PUT /train/settings.

    A separate schema from `TrainSettingsResponse` (not one schema reused for
    both directions) so a PUT body can never smuggle a server-owned field.
    `weekday_mask`/`puzzles_per_session` bounds mirror the `train_settings`
    table's CHECK constraints exactly.
    """

    timezone: str
    weekday_mask: int = Field(ge=0, le=127)
    puzzles_per_session: int = Field(ge=1, le=50)

    @field_validator("timezone")
    @classmethod
    def _validate_timezone(cls, value: str) -> str:
        """D-06: reject an unresolvable IANA timezone with 422, never persist it.

        A stored bad zone would silently shift every future due-date and
        session-window computation (`local_today` falls back to UTC for a
        legacy bad value already on a row, but nothing new may be written
        that way).
        """
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"Unrecognized IANA timezone: {value!r}") from exc
        return value


__all__ = [
    "PuzzleRevealResponse",
    "SolveRequest",
    "SolveResponse",
    "TrainPuzzle",
    "TrainSessionResponse",
    "TrainSettingsResponse",
    "TrainSettingsUpdate",
]
