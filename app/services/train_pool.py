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

import datetime
import io
import math
import random
from collections.abc import Sequence
from typing import Any, Literal, TypeVar

import chess.pgn
from sqlalchemy import (
    Float,
    Integer,
    Select,
    and_,
    case,
    cast,
    column,
    exists,
    func,
    literal,
    or_,
    select,
    true,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import undefer
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.sql.selectable import LateralFromClause

from app.models.drill_solve import DrillSolve, DrillSource
from app.models.game import Game
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.models.herring_pool import HerringPool
from app.repositories.query_utils import mover_color_expr, player_only_gate
from app.services.eval_utils import LICHESS_K, eval_cp_to_expected_score
from app.services.flaws_service import (
    BLUNDER_DROP,
    INACCURACY_DROP,
    MATE_CP_EQUIVALENT,
    MISTAKE_DROP,
)

# P-05: low end of the seed's ~20-25% expected-score band. Planner discretion
# (CONTEXT.md "Claude's Discretion").
WINNABILITY_FLOOR_ES: float = 0.20

# P-04: a puzzle is "sharp" (second-best is itself a mistake) at exactly the
# same gap flaws_service.classify_best_move's C2 gate uses — no new magic
# number. See app/services/best_move_candidates.py's MISTAKE_DROP reuse.
SHARP_GAP_ES: float = MISTAKE_DROP

# SEED-141: a Train drill puzzle is only fair when failing to find the best
# move actually costs something. `dead_band_admissible` notices the best-vs-
# second GAP but not whether the runner-up STILL leaves the mover clearly
# winning ("you were +6, best is +9, runner-up is +4" — a puzzle asking the
# user to distinguish two winning moves, not to avoid a real mistake). This
# constant is the GM's framing verbatim: "+2" pawns, expressed in centipawns
# because the blob stores cp.
#
# MEASURED against prod (2026-08-08, 795,267 candidates / 266 users): the +2
# rule removes 23.9% of the pool, 90.7% of the cut is soft (avoid-the-blunder)
# material, and the sharp share rises 31.9% -> 38.9%. 14,704 of the removed
# candidates have a runner-up that is outright mating for the mover.
# Starvation is negligible (median distinct games 462 -> 403; 2 users drop to
# zero, both already effectively empty and covered by the herring / sharp-
# filler cross-backfill). The seed's one open question — +2 vs +3 — is
# RESOLVED by the operator in favour of +2.
#
# `forcing_line_gate.STILL_WINNING_FLOOR_CP` is numerically identical (also
# 200) but is a DIFFERENT, independently retunable knob (a PV line-extension
# cutoff, not a selection predicate) — do NOT import or reuse it here; the
# coincidence is noted so a future reader does not "deduplicate" them.
SECOND_BEST_WINNING_FLOOR_CP: int = 200

# game_flaws.severity: 1=mistake, 2=blunder (game_flaws is M+B only, D-03 of
# an earlier phase — see app/models/game_flaw.py). Train's pool is
# blunders-only (POOL-01).
_SEVERITY_BLUNDER: int = 2

# POOL-03: red herrings make up 25% of every session mix. Planner discretion
# per the seed's stated ratio (CONTEXT.md "Claude's Discretion").
HERRING_SHARE: float = 0.25

# Quick task 260728-pgp: a composed Train session draws at most this many
# puzzles from any single game, SESSION-WIDE across both SR sources (due
# drill_items and fresh pool_entry_stmt picks combined via a shared
# per-game count). Several blunders from one game a few plies apart (a
# hanging piece not captured for several moves) produce near-identical
# puzzles in the same sitting. MEASURED (dev, 2026-07-28): own qualifying
# blunders average 2.41/game, 32% of games have 3+, max 12; prod's worst
# (game_id, due_date) drill_items cluster is 6. Cap-1 is viable: 154/156
# non-guest prod users with any qualifying blunder have >=5 DISTINCT games
# carrying one (median 1069) — the 2-user starvation edge case is already
# covered by the existing herring cross-backfill, so the cap never needs
# relaxing.
MAX_ITEMS_PER_GAME_PER_SESSION: int = 1

# Phase 192 (POOL-03 amended, D-15): the herring_pool generation-time loose
# band. A candidate qualifies when at least HERRING_MIN_QUALIFYING_MOVES of
# its 5-move ladder are within this many points of expected score of the best
# move (inclusive at the band — generation is deliberately permissive; the
# strict qualifier gate runs at query time, Plan 04's job, so thresholds stay
# retunable with zero re-analysis).
#
# MEASURED (192-03 Task 2, 2026-07-28): 298-300 real MultiPV-5-searched dev
# candidates per phase (opening/middlegame/endgame), PV0-to-PV1 expected-score
# gap. The ~0.10 anchor is CONFIRMED, not moved: at 0.10 ES, 94.0% (opening),
# 93.0% (middlegame), and 83.3% (endgame) of searched candidates already have
# a second move within the band (>= HERRING_MIN_QUALIFYING_MOVES=2 satisfied
# by PV0+PV1 alone) — loosening further to 0.15 only gains another ~1-5
# points per phase (e.g. endgame 83.3% -> 87.7%), so 0.10 is not leaving a
# meaningful slice of real several-fine-moves positions on the table. It
# stays comfortably (2x) above the query-time tight gate (INACCURACY_DROP =
# 0.05), the retunability headroom D-15 requires. Full histograms and the
# measurement script are in the 192-03-SUMMARY.md. Retunable without
# re-analysis — the ladder is stored raw (D-16).
HERRING_LOOSE_BAND_ES: float = 0.10
# D-15: a candidate needs at least this many "several fine moves" ladder
# entries (including the best move itself) to qualify at generation time.
HERRING_MIN_QUALIFYING_MOVES: int = 2
# The generator's tally target for a comfortably-qualifying pool row (informational
# threshold consumed by scripts/gen_red_herring_pool.py's accept/reject logging).
HERRING_PREFERRED_QUALIFYING_MOVES: int = 3
# The MultiPV-5 ladder size — every stored `HerringPool.ladder` has exactly this
# many entries (see ck_herring_pool_ladder_shape).
HERRING_LADDER_SIZE: int = 5
# D-18: positions before this ply are excluded from the sampling frame — a red
# herring is a "several fine moves" MIDDLEGAME/endgame judgment call, not an
# opening-theory pick.
HERRING_MIN_PLY: int = 12
# A plain, uncorrelated pre-filter on the sampled row's OWN stored eval_cp
# (never a self-join): |eval_cp| <= this many centipawns keeps the sampled
# frame roughly balanced instead of drawing mostly-decided positions. Off-by-one
# ply noise in the stored eval costs only a noisier candidate frame, nothing
# else (SEED-120 Pitfall 1) — the real qualifier gate is the MultiPV-5 search.
HERRING_PREFILTER_ABS_CP: int = 200

# Phase 192 (POOL-03 amended, D-17), consumed at QUERY time by Plan 04: the
# minimum PV0-to-PV4 expected-score gap a stored row must have to be SERVED.
# Excludes the degenerate "every legal move is fine" tail (dead-drawn,
# totally winning) that MultiPV-5 exists to catch and boolean-count designs
# cannot.
#
# MEASURED (192-03 Task 2, 2026-07-28): same 298-300-candidate-per-phase
# sample, PV0-to-PV4 gap. The bottom of the distribution (gap < 0.02 ES) is
# 24.8% (opening), 17.0% (middlegame), 29.0% (endgame) of searched
# candidates — the genuinely flat, no-real-decision positions. 0.02 trims
# that tail while retaining 71-83% of the population per phase; one bucket
# down (0.01) only trims 5.0-18.3% (too thin a cut, especially opening/
# middlegame), and one bucket up (0.03) starts cutting 30.3-40.3% — deep
# enough into the body of genuine several-fine-moves positions to risk
# under-serving. Full histograms in 192-03-SUMMARY.md. Retunable without
# re-analysis — this is a query-time bound over the raw stored ladder
# (D-16), never baked into what gets stored (D-17: stored-and-excluded, not
# generation-time-filtered).
HERRING_DEGENERATE_MIN_GAP_ES: float = 0.02

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


def dead_band_admissible(missed_pv_lines_col: Any, ply_col: Any) -> ColumnElement[bool]:
    """True when `missed_pv_lines_col`'s node-0 best-vs-second expected-score
    gap clears Proposal A's dead band (D-05/D-11, SEED-137, Phase 205).

    The band is `[INACCURACY_DROP, BLUNDER_DROP)` — CLOSED at the lower edge,
    OPEN at the upper edge: a gap of exactly `INACCURACY_DROP` is EXCLUDED, a
    gap of exactly `BLUNDER_DROP` is KEPT and stays sharp. The 0.05 buffer
    (rather than the measured `ES_STABILITY_TOLERANCE` of 0.025) stands on
    SEED-130's rationale: the browser's Stockfish never clears its
    transposition table, so evaluator 2's reading of a position depends on
    what that Worker slot searched before.

    BOTH of D-03's degenerate node-0 shapes are excluded HERE, at the
    selection predicate, rather than in `classify_puzzle_type` — that
    function keeps its current return contract (it is a classifier, never an
    entry gate, P-04): the no-legal-second-move sentinel (`su == ""`) and an
    unreadable blob (a non-object node 0, or either expected score
    resolving to NULL).

    Callers MUST also apply `answer_key_present(missed_pv_lines_col)` in the
    same WHERE — this predicate assumes an already-validated non-NULL,
    non-empty JSON array (mirroring how `answer_key_pending`'s docstring
    cross-references its own sibling below).

    Mover color is derived from ply parity (`mover_color_expr`), never
    `Game.user_color` — every candidate row this predicate is ever applied to
    is already the user's OWN ply by construction (the player-only gate at
    pool entry), so ply parity and `Game.user_color` always agree for these
    rows. This is what lets the SAME predicate serve
    `get_waiting_puzzle_count`'s due-count statement, which deliberately
    drops the `Game` join.

    The total-operator hazard `answer_key_present`'s docstring documents was
    checked and does not apply here: this predicate pairs a JSONB type test
    with plain index/field extraction, never with an array function, and
    every operator here returns NULL rather than raising on wrong-shaped
    input (verified against the dev DB during research).

    `b`/`s` are cast to a float type, not an integer type: the boundary tests
    construct `b` via the exact sigmoid inverse, which is a non-integer, and
    an integer cast of a non-integer text value raises in Postgres — exactly
    the crash `answer_key_present`'s total-operator discipline forbids.
    `bm`/`sm` (mate distances) stay integer-cast — they are whole numbers,
    only null-checked and sign-compared by `expected_score_sql`.

    Args:
        missed_pv_lines_col: A JSONB column/expression, typically
            `GameFlaw.missed_pv_lines` — already validated non-NULL/non-empty
            by `answer_key_present` in the same WHERE.
        ply_col: A column/expression resolving to the ply integer, typically
            `GameFlaw.ply`.

    Returns:
        A SQLAlchemy ColumnElement[bool]: True when node 0 is fully readable
        AND its best-vs-second gap is outside `[INACCURACY_DROP, BLUNDER_DROP)`.
    """
    node0 = missed_pv_lines_col[0]
    second_uci = node0["su"].astext
    mover_color = mover_color_expr(ply_col)
    best_es = expected_score_sql(
        cast(node0["b"].astext, Float), cast(node0["bm"].astext, Integer), mover_color
    )
    second_es = expected_score_sql(
        cast(node0["s"].astext, Float), cast(node0["sm"].astext, Integer), mover_color
    )
    gap = best_es - second_es
    return and_(
        func.jsonb_typeof(node0) == "object",
        second_uci.isnot(None),
        second_uci != "",
        best_es.isnot(None),
        second_es.isnot(None),
        or_(gap >= BLUNDER_DROP, gap < INACCURACY_DROP),
    )


def second_best_not_winning_admissible(missed_pv_lines_col: Any, ply_col: Any) -> ColumnElement[bool]:
    """True when `missed_pv_lines_col`'s node-0 runner-up move does NOT leave
    the mover still clearly winning (SEED-141).

    Investigation findings (derived from the code, not assumed — see the
    plan's `<investigation>` block):

    1. SIGN / COLOR. `s`/`sm` are WHITE-perspective (confirmed via
       `app/models/game_flaw.py`'s D-05 blob-shape comment: "s — second_cp
       (int | null): second-best-move eval in centipawns, WHITE-perspective"
       and `app/services/forcing_line_gate.py`'s `PvNode` TypedDict restating
       the same convention). Mover POV is derived from ply parity via
       `mover_color_expr(ply_col)`, exactly as `dead_band_admissible` does it
       — never `Game.user_color` — so this predicate can serve the
       Game-join-free `get_waiting_puzzle_count` COUNT statement too.
    2. PLY OFFSET. `app/services/eval_apply.py`'s `_build_line_blobs` sets
       `node0_ply = flaw_ply` for the "missed" line (`node0_ply = flaw_ply if
       line == "missed" else flaw_ply + 1`) and reads `pos_eval[node0_ply]` /
       `second_best_map[node0_ply]` directly — `pos_eval` is a
       POSITION-keyed map (the eval OF that ply's position). `_post_move_eval`
       (the SINGLE site of the eval-pipeline's +1 post-move storage shift,
       per its own docstring) is used only when writing `game_positions`
       rows, never when assembling `missed_pv_lines`/`allowed_pv_lines`
       blobs. So node 0 of `missed_pv_lines` is decision-ply-keyed: `b`/`s`
       are the MultiPV-1/MultiPV-2 scores AT the flaw's own decision
       position — exactly "if the mover plays the runner-up instead of the
       best move" — and NO offset correction is needed here.
    3. MATE. `sm` is white-perspective mate distance (positive = white is
       mating), matching `bm`'s convention. Mover-POV mate is the
       ply-parity-sign-flipped value, computed the same way `expected_score_sql`
       flips cp. A mate FOR the mover (mover-POV mate > 0) is the degenerate
       "still winning" case this predicate exists to catch and is EXCLUDED;
       a mate AGAINST the mover (mover-POV mate < 0) is KEPT. Mate takes
       priority over cp — checked as an independent OR branch, matching
       `expected_score_sql`'s branch order, so a node carrying both `sm` and
       `s` (mate takes priority even when `s` also happens to be populated)
       resolves on the mate branch regardless of `s`'s value.
    4. NULL. See the predicate contract below.

    Predicate contract — written in POSITIVE (admissible) form with explicit
    `IS NULL` guards, never a bare `NOT` over a NULL-yielding comparison (the
    seed's warning: a bare `s_mover_cp >= threshold` under a `NOT` yields NULL
    for the sentinel/unreadable rows and silently drops every one of them).
    Admissible is TRUE when:
    - `su` is the empty-string sentinel (no legal second move -> nothing can
      "still be winning" -> unconditionally admissible), OR
    - mover-POV mate is present AND is a mate AGAINST the mover, OR
    - mover-POV mate is absent AND (mover-POV `s` is NULL, i.e. unreadable
      and therefore unprovable, OR mover-POV `s` is strictly below
      `SECOND_BEST_WINNING_FLOOR_CP`).

    An unreadable node-0 (`s`/`sm` both NULL) is KEPT here, not dropped: this
    predicate is an EXCLUSION rule and cannot prove "still winning" from a
    NULL. Unreadable node-0 blobs are already excluded by
    `dead_band_admissible` running in the same WHERE (it requires
    `best_es.isnot(None)`/`second_es.isnot(None)`), so nothing leaks through
    this predicate alone — do not tighten this into a NULL-drops form.

    Callers MUST also apply `answer_key_present(missed_pv_lines_col)` (and,
    in practice, `dead_band_admissible`) in the same WHERE — this predicate
    assumes an already-validated non-NULL, non-empty JSON array, mirroring
    `dead_band_admissible`'s own cross-reference to `answer_key_present`.

    `s` is cast to Float, not Integer — same reasoning as
    `dead_band_admissible`'s `b`/`s` cast: an integer cast of a non-integer
    text value raises in Postgres. `sm` stays Integer-cast (a whole number,
    only null-checked and sign-compared).

    Args:
        missed_pv_lines_col: A JSONB column/expression, typically
            `GameFlaw.missed_pv_lines` — already validated non-NULL/non-empty
            by `answer_key_present` in the same WHERE.
        ply_col: A column/expression resolving to the ply integer, typically
            `GameFlaw.ply`.

    Returns:
        A SQLAlchemy ColumnElement[bool]: True when the node-0 runner-up does
        NOT leave the mover clearly winning (>= SECOND_BEST_WINNING_FLOOR_CP
        cp, or an outright mate for the mover).
    """
    node0 = missed_pv_lines_col[0]
    second_uci = node0["su"].astext
    mover_color = mover_color_expr(ply_col)
    second_cp = cast(node0["s"].astext, Float)
    second_mate = cast(node0["sm"].astext, Integer)
    cp_sign = case((mover_color == "white", 1.0), else_=-1.0)
    mate_sign = case((mover_color == "white", 1), else_=-1)
    second_cp_mover = cp_sign * second_cp
    second_mate_mover = mate_sign * second_mate
    return or_(
        second_uci == "",
        and_(second_mate.isnot(None), second_mate_mover < 0),
        and_(
            second_mate.is_(None),
            or_(second_cp.is_(None), second_cp_mover < SECOND_BEST_WINNING_FLOOR_CP),
        ),
    )


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
            dead_band_admissible(GameFlaw.missed_pv_lines, GameFlaw.ply),
            second_best_not_winning_admissible(GameFlaw.missed_pv_lines, GameFlaw.ply),
            expected_score >= WINNABILITY_FLOOR_ES,
        )
    )


# The 5-move ladder's first/last index — named rather than bare `0`/`4` so
# the query-time gate below reads as "best" and "worst-of-five", not magic
# offsets (CLAUDE.md "no magic numbers"). `_PV_WORST_INDEX` is derived from
# `HERRING_LADDER_SIZE` so it can never drift out of sync with the ladder
# shape the `ck_herring_pool_ladder_shape` CHECK enforces.
_PV_BEST_INDEX: int = 0
_PV_WORST_INDEX: int = HERRING_LADDER_SIZE - 1


def _ladder_field(ladder_element: Any, field: str) -> ColumnElement[int]:
    """Extract an integer `field` ("cp" or "mate") from a JSONB ladder element.

    `ladder_element` is either an indexed element of `HerringPool.ladder`
    (e.g. `HerringPool.ladder[_PV_BEST_INDEX]`) or a per-row element yielded
    by `jsonb_array_elements(HerringPool.ladder)` in a correlated subquery —
    both resolve to a JSONB object shaped `{"move_uci": str, "cp": int |
    null, "mate": int | null}` (see `HerringPool.ladder`'s model docstring).
    `->>` on a missing or JSON-null key resolves to SQL NULL, which is
    exactly the "absent" signal `expected_score_sql` already expects — no
    special-casing needed here.

    Args:
        ladder_element: A JSONB-typed expression for one ladder entry.
        field: "cp" or "mate".

    Returns:
        A SQLAlchemy Integer column expression, or SQL NULL when the key is
        absent or JSON-null.
    """
    return cast(ladder_element[field].astext, Integer)


def _ladder_element_es(ladder_element: Any, mover_color_col: Any) -> ColumnElement[float]:
    """Mover-POV expected score for one ladder element, via the shared sigmoid.

    Delegates entirely to `expected_score_sql` — the single shared
    `LICHESS_K` sigmoid implementation already used by `pool_entry_stmt` and
    `blob_pending_stmt`. Declaring a second sigmoid here would risk silent
    disagreement with the first at exactly the threshold boundary
    `herring_stmt`'s query-time gate lives on.

    Args:
        ladder_element: A JSONB-typed expression for one ladder entry (see
            `_ladder_field`).
        mover_color_col: A column/expression resolving to 'white'/'black'
            (`HerringPool.mover_color` — the side to move on the generator's
            own searched board, D-16).

    Returns:
        A SQLAlchemy ColumnElement[float] in (0, 1), or NULL when the
        element carries neither cp nor mate.
    """
    return expected_score_sql(
        _ladder_field(ladder_element, "cp"), _ladder_field(ladder_element, "mate"), mover_color_col
    )


def herring_stmt(user_id: int, *, exclude_served: bool = True) -> Select[tuple[HerringPool]]:
    """Red-herring source candidates for `user_id` (POOL-03, amended Phase 192).

    Phase 192 replaces the structurally-broken pre-Phase-192 `GameBestMove`
    source with `herring_pool` — a global, phase-balanced pool of positions
    confirmed by a real MultiPV-5 Stockfish search
    (`scripts/gen_red_herring_pool.py`). A
    red herring is "several genuinely fine moves for whoever is to move",
    drawn across ALL signed-up users' games, not "one of the user's own
    several-fine-moves plies". Winnability (`WINNABILITY_FLOOR_ES`) is
    enforced once at generation time against the generator's own MultiPV[0]
    on its own searched board — never re-checked here, and never derived
    from a correlated `game_positions` read (SEED-120 Pitfall 1's
    `ply`/`ply - 1` ambiguity does not apply: the generator's board is
    authoritative by construction). There is no SR bookkeeping in this
    function at all (no `drill_items`, no `GameFlaw` join) — the pool is
    entirely separate material from a user's own blunders.

    D-15 loose-generation / tight-query split, both constants named: the
    generator applies a deliberately LOOSE gate at write time
    (`HERRING_LOOSE_BAND_ES`, `HERRING_MIN_QUALIFYING_MOVES`) so a stored row
    is a superset of what could ever qualify at serve time. THIS function
    applies the real, tight, retunable-with-zero-re-analysis gate over the
    raw stored `ladder`:

    - **Qualifying count** (D-15): at least `HERRING_MIN_QUALIFYING_MOVES` of
      the 5 ladder entries must be within `INACCURACY_DROP` expected-score
      points of PV[0] (the best move). PV[0] always satisfies its own
      predicate (gap 0.0 to itself), so a count of 2 means "the best plus one
      genuinely fine alternative" — not "two alternatives besides the best".
      The comparison is STRICT (`<`, not `<=`), and that direction is
      load-bearing: `flaws_service._classify_severity` classifies a drop as
      an inaccuracy at `drop >= INACCURACY_DROP`, so a move exactly
      `INACCURACY_DROP` below the best is already an inaccuracy and must not
      count as one of the "several fine moves" this gate exists to certify.
    - **Degenerate exclusion** (D-17): PV[4]'s (the worst-of-five's) expected
      score must be at least `HERRING_DEGENERATE_MIN_GAP_ES` below PV[0]'s,
      INCLUSIVE at the bound (`>=`) — a dead-drawn or totally-winning
      position where even the fifth-best move is fine is not a judgment
      test, and MultiPV-5 exists precisely to catch it. Kept at QUERY time
      rather than baked into generation: retunable without re-analysis, and
      later auditable for over-aggressiveness, because the raw 5-move ladder
      always survives on the row (D-16 forbids a pre-converted
      expected-score/gap column, so the stored `game_positions.eval_cp` can
      never leak back in as an authoritative value here).

    Both thresholds are computed from the raw stored ladder through
    `_ladder_element_es` (a thin wrapper over `expected_score_sql`, the
    single shared sigmoid) — mate is mapped via `MATE_CP_EQUIVALENT` before
    the sigmoid (Option-B), matching every other mover-POV conversion in this
    module. No second sigmoid is declared and no rounding/truncation step is
    introduced anywhere in this gate.

    No `jsonb_typeof` shape guard is added anywhere here, deliberately:
    `ck_herring_pool_ladder_shape` (a write-time CHECK on `herring_pool`)
    makes "a complete 5-element JSON array" a structural invariant of every
    stored row, so `jsonb_array_elements(HerringPool.ladder)` and indexed
    access (`HerringPool.ladder[_PV_BEST_INDEX]`,
    `HerringPool.ladder[_PV_WORST_INDEX]`) are TOTAL on this column. Pairing
    a type guard with an array function in the same WHERE clause is a
    documented live crash in this codebase — Postgres does not guarantee
    AND-clause evaluation order (see `answer_key_present`'s docstring).
    Enforce shape at write time, never re-check it at read time.

    `.options(undefer(HerringPool.ladder))` is mandatory: `ladder` is
    `deferred=True` by design (structural leak guard, mirroring
    `GameFlaw.missed_pv_lines`) and would otherwise raise `MissingGreenlet`
    on first implicit async access outside this query's session context.

    Ordering is a TOTAL order, stable across repeated executions of the same
    statement — which is what makes "no repeats until the pool is exhausted"
    observable:
    `(qualifying_count >= HERRING_PREFERRED_QUALIFYING_MOVES) DESC` (D-15's
    "preferring 3+" — a PREFERENCE, not a filter; rows with exactly
    `HERRING_MIN_QUALIFYING_MOVES` must still be reachable), then
    `HerringPool.source_played_at DESC NULLS LAST`, then `HerringPool.id
    ASC` (the deterministic tiebreak for rows equal on both prior keys).
    Recency reads off the pool row's own denormalized `source_played_at`
    rather than a `games` join: SEED-120 carries the recency ordering
    forward, but a global pool cannot join `games` for it without
    reintroducing exactly the link D-01 lets null out. Copying `played_at`
    onto the row at generation time preserves the recency contract and
    survives source-game deletion — the same reasoning D-03 already applies
    to the FEN and arriving move. This is a deliberate resolution, not a
    dropped requirement.

    D-10: this function NEVER filters on `HerringPool.user_id` — a user may
    legitimately be served a herring drawn from their own game (own-game
    herrings are permitted; composition drops one only when it collides with
    an SR pick in the same session, `app/repositories/train_repository.py`'s
    `_ReconstructedPuzzle` assembly).

    Exhaustion contract (unchanged): when a caller's `exclude_served=True`
    query returns no rows, it re-runs with `exclude_served=False` to allow
    repeats — that fallback lives with this query's contract, not duplicated
    at call sites.

    Args:
        user_id: Authenticated user's internal PK (V4: never client-supplied
            — callers must source this from `current_active_user.id`). Used
            ONLY to scope the `exclude_served` no-repeat exclusion below —
            never as a `HerringPool` row filter (D-10).
        exclude_served: When True (default), exclude any `HerringPool.id`
            already served to this user as a red herring
            (`drill_solves.herring_pool_id`, D-04 — NOT `(game_id, ply)`,
            which can no longer serve as a stable identity once the source
            game link is nullable). Set False to allow repeats once the
            source is exhausted.

    Returns:
        A SQLAlchemy Select yielding qualifying, non-degenerate `HerringPool`
        rows in the total order described above.
    """
    best_es = _ladder_element_es(HerringPool.ladder[_PV_BEST_INDEX], HerringPool.mover_color)
    worst_es = _ladder_element_es(HerringPool.ladder[_PV_WORST_INDEX], HerringPool.mover_color)

    # A correlated per-row scan of the raw ladder (jsonb_array_elements is
    # TOTAL on this column, no shape guard needed — see the docstring above).
    # `column("value", JSONB)` names the function's own builtin output
    # column so `.c.value` reads naturally.
    ladder_element = func.jsonb_array_elements(HerringPool.ladder).table_valued(
        column("value", JSONB)
    )
    element_es = _ladder_element_es(ladder_element.c.value, HerringPool.mover_color)

    qualifying_count = (
        select(func.count())
        .select_from(ladder_element)
        .where(best_es - element_es < INACCURACY_DROP)
        .scalar_subquery()
    )

    stmt = (
        select(HerringPool)
        .options(undefer(HerringPool.ladder))
        .where(
            qualifying_count >= HERRING_MIN_QUALIFYING_MOVES,
            best_es - worst_es >= HERRING_DEGENERATE_MIN_GAP_ES,
        )
    )
    if exclude_served:
        stmt = stmt.where(
            ~exists(
                select(DrillSolve.session_id).where(
                    DrillSolve.user_id == user_id,
                    DrillSolve.herring_pool_id == HerringPool.id,
                    DrillSolve.source == DrillSource.RED_HERRING,
                )
            )
        )
    return stmt.order_by(
        (qualifying_count >= HERRING_PREFERRED_QUALIFYING_MOVES).desc(),
        HerringPool.source_played_at.desc().nullslast(),
        HerringPool.id.asc(),
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


_T = TypeVar("_T")


def pick_one_per_game(
    candidates: Sequence[tuple[int, int, _T]],
    *,
    user_id: int,
    session_date: datetime.date,
) -> list[tuple[int, int, _T]]:
    """Cap `candidates` at `MAX_ITEMS_PER_GAME_PER_SESSION` per `game_id` (quick
    task 260728-pgp), picking UNIFORM RANDOM among each game's entries —
    deliberately NOT earliest-ply. Earliest-ply skews the phase mix from a
    measured 16.2/57.6/26.2 (opening/middlegame/endgame) to 32.2/59.6/8.2 —
    doubling the opening share and cutting the endgame share to a third — so
    a uniform pick is what actually reproduces the user's natural blunder
    distribution across a game's candidate plies.

    The seed is namespaced `train-pool-pick:` so this stream is NEVER the
    same sequence as the D-09 composition shuffle in `train_repository.py`
    (which seeds `f"{user_id}:{today.isoformat()}"` with no such prefix) —
    two independently-seeded RNG streams, deliberately kept apart.
    `game_id` is baked INTO the seed (not just `user_id`/`session_date`), so
    a given game's chosen ply is a pure function of user + date + game and
    is independent of how many OTHER games are in the pool or of the pool's
    ordering — adding/removing an unrelated game never reshuffles this
    game's pick. `random.Random` seeded with a `str` is stable across
    processes (CPython hashes `str` seeds with sha512, not the
    `PYTHONHASHSEED`-randomized `hash()`) — the same property the existing
    D-09 shuffle already relies on. This is intentionally NOT pushed into
    SQL: `pool_rows` is already materialized in Python by the time a caller
    has a `candidates` sequence to pass here.

    Groups by `game_id` in FIRST-APPEARANCE order (a plain `dict` preserves
    insertion order), so the caller's own across-games ordering (e.g.
    `Game.played_at DESC`) survives unchanged in the concatenated output —
    only the WITHIN-game choice is randomized. Each game's drawn entries are
    sorted by ply ascending before concatenation (a no-op at cap 1,
    deterministic if the cap is ever raised above 1).

    Args:
        candidates: `(game_id, ply, payload)` tuples — `payload` is
            caller-defined (the ORM `Game` in production, `None` in tests).
        user_id: Authenticated user's internal PK (V4: never client-supplied
            — callers must source this from `current_active_user.id`).
        session_date: The composition's local calendar day (`today`).

    Returns:
        At most `MAX_ITEMS_PER_GAME_PER_SESSION` entries per `game_id`,
        concatenated in first-appearance game order. Empty input yields an
        empty list; a game with exactly one candidate always yields that
        candidate.
    """
    grouped: dict[int, list[tuple[int, int, _T]]] = {}
    for game_id, ply, payload in candidates:
        grouped.setdefault(game_id, []).append((game_id, ply, payload))

    picked: list[tuple[int, int, _T]] = []
    for game_id, group in grouped.items():
        rng = random.Random(f"train-pool-pick:{user_id}:{session_date.isoformat()}:{game_id}")
        take = min(len(group), MAX_ITEMS_PER_GAME_PER_SESSION)
        sampled = rng.sample(group, take)
        sampled.sort(key=lambda entry: entry[1])
        picked.extend(sampled)
    return picked


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
    "MAX_ITEMS_PER_GAME_PER_SESSION",
    "SECOND_BEST_WINNING_FLOOR_CP",
    "SHARP_GAP_ES",
    "WINNABILITY_FLOOR_ES",
    "PuzzleType",
    "answer_key_pending",
    "answer_key_present",
    "blob_pending_stmt",
    "classify_puzzle_type",
    "compose_slots",
    "dead_band_admissible",
    "expected_score_for",
    "expected_score_sql",
    "fen_and_last_move_at_ply",
    "full_fen_at_ply",
    "herring_stmt",
    "pick_one_per_game",
    "pool_entry_stmt",
    "second_best_not_winning_admissible",
]
