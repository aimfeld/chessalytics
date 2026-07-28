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

    `game_id` is `int | None` (Phase 192 Plan 02, D-01/D-05): a red herring's
    source-game link is nullable provenance — `None` here means either the
    herring's source game has been deleted (the puzzle is still fully
    servable off its `herring_pool` row, D-03) or the pool row was never
    linked to a game in the first place. Never used as an identity key
    client-side; a puzzle's identity within a session is `position`.
    """

    position: int
    game_id: int | None
    ply: int
    fen: str
    side_to_move: Literal["white", "black"]
    last_move_uci: str | None


class SolvedResult(BaseModel):
    """One recorded solve's outcome, part of `TrainSessionResponse.solved_results`.

    Quick task 260728-tgc (BUGFIX-TRAIN-SCORE-CROSSDEVICE): one entry per
    `drill_solves` row with `solved_at IS NOT NULL`, in `position` order. The
    client aggregates these with its own points formula
    (`frontend/src/lib/trainScore.ts`, `scorePuzzle` + `aggregateSessionScore`)
    — that file stays the single source of truth for scoring (LOCKED, Option
    B). This response deliberately carries NO precomputed score integer;
    porting the formula server-side was considered and rejected (see
    `app.models.drill_solve.DrillMoveQuality`'s docstring, which explicitly
    forbids using its enum values to compute a score directly).

    Not an answer-key leak: both `correct_guess` and `move_quality` were
    already returned by `SolveResponse` for each of these same positions at
    the moment they were attempted — this endpoint just re-serves outcomes
    the client already saw once, from the server instead of a device-local
    cache. The `PuzzleRevealResponse` 409 gate (which protects the actual
    answer key — best move, PV, puzzle type) is untouched and continues to
    protect UNSOLVED positions only. Entries here carry no `position`,
    `game_id`, `ply`, or best-move field, so they reveal nothing about
    puzzles still to be attempted in the session.
    """

    correct_guess: bool
    move_quality: Literal["good", "inaccuracy", "wrong"]


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

    `solved_results` (260728-tgc) is one `SolvedResult` per recorded solve in
    `position` order — see that schema's docstring. Empty for a freshly
    composed session and for the no-eligible-material (`session_id is None`)
    case. This is what makes "Scored today" correct on a device that never
    saw the original solve responses (the reproduced prod bug: a
    localStorage-only tally read "0 of 18" on a second device).
    """

    session_id: int | None
    session_date: date
    expires_on: date
    puzzle_count: int
    requested_count: int
    solved_count: int
    blob_pending_count: int
    puzzles: list[TrainPuzzle]
    solved_results: list[SolvedResult]


class SolveRequest(BaseModel):
    """Body for POST /train/sessions/{session_id}/solve.

    P-02 (LOCKED) / SEED-119: the client asserts a three-way `move_quality`
    tier (the backend never grades the move — grading is still entirely
    client-side, see the module/plan docstrings) but NEVER `correct_guess`
    or `puzzle_type` — those are computed server-side from the live
    `game_flaws` blob so the sharp/soft ground truth is never handed to the
    client before the attempt (T-189-18/T-189-11). The server derives the
    spaced-repetition ladder's pass/fail boolean from `move_quality`
    (`!= "wrong"`) — see `app.repositories.train_repository.record_solve`.
    """

    position: int
    guess: Literal["critical", "several"]
    # UCI move string: 4 chars normal (e.g. "e2e4"), 5 chars promotion (e.g. "e7e8q").
    played_move: str = Field(min_length=4, max_length=5)
    move_quality: Literal["good", "inaccuracy", "wrong"]


class SolveResponse(BaseModel):
    """Response for POST /train/sessions/{session_id}/solve.

    `item_status`/`streak`/`due_date` are None for a red-herring puzzle,
    which carries no SR bookkeeping (POOL-08). `correct_guess` is always the
    server-computed verdict, never an echo of the client's own guess.

    SEED-119: `correct_move` retains its exact prior meaning — the
    spaced-repetition ladder's pass/fail verdict, which is also what the
    reveal's check/cross mark reads. `move_quality` is the new three-way
    scoring tier the client's points formula consumes; it is NOT a synonym
    for `correct_move` (an "inaccuracy" tier still means `correct_move=True`).
    """

    correct_guess: bool
    correct_move: bool
    move_quality: Literal["good", "inaccuracy", "wrong"]
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

    `game_id` is `int | None` (Phase 192 Plan 02, D-01/D-05): `None` means the
    puzzle's source game has since been deleted. The client hides the Analyze
    deep-link in that case (D-09) rather than disabling it — nothing else on
    the reveal panel references the game either way.
    """

    game_id: int | None
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


class TrainProgressResponse(BaseModel):
    """Response for GET /train/progress (PROG-01/PROG-04).

    Phase 193 (SEED-121) replaced Phase 191's weekly D-18 settled-streak
    snapshot with a per-scheduled-day tick + a 0-7 depletable shield:
    `session_streak_count` (was `settled_streak_weeks`; the wire field spells
    out the D-02 unit — it counts completed scheduled-day SESSIONS, not
    settled weeks) and `shield_level` (was `flame_state`, a 3-state enum;
    now a plain int) come from the persisted tick snapshot on
    `train_settings`, lazily advanced by this same request
    (`app.repositories.train_repository.settle_streak_snapshot`). There is
    no display overlay any more — the returned values are always exactly
    what is persisted. `current_week_required` is None when
    `weekday_mask == 0` ("train anytime" has no denominator to show);
    otherwise it is the popcount of the scheduled-day mask (no special-
    casing — nothing gates on this value any more).
    `mastered_count`/`parked_count` are computed on the fly from
    `drill_items` (D-05, unaffected by the tick snapshot — only the
    streak/shield portion is persisted).

    `waiting_count`/`pool_state`/`next_due_date` are the server-side signals
    the nav badge and the two PROG-05 empty states need: `waiting_count` is
    an upper-bound estimate of puzzles waiting right now (never a promise of
    exact session size — see
    `app.repositories.train_repository.get_waiting_puzzle_count`).
    `pool_state` is the single discriminant the client branches on for the
    empty states: `"no_material"` means the user has never had any
    qualifying material (cold start); `"exhausted"` means material existed
    but nothing is waiting and nothing is still analyzing; `"available"`
    covers every other case, including a zero-`drill_items` user whose own
    blunders are still being analyzed (that is "catching up", not a cold
    start). `next_due_date` is the earliest date an ACTIVE item will next
    resurface, or null when nothing will (the "All caught up!" empty state's
    date).

    `streak_reset_notice` (was `streak_lost_last_week`) is derived from the
    RESULTING state (never from "did this call settle the reset"), so it
    survives a page reload and self-clears once the user trains again.

    `badge_visible` (Plan 02, D-09/D-10) is a DISPLAY HINT ONLY — it gates no
    server-side authorization, and the number the nav badge shows still
    comes from `waiting_count`. True when `waiting_count > 0` AND (today is
    a scheduled day per the user's `weekday_mask` OR an already-open
    unexpired session still has unsolved puzzles left to rescue). The client
    performs no day-of-week or timezone math of its own — it has no
    `weekday_mask` and no clean way to reproduce `local_today`, so this
    field is the single source of truth for whether the badge should show.
    """

    session_streak_count: int
    shield_level: int
    current_week_completed: int
    current_week_required: int | None
    streak_reset_notice: bool
    mastered_count: int
    parked_count: int
    waiting_count: int
    pool_state: Literal["no_material", "exhausted", "available"]
    next_due_date: date | None
    badge_visible: bool


__all__ = [
    "PuzzleRevealResponse",
    "SolveRequest",
    "SolveResponse",
    "SolvedResult",
    "TrainProgressResponse",
    "TrainPuzzle",
    "TrainSessionResponse",
    "TrainSettingsResponse",
    "TrainSettingsUpdate",
]
