"""Pool-entry SQL assembly for Train (Phase 189).

POOL-01: a user's own qualifying blunder becomes a `drill_items` candidate
when (a) the mover is the user (ply-parity via `player_only_gate` —
`app/repositories/query_utils.py` documents a prior off-by-one bug in this
exact area; NEVER hand-roll `ply % 2`), (b) it is a blunder
(`game_flaws.severity == 2`), (c) an answer key exists — a NON-EMPTY
`game_flaws.missed_pv_lines` array (see `answer_key_present`; a non-NULL but
EMPTY `[]` array is the eval pipeline's D-06 "un-fillable" sentinel and is
excluded exactly like true SQL NULL, 189-06 gap closure), and (d) the
PRE-flaw-move position clears the winnability floor.

Winnability floor eval source (Pitfall 2, LOAD-BEARING): `game_positions.eval_cp`
is post-move shifted — the eval AT row `ply` describes the position AFTER
move `ply`. The floor must read the PRIOR row's eval (`ply - 1`, the position
BEFORE the flaw move, which is what the drill puzzle actually presents), via
an aliased self-join (`PriorPosition`) — never the flaw ply's own row. Do NOT
reuse `library_repository.is_decided_lost`/`decided_lost_sql`: that predicate
is a stricter, differently-purposed "already decisively lost" cutoff for tag
suppression on the Flaws tab, not this feature's softer ~20-25% expected-score
floor (Pitfall 6).
"""

from __future__ import annotations

import io
import math
from typing import Any, Literal

import chess.pgn
from sqlalchemy import Select, and_, case, cast, exists, func, literal, select, true
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import undefer
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.sql.selectable import LateralFromClause

from app.models.drill_solve import DrillSolve, DrillSource
from app.models.game import Game
from app.models.game_best_move import GameBestMove
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.repositories.query_utils import player_only_gate
from app.services.best_move_candidates import best_move_tier_sql
from app.services.eval_utils import LICHESS_K, eval_cp_to_expected_score
from app.services.flaws_service import MATE_CP_EQUIVALENT, MISTAKE_DROP

# P-05: low end of the seed's ~20-25% expected-score band. Planner discretion
# (CONTEXT.md "Claude's Discretion").
WINNABILITY_FLOOR_ES: float = 0.20

# P-04: a puzzle is "sharp" (second-best is itself a mistake) at exactly the
# same gap flaws_service.classify_best_move's C2 gate uses — no new magic
# number. See app/services/best_move_candidates.py's MISTAKE_DROP reuse.
SHARP_GAP_ES: float = MISTAKE_DROP

# game_flaws.severity: 1=mistake, 2=blunder (game_flaws is M+B only, D-03 of
# an earlier phase — see app/models/game_flaw.py). Train's pool is
# blunders-only (POOL-01).
_SEVERITY_BLUNDER: int = 2

# POOL-03: red herrings make up 25% of every session mix. Planner discretion
# per the seed's stated ratio (CONTEXT.md "Claude's Discretion").
HERRING_SHARE: float = 0.25

# POOL-02: a puzzle's ground-truth classification — "sharp" when the runner-up
# at node 0 is itself a mistake (only one move is right); "soft" otherwise
# (avoid-the-blunder). Never an entry gate — see classify_puzzle_type.
PuzzleType = Literal["sharp", "soft"]


def expected_score_sql(cp_col: Any, mate_col: Any, user_color_col: Any) -> ColumnElement[float]:
    """SQL twin of `eval_cp_to_expected_score` / `eval_mate_to_expected_score`.

    Expected score of a position from the user's POV as a SQLAlchemy Core
    expression. Option-B mate mapping (mate maps to ±MATE_CP_EQUIVALENT
    centipawns BEFORE the shared LICHESS_K sigmoid, mate takes priority over
    cp when both are present) — matches
    `app.services.best_move_candidates._es_sql`'s branch order exactly, so
    Train's winnability floor and the Library's gem/great classifier can
    never silently disagree on how a mate score converts.

    Its Python twin is `app.services.eval_utils.eval_cp_to_expected_score`
    (cp-only; mate handling here is Option-B, not that module's hard-1.0/0.0
    `eval_mate_to_expected_score` — see this module's docstring for why the
    two mate conventions differ by design).

    Args:
        cp_col: A column/expression resolving to a white-perspective
            centipawn eval, or NULL.
        mate_col: A column/expression resolving to a white-perspective
            mate-in-N eval, or NULL. Takes priority over cp_col when present.
        user_color_col: A column/expression resolving to 'white'/'black'.

    Returns:
        A SQLAlchemy ColumnElement[float] in (0, 1), or NULL when both
        cp_col and mate_col are NULL.
    """
    sign = case((user_color_col == "white", 1.0), else_=-1.0)
    mate_cp_equiv = case(
        (mate_col > 0, float(MATE_CP_EQUIVALENT)), else_=-float(MATE_CP_EQUIVALENT)
    )
    return case(
        (mate_col.isnot(None), 1.0 / (1.0 + func.exp(-LICHESS_K * sign * mate_cp_equiv))),
        (cp_col.isnot(None), 1.0 / (1.0 + func.exp(-LICHESS_K * sign * cp_col))),
        else_=literal(None),
    )


def expected_score_for(
    eval_cp: int | None, eval_mate: int | None, mover_color: Literal["white", "black"]
) -> float | None:
    """Python twin of `expected_score_sql` — mover-POV expected score for one
    (cp, mate) eval pair, or None when both are absent.

    Option-B mate mapping, matching `app.services.best_move_candidates.
    _eval_to_expected_score`'s branch order exactly: when `eval_mate` is
    present, map it to ±`MATE_CP_EQUIVALENT` centipawns and fall through to
    the shared sigmoid (mate takes priority over cp when both are present);
    otherwise use `eval_cp` directly. The sigmoid itself is
    `eval_cp_to_expected_score` — no second sigmoid is declared here. If
    either side of this Python/SQL pair changes, update the other — the same
    sync discipline `expected_score_sql`'s docstring documents.

    Args:
        eval_cp: White-perspective centipawn eval, or None.
        eval_mate: White-perspective mate-in-N distance, or None. Takes
            priority over eval_cp when both are present.
        mover_color: "white" or "black" — the position's mover.

    Returns:
        Expected score in (0, 1), or None when both eval_cp and eval_mate
        are None.
    """
    if eval_mate is not None:
        cp_equiv = MATE_CP_EQUIVALENT if eval_mate > 0 else -MATE_CP_EQUIVALENT
        return eval_cp_to_expected_score(cp_equiv, mover_color)
    if eval_cp is not None:
        return eval_cp_to_expected_score(eval_cp, mover_color)
    return None


def classify_puzzle_type(
    missed_pv_lines: list[Any] | None, mover_color: Literal["white", "black"]
) -> PuzzleType:
    """Classify a blunder's puzzle type from its node-0 best-vs-second gap (POOL-02).

    A classifier, NEVER an entry gate (P-04): a "soft" blunder still qualifies
    for the pool via `pool_entry_stmt` — it just becomes an avoid-the-blunder
    puzzle instead of a sharp one (see `test_soft_blob_still_enters_pool`).

    Reads node 0 of `missed_pv_lines` by index — no re-sorting of the blob.
    Node keys (see `GameFlaw.missed_pv_lines`'s model docstring): `b`/`bm` for
    the best move's (cp, mate), `s`/`sm` for the second-best's, both
    white-perspective; `su` is the second-best move's UCI string, or the
    empty-string sentinel when there is no legal second move at all (only one
    move can be right, so that node is unconditionally "sharp").

    `SHARP_GAP_ES` aliases `MISTAKE_DROP` (P-04): a sharp puzzle is exactly
    one where the runner-up is itself a mistake relative to the best move —
    no separate numeric literal is declared for this threshold.

    Returns "soft" — the non-leaking default that never raises — for every
    degenerate blob shape: None, an empty list, a non-dict node 0, or either
    expected score resolving to None (missing cp/mate on either side).
    Otherwise returns "sharp" when `best_es - second_es >= SHARP_GAP_ES`
    (inclusive boundary), else "soft".

    Args:
        missed_pv_lines: The `GameFlaw.missed_pv_lines` blob (a list of node
            dicts), or None/empty when no answer key is stored.
        mover_color: "white" or "black" — the flaw-maker's color, i.e. the
            mover at the position node 0 describes.

    Returns:
        "sharp" or "soft" — never raises.
    """
    if not missed_pv_lines:
        return "soft"
    node = missed_pv_lines[0]
    if not isinstance(node, dict):
        return "soft"
    if node.get("su") == "":
        return "sharp"
    best_es = expected_score_for(node.get("b"), node.get("bm"), mover_color)
    second_es = expected_score_for(node.get("s"), node.get("sm"), mover_color)
    if best_es is None or second_es is None:
        return "soft"
    return "sharp" if best_es - second_es >= SHARP_GAP_ES else "soft"


def answer_key_present(col: Any) -> ColumnElement[bool]:
    """True when `col` (a `missed_pv_lines`-shaped JSONB column) holds a
    genuinely usable answer key (189-06 gap closure).

    Bug-fix comment (CLAUDE.md): the eval pipeline's D-06 sentinel write
    (`app/services/eval_apply.py`'s `_assemble_one_line_blob` /
    `_batch_update_flaw_pv_lines`) stores a non-NULL, EMPTY `[]` JSONB array
    for an answer-key line it could not fill (NULL prior-ply PV, or a PV walk
    shorter than 2 nodes). A bare `col.isnot(None)` test therefore admits a
    flaw with no usable answer key — directly contradicting POOL-01 and
    ROADMAP Success Criterion 1, both of which require a NON-EMPTY
    `missed_pv_lines` blob. This predicate closes that gap by requiring the
    value to be a JSON array AND not the empty-array literal.

    The `jsonb_typeof(col) == "array"` clause does double duty: it rejects
    the empty-array sentinel's siblings (a `null::jsonb` scalar, which can
    land in this column instead of true SQL NULL via the documented asyncpg
    None-binding gotcha — `project_asyncpg_jsonb_null_vs_sql_null`) as well
    as any other non-array JSONB shape.

    Every clause here is a TOTAL operator (`IS NOT NULL`, `jsonb_typeof`,
    `<>`) — deliberately NOT an array-element-count check gated by a
    preceding `jsonb_typeof` test. Verified directly against the dev DB:
    Postgres does not guarantee AND-clause evaluation order, so pairing
    `jsonb_typeof(...) = 'array'` with an array-count guard can still raise
    `cannot get array length of a scalar` when the planner evaluates the
    count function before the type guard (see 189-06-PLAN.md's
    `<gap_reference>` Fact 2 for the exact reproduction). Do NOT "simplify"
    this back to a count-based form — it is a live crash, not a style
    preference.

    Args:
        col: A JSONB column/expression, typically `GameFlaw.missed_pv_lines`.

    Returns:
        A boolean SQLAlchemy expression: non-NULL, a JSON array, and not the
        empty-array literal.
    """
    empty_array = cast(literal("[]"), JSONB)
    return and_(col.isnot(None), func.jsonb_typeof(col) == "array", col != empty_array)


def answer_key_pending(col: Any) -> ColumnElement[bool]:
    """True when `col` (a `missed_pv_lines`-shaped JSONB column) has not yet
    been processed by the eval pipeline — i.e. true SQL NULL (189-06 D-GAP-01).

    DELIBERATELY NOT the boolean negation of `answer_key_present`. A NULL
    blob has not been processed yet and self-heals through the tier-4 blob
    lottery (`app/routers/eval_remote.py`'s `allowed_pv_lines IS NULL` claim
    predicate) the next time that lane runs. The D-06 empty-array sentinel
    is the opposite: the eval pipeline writes it specifically to CLEAR the
    lottery's `IS NULL` predicate "so the game is never re-picked" — it is
    terminal, not transient, and never self-heals.

    Counting the terminal `[]` case as "pending" would pin
    `TrainSessionResponse.blob_pending_count` (the "still analyzing" signal,
    see `blob_pending_stmt`) at a permanently non-zero floor that never
    resolves — exactly the dishonest signal that field exists to prevent.
    So the terminal case is reported in NEITHER `pool_entry_stmt` NOR this
    predicate: it is excluded, uncounted, silent (D-GAP-01 in
    `189-06-PLAN.md`).

    Args:
        col: A JSONB column/expression, typically `GameFlaw.missed_pv_lines`.

    Returns:
        A boolean SQLAlchemy expression: true SQL NULL only.
    """
    return col.is_(None)


def _prior_position_lateral(
    *, name: str, user_id_col: Any, game_id_col: Any, ply_expr: Any
) -> LateralFromClause:
    """A `LEFT JOIN LATERAL` onto `game_positions` for one correlated
    `(user_id, game_id, ply)` lookup, yielding `.c.eval_cp` / `.c.eval_mate`.

    Bug fix (Phase 190-01 checkpoint, discovered via manual browser UAT):
    a plain `isouter`-joined self-alias of `GamePosition`, correlated on
    `(user_id, game_id, ply [- N])` inside a larger query, defeats
    Postgres's ability to push that correlation into `game_positions_pkey`
    `(user_id, game_id, ply)` as an `Index Cond` on this schema/query
    shape. Confirmed via `EXPLAIN (ANALYZE, BUFFERS)` against the dev DB
    (a real user, ~200k `game_positions` rows, ~1.1k qualifying outer
    rows): the planner used ONLY `user_id` as the `Index Cond` and pushed
    `game_id`/`ply` down to a `Join Filter` instead, re-scanning that
    user's entire index range on every outer row — 108M rows filtered,
    ~21-27s wall time. The identical predicates as a `LATERAL` subquery
    (this function) resolve the correlation BEFORE the inner scan is
    planned, so Postgres parameterizes the composite index scan on all
    three columns — same result set, ~140ms. `LIMIT 1` is a semantic no-op
    (`game_positions_pkey` is unique on these three columns) but keeps the
    per-call cost estimate honest. Do not revert to a plain self-join here.

    Args:
        name: Distinct SQL alias for the LATERAL subquery (each call site
            in this module needs its own, matching the old aliased-join
            names so `EXPLAIN` output stays readable).
        user_id_col: The outer query's `user_id`-equivalent column to
            correlate against (`GameFlaw.user_id` / `Game.user_id` — the
            candidate table's own user scope).
        game_id_col: The outer query's `game_id` column to correlate
            against.
        ply_expr: The outer query's ply expression to match (`X.ply - 1`
            for the PRE-flaw-move position, or `X.ply` for the flaw ply
            itself).

    Returns:
        A `Lateral` construct — `.outerjoin(this, true())` it onto the
        query's FROM clause, then read `.c.eval_cp` / `.c.eval_mate`.
    """
    return (
        select(GamePosition.eval_cp, GamePosition.eval_mate)
        .where(
            GamePosition.user_id == user_id_col,
            GamePosition.game_id == game_id_col,
            GamePosition.ply == ply_expr,
        )
        .limit(1)
        .lateral(name)
    )


def pool_entry_stmt(user_id: int) -> Select[tuple[GameFlaw, Game]]:
    """Own-blunder pool-entry candidates for `user_id` (POOL-01).

    Selects `GameFlaw`/`Game` rows for the user's own qualifying blunders:
    ply-parity via `player_only_gate` (never hand-rolled `ply % 2`), severity
    == blunder, a non-empty `missed_pv_lines` answer-key blob, and the
    PRE-flaw-move position (an aliased `PriorPosition` self-join on
    `ply - 1`, LEFT-joined since a ply-0 flaw has no `ply - 1` row to match)
    clearing `WINNABILITY_FLOOR_ES`.

    `.options(undefer(GameFlaw.missed_pv_lines))` is mandatory here —
    `missed_pv_lines` is `deferred=True` by design (structural leak guard,
    see app/models/game_flaw.py) and would otherwise raise `MissingGreenlet`
    the first time async code implicitly touches it outside this query's
    session context.

    Args:
        user_id: Authenticated user's internal PK (V4: never client-supplied
            — callers must source this from `current_active_user.id`).

    Returns:
        A SQLAlchemy Select yielding `(GameFlaw, Game)` rows for every
        qualifying own blunder, unordered (callers apply their own ORDER BY).
    """
    prior_position = _prior_position_lateral(
        name="pool_entry_prior_position",
        user_id_col=GameFlaw.user_id,
        game_id_col=GameFlaw.game_id,
        ply_expr=GameFlaw.ply - 1,
    )
    expected_score = expected_score_sql(
        prior_position.c.eval_cp, prior_position.c.eval_mate, Game.user_color
    )
    return (
        select(GameFlaw, Game)
        .join(Game, Game.id == GameFlaw.game_id)
        .outerjoin(prior_position, true())
        .options(undefer(GameFlaw.missed_pv_lines))
        .where(
            GameFlaw.user_id == user_id,
            GameFlaw.severity == _SEVERITY_BLUNDER,
            player_only_gate(GameFlaw.ply, Game.user_color),
            answer_key_present(GameFlaw.missed_pv_lines),
            expected_score >= WINNABILITY_FLOOR_ES,
        )
    )


def herring_stmt(user_id: int, *, exclude_served: bool = True) -> Select[tuple[GameBestMove, Game]]:
    """Red-herring source candidates for `user_id` (POOL-03).

    Selects `GameBestMove`/`Game` rows for user-owned, "several fine moves"
    positions: the mover is the user (`player_only_gate`, never hand-rolled
    parity), the best move does NOT clearly beat the runner-up
    (`best_move_tier_sql(...).is_(None)` AND the best/second expected-score
    gap is below `SHARP_GAP_ES`), and the PRE-move position clears
    `WINNABILITY_FLOOR_ES` via a `PriorPosition` self-join on `ply - 1`
    (mirroring `pool_entry_stmt`'s Pitfall-2 prior-ply eval source).

    `game_best_moves` has NO `user_id` column — candidacy is position-scoped,
    not user-scoped (see `GameBestMove`'s model docstring). The
    `Game.user_id == user_id` correlation to an already user-scoped `games`
    row is therefore the ONLY access-control seam (mirrors
    `library_repository.best_move_exists_from_table`'s IDOR-safety comment).

    Tier-IS-NULL alone is insufficient (this plan's flagged POOL-03
    assumption): `best_move_tier_sql` also returns NULL for an easy-to-find
    move with a LARGE best/second gap (high `maia_prob`, big margin) — a
    terrible herring, since the "several fine moves" guess would be wrong
    there. Requiring BOTH conditions (tier NULL AND gap < `SHARP_GAP_ES`)
    matches POOL-03's own "best ≈ second" parenthetical.

    `GuardPos` (a second aliased `GamePosition`, joined on the candidate's OWN
    ply) feeds `best_move_tier_sql`'s imported-eval divergence guard exactly
    as `library_repository.best_move_exists_from_table` wires it — distinct
    from `PriorPosition`, which feeds the winnability floor on `ply - 1`.

    Herrings carry NO SR bookkeeping: this function never reads or writes
    `DrillItem`/`drill_items`.

    Exhaustion contract: when a caller's `exclude_served=True` query returns
    no rows, it re-runs with `exclude_served=False` to allow repeats — that
    fallback lives with this query's contract, not duplicated at call sites.

    Args:
        user_id: Authenticated user's internal PK (V4: never client-supplied
            — callers must source this from `current_active_user.id`).
        exclude_served: When True (default), exclude any (game_id, ply) pair
            already served to this user as a red herring
            (`drill_solves.source == DrillSource.RED_HERRING`). Set False to
            allow repeats once the source is exhausted.

    Returns:
        A SQLAlchemy Select yielding `(GameBestMove, Game)` rows ordered by
        `Game.played_at DESC` (nulls last), then `GameBestMove.game_id DESC`,
        then `GameBestMove.ply ASC` — recency-weighted and fully
        deterministic.
    """
    # LATERAL, not a plain self-join — see `_prior_position_lateral`'s
    # docstring (Phase 190-01 checkpoint bug fix): the same composite-index
    # planner pathology applies to both correlations here, offset ply and
    # same-ply alike.
    prior_position = _prior_position_lateral(
        name="herring_prior_position",
        user_id_col=Game.user_id,
        game_id_col=GameBestMove.game_id,
        ply_expr=GameBestMove.ply - 1,
    )
    guard_position = _prior_position_lateral(
        name="herring_guard_pos",
        user_id_col=Game.user_id,
        game_id_col=GameBestMove.game_id,
        ply_expr=GameBestMove.ply,
    )

    tier_expr = best_move_tier_sql(
        GameBestMove.maia_prob,
        GameBestMove.best_cp,
        GameBestMove.best_mate,
        GameBestMove.second_cp,
        GameBestMove.second_mate,
        Game.user_color,
        guard_position.c.eval_cp,
        guard_position.c.eval_mate,
        Game.lichess_evals_at.isnot(None),
    )
    gap_expr = expected_score_sql(
        GameBestMove.best_cp, GameBestMove.best_mate, Game.user_color
    ) - expected_score_sql(GameBestMove.second_cp, GameBestMove.second_mate, Game.user_color)
    prior_es = expected_score_sql(
        prior_position.c.eval_cp, prior_position.c.eval_mate, Game.user_color
    )

    stmt = (
        select(GameBestMove, Game)
        .join(Game, Game.id == GameBestMove.game_id)
        .outerjoin(prior_position, true())
        .outerjoin(guard_position, true())
        .where(
            Game.user_id == user_id,
            player_only_gate(GameBestMove.ply, Game.user_color),
            tier_expr.is_(None),
            gap_expr < SHARP_GAP_ES,
            prior_es >= WINNABILITY_FLOOR_ES,
        )
    )
    if exclude_served:
        stmt = stmt.where(
            ~exists(
                select(DrillSolve.session_id).where(
                    DrillSolve.user_id == user_id,
                    DrillSolve.game_id == GameBestMove.game_id,
                    DrillSolve.ply == GameBestMove.ply,
                    DrillSolve.source == DrillSource.RED_HERRING,
                )
            )
        )
    return stmt.order_by(
        Game.played_at.desc().nullslast(),
        GameBestMove.game_id.desc(),
        GameBestMove.ply.asc(),
    )


def compose_slots(n: int) -> tuple[int, int]:
    """POOL-07: split `n` requested puzzles into a (sr_slots, herring_slots) pair.

    `herring_slots = floor(n * HERRING_SHARE)`; `sr_slots = n - herring_slots`
    deliberately absorbs the rounding remainder — learnable material (a
    user's own overdue/new blunders) outranks filler (red herrings) when `n`
    doesn't divide evenly at the 75/25 ratio. The two always sum to exactly
    `n`. Pure function, no I/O.

    Args:
        n: Requested puzzles per session (`train_settings.puzzles_per_session`).

    Returns:
        `(sr_slots, herring_slots)`, summing to `n`.
    """
    herring_slots = math.floor(n * HERRING_SHARE)
    sr_slots = n - herring_slots
    return sr_slots, herring_slots


def blob_pending_stmt(user_id: int) -> Select[tuple[int]]:
    """Count of the user's own qualifying blunders still waiting on an answer-key blob.

    Mirrors `pool_entry_stmt`'s own-blunder eligibility gate (ply-parity,
    `severity == blunder`, PRE-flaw-move winnability floor via the same
    `PriorPosition` self-join pattern) but uses `answer_key_pending` for the
    answer-key condition — `missed_pv_lines IS NULL` (true SQL NULL only).
    This is NOT the boolean negation of `pool_entry_stmt`'s
    `answer_key_present`: the D-06 empty-array sentinel (`[]`) is excluded
    from BOTH `pool_entry_stmt` and this count (see `answer_key_pending`'s
    docstring and D-GAP-01 in `189-06-PLAN.md` for why). This is the
    `TrainSessionResponse.blob_pending_count` source — the signal that
    distinguishes a session that's short because opportunistic tier-4
    analysis hasn't caught up yet from a genuinely exhausted pool (Pitfall 4
    in 189-RESEARCH.md).

    Args:
        user_id: Authenticated user's internal PK (V4: never client-supplied
            — callers must source this from `current_active_user.id`).

    Returns:
        A SQLAlchemy Select yielding a single integer count.
    """
    prior_position = _prior_position_lateral(
        name="blob_pending_prior_position",
        user_id_col=GameFlaw.user_id,
        game_id_col=GameFlaw.game_id,
        ply_expr=GameFlaw.ply - 1,
    )
    expected_score = expected_score_sql(
        prior_position.c.eval_cp, prior_position.c.eval_mate, Game.user_color
    )
    return (
        select(func.count())
        .select_from(GameFlaw)
        .join(Game, Game.id == GameFlaw.game_id)
        .outerjoin(prior_position, true())
        .where(
            GameFlaw.user_id == user_id,
            GameFlaw.severity == _SEVERITY_BLUNDER,
            player_only_gate(GameFlaw.ply, Game.user_color),
            answer_key_pending(GameFlaw.missed_pv_lines),
            expected_score >= WINNABILITY_FLOOR_ES,
        )
    )


def fen_and_last_move_at_ply(pgn: str, ply: int) -> tuple[str, str | None] | None:
    """Reconstruct the FULL FEN and the arriving move's UCI at `ply` (190-02).

    The single PGN-replay implementation shared by `full_fen_at_ply` (FEN
    only) and every Train puzzle-construction site that also needs the
    arriving move. P-03: `game_flaws.fen` is `board_fen()` (piece placement
    only — see its model docstring) and loses castling rights/en-passant,
    which a drill puzzle needs for legal-move generation. Parses `pgn` and
    replays `ply` half-moves. Wrapped in try/except per the project's
    PGN-parsing constraint (per-game try/except, handle malformed input
    gracefully) — an unparseable PGN or a ply past the game's end is an
    EXPECTED case for old/malformed imports, not a bug, so it is not
    `sentry_sdk.capture_exception`'d.

    The returned move describes HOW the position was reached — the
    half-move immediately before `ply` (the opponent's or the user's own
    prior move) — and is deliberately NOT answer-key data: it never reveals
    what to play next, only what was just played (T-190-05).

    Args:
        pgn: The game's full PGN text.
        ply: The half-move index to reconstruct the position at (0 = the
            starting position).

    Returns:
        `(fen, last_move_uci)`, where `last_move_uci` is None at ply 0 (no
        prior move exists), or None if the PGN could not be parsed or `ply`
        is past the end of the game. Callers (composition) must drop a
        puzzle whose FEN cannot be reconstructed rather than serving a
        broken board.
    """
    try:
        game = chess.pgn.read_game(io.StringIO(pgn))
        if game is None:
            return None
        moves = list(game.mainline_moves())
        if ply > len(moves):
            return None
        board = game.board()
        for move in moves[:ply]:
            board.push(move)
        last_move_uci = moves[ply - 1].uci() if ply > 0 else None
        return board.fen(), last_move_uci
    except (ValueError, IndexError, AttributeError):
        return None


def full_fen_at_ply(pgn: str, ply: int) -> str | None:
    """Reconstruct the FULL FEN (side-to-move, castling rights, en-passant) at `ply`.

    Delegates to `fen_and_last_move_at_ply` (the single PGN-replay
    implementation) and returns only the FEN — for callers that don't need
    the arriving move (e.g. the reveal path, which already has the played
    move from `game_positions.move_san`).

    Args:
        pgn: The game's full PGN text.
        ply: The half-move index to reconstruct the position at (0 = the
            starting position).

    Returns:
        The full FEN string at `ply`, or None if the PGN could not be parsed
        or `ply` is past the end of the game. Callers (composition) must drop
        a puzzle whose FEN cannot be reconstructed rather than serving a
        broken board.
    """
    result = fen_and_last_move_at_ply(pgn, ply)
    return result[0] if result is not None else None


__all__ = [
    "HERRING_SHARE",
    "SHARP_GAP_ES",
    "WINNABILITY_FLOOR_ES",
    "PuzzleType",
    "answer_key_pending",
    "answer_key_present",
    "blob_pending_stmt",
    "classify_puzzle_type",
    "compose_slots",
    "expected_score_for",
    "expected_score_sql",
    "fen_and_last_move_at_ply",
    "full_fen_at_ply",
    "herring_stmt",
    "pool_entry_stmt",
]
