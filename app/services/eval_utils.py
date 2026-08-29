"""Pure-math conversion: Stockfish eval (signed cp or mate-in-N) -> user expected score.

Used by Phase 83's Stockfish-baseline predicted endgame score (SEED-014, D-01..D-03).
The aggregator (Plan 2) and the benchmark CTE (Plan 4) convert each endgame's
entry-eval into a per-game expected score in [0, 1], then average to compare with
the user's actual endgame score.

Two converters, deliberately split (D-02):

  eval_cp_to_expected_score    Lichess winning-chances sigmoid over centipawns.
  eval_mate_to_expected_score  Direct 0/1 mapping (mate is not sigmoid-routed).

Sign convention mirrors app/services/endgame_service.py:_classify_endgame_bucket:
the raw eval is white-perspective, and a `sign = +1 if user_color == "white"
else -1` flip yields the user-perspective value. Verified by the symmetry test
f(+x, "white") + f(+x, "black") == 1.0.

Sigmoid constant:
  LICHESS_K = 0.00368208 is the published Lichess winning-chances coefficient
  used in their accuracy / winning-chances formula. See:
    https://lichess.org/page/accuracy
  i.e. winning_chances(cp) = 1 / (1 + exp(-K * cp)), centered at 0 -> 0.5,
  saturating to ~0.997 at +1500 cp and ~0.003 at -1500 cp.

Mate handling (D-02, Pitfall 1):
  Mate scores are NOT routed through the sigmoid. A mate-in-N for the side
  that is winning maps to 1.0 from that user's perspective; from the opposing
  user's perspective it maps to 0.0. The distance to mate (N) is irrelevant
  to the expected-score calculation.

No I/O, no DB, stdlib only. The module is unit-testable in isolation; see
tests/services/test_eval_utils.py.

Phase 212 BENCHLANE-05 (D-03) also adds derive_is_lichess_eval_game, the
single derivation point for the is_lichess_eval_game boolean used across the
eval pipeline. It is placed in this module (rather than eval_apply.py, where
CONTEXT.md originally proposed it) because this is a genuine leaf -- it
imports nothing from app.services/app.repositories/app.models, so adding
app.core.config here creates no import cycle with eval_queue_service.py,
eval_apply.py, eval_drain.py, library_service.py, or eval_remote.py, all of
which need to call it.

Phase 212 BENCHLANE-02/D-09 (212-07) relocates BENCHMARK_SELECTION_GATE_SQL_TEMPLATE
and selection_gate_clause() here from eval_queue_service.py for the identical
reason: this leaf module is the one place eval_queue_service.py, eval_entry.py,
and eval_remote.py can all reach the gate helper without an import cycle --
eval_entry.py and eval_remote.py both need it to gate the fifth (entry-ply)
lottery lane in lock-step with the four lanes eval_queue_service.py already
gates, and neither of those two modules could previously import a private
helper out of eval_queue_service.py without one.
"""

import math
from datetime import datetime
from typing import Literal

from app.core.config import settings

# Lichess winning-chances sigmoid coefficient (sourced from Lichess accuracy page).
# Kept as a module-level named constant (CLAUDE.md "no magic numbers") so that
# Plan 4's SQL CTE and Plan 2's aggregator reference the same canonical value.
LICHESS_K: float = 0.00368208


def eval_cp_to_expected_score(
    eval_cp: int,
    user_color: Literal["white", "black"],
) -> float:
    """Convert a signed centipawn eval to a user-perspective expected score in (0, 1).

    Args:
        eval_cp: White-perspective centipawn eval (Stockfish / python-chess
            convention). Positive means white is ahead, negative means black.
        user_color: "white" or "black" — used to flip sign so positive output
            means the user is ahead. f(+100, "white") ~ 0.591;
            f(+100, "black") ~ 0.409.

    Returns:
        Expected score in (0, 1): 0.5 at cp == 0, saturating near 1.0 / 0.0
        at large positive / negative cp from the user's perspective.

    Sign convention matches app/services/endgame_service.py:_classify_endgame_bucket
    (sign = +1 for white user, -1 for black user). See the white/black symmetry
    test in tests/services/test_eval_utils.py.
    """
    sign = 1 if user_color == "white" else -1
    return 1.0 / (1.0 + math.exp(-LICHESS_K * sign * eval_cp))


def eval_mate_to_expected_score(
    eval_mate: int,
    user_color: Literal["white", "black"],
) -> float:
    """Convert a mate-in-N eval to a user-perspective expected score (exactly 0.0 or 1.0).

    Args:
        eval_mate: White-perspective mate score. Positive (e.g. +5) means white
            has a forced mate; negative (e.g. -5) means black has one. The
            magnitude (distance to mate) is irrelevant for the expected score.
        user_color: "white" or "black".

    Returns:
        1.0 iff the side with the forced mate equals user_color, else 0.0.

    Mate is NOT routed through the sigmoid (D-02): a forced mate is a terminal
    evaluation, and the sigmoid would compress mate-in-1 and mate-in-30 to
    different values which is the wrong semantics for expected-score averaging.

    Pitfall 1 coverage: both `(eval_mate > 0, user_color == "white") -> 1.0`
    and `(eval_mate < 0, user_color == "black") -> 1.0` are exercised by
    tests/services/test_eval_utils.py::TestMate. Phase 82 was bitten by an
    asymmetric sign bug that single-color tests would have missed.
    """
    if eval_mate > 0 and user_color == "white":
        return 1.0
    if eval_mate < 0 and user_color == "black":
        return 1.0
    return 0.0


def derive_is_lichess_eval_game(lichess_evals_at: datetime | None) -> bool:
    """THE single derivation point for is_lichess_eval_game (Phase 212 D-03).

    Replaces SEVEN independent derivations of this boolean that existed
    before Phase 212 BENCHLANE-05, in three syntactic shapes:

      Shape A (attribute read compared to None):
        1. app/services/eval_queue_service.py — the tier-1/2 claim path that
           populates AtomicLeaseResponse.is_lichess_eval_game.
        2. app/routers/eval_remote.py — the /flaw-blob-lease path.
        3. app/services/eval_drain.py — the tier-4b divergence-guard-parity
           rebuild.
        4. app/services/eval_apply.py — the best-move rebuild path (the only
           one originally named by CONTEXT.md's D-03).

      Shape B (derived off a scalar_one_or_none() result under a
      differently-named local):
        5. app/services/eval_queue_service.py — _claim_tier3_derived Step 2
           (local lichess_result). Tier-3 is the lane the benchmark
           selection gate (212-01/212-02) drives.
        6. app/services/eval_queue_service.py — the tier-4b best-move
           lottery (local lichess_at_4b, variable is_lichess_4b).

      Shape C (inline keyword argument at a read-path call site):
        7. app/services/library_service.py — the is_lichess_eval_game=
           keyword passed to classify_best_move (the "Imported-eval
           divergence guard", Quick 260717-gmg).

    With BENCHMARK_HOMOGENIZE_EVAL_SOURCE False (prod, always), this returns
    exactly `lichess_evals_at is not None` -- the pre-Phase-212 behavior at
    every one of the seven sites, byte-for-byte. With the flag True (the
    benchmark-only override), this returns False unconditionally, including
    for a non-None timestamp -- see the flag's own docstring in
    app/core/config.py for the write-path and read-path consequences.

    Adding a second derivation of this boolean anywhere in the codebase (or a
    second override deeper in the call stack) is exactly the drift D-03
    forbids: two overrides that could disagree would silently re-introduce
    the eval-source confound this flag exists to remove. See
    tests/services/test_eval_utils.py::test_no_bare_lichess_evals_at_derivation_remains,
    an AST-based regression test that fails if an eighth derivation appears.
    """
    if settings.BENCHMARK_HOMOGENIZE_EVAL_SOURCE:
        return False
    return lichess_evals_at is not None


def derive_raw_lichess_eval_game(lichess_evals_at: datetime | None) -> bool:
    """The UNHOMOGENIZED lichess-eval-game signal (tier3-branch-b-one-ply-stamp
    debug fix): `lichess_evals_at is not None`, ALWAYS -- ignores
    BENCHMARK_HOMOGENIZE_EVAL_SOURCE entirely, unlike derive_is_lichess_eval_game
    above.

    This is a DIFFERENT question from derive_is_lichess_eval_game, not a second
    derivation of the same one (the D-03 docstring's drift warning is about the
    latter). derive_is_lichess_eval_game answers "should downstream WRITE logic
    preserve this game's stored %eval as authoritative" -- a decision
    BENCHMARK_HOMOGENIZE_EVAL_SOURCE deliberately forces False so the benchmark's
    homogenized-source engine pass can overwrite lichess data (app/core/config.py's
    docstring: "the drain write path store our own engine's eval_cp instead of
    preserving lichess's").

    This function instead answers a homogenization-INVARIANT, physical question:
    "does game_positions.eval_cp/eval_mate for this game currently hold data
    written by lichess IMPORT rather than by our own engine pipeline". BENCHLANE-05
    D-04 deliberately never changes games.lichess_evals_at or the raw %eval columns
    when homogenization is on -- only the derived is_lichess_eval_game boolean is
    overridden. So under homogenization, this function and derive_is_lichess_eval_game
    diverge (True vs False) for exactly the games homogenization targets; without
    homogenization they always agree.

    Two SEED-076-era read-path heuristics wrongly used is_lichess_eval_game (the
    homogenizable one) to decide whether an already-populated eval_cp/eval_mate
    value is trustworthy evidence of "already resolved by a PRIOR ROUND OF THIS
    PIPELINE" -- true for a genuine engine game, but false for a homogenized
    lichess-arm game until our engine has actually overwritten that ply:

    - `_lease_position_redundant` / `_build_lease_positions` (app/routers/eval_remote.py,
      SEED-076): the incremental-lease redundancy filter.
    - `_is_engine_hole` / `_count_prior_holes` (app/services/eval_apply.py): the
      incremental-submit hole-counting guard (`preserve_existing_evals`).

    Under BENCHMARK_HOMOGENIZE_EVAL_SOURCE, both call sites read
    is_lichess_eval_game=False for a lichess-arm game and wrongly trusted its
    import-populated eval_cp as "prior-round-resolved" -- the lease collapsed to
    exactly one position (the first ply, whose predecessor row doesn't exist) and
    the hole count came back 0, stamping both completion markers after a single
    analyzed ply, independent of game length. Both call sites must consult THIS
    function (in addition to derive_is_lichess_eval_game, which they still need for
    the write-preservation / include_terminal decisions) to decide whether that
    "already resolved by a prior pipeline round" trust is warranted. See the
    tier3-branch-b-one-ply-stamp debug session (.planning/debug/resolved/) for the
    full investigation.
    """
    return lichess_evals_at is not None


# Phase 212 BENCHLANE-02/D-09/D-10: benchmark full-game-analysis lane selection
# gate. A hardcoded, trusted SQL literal (QUEUE-08 convention -- never derived
# from request/user input) narrowing a lottery/claim candidate to games present
# in benchmark_selection. Moved here from eval_queue_service.py by 212-07 (see
# this module's docstring) when the entry-ply lane needed the same helper.
#
# {alias} is the ONLY formattable field -- it names the unaliased or aliased
# `games` table reference each call site already uses (tier-3/tier-4/tier-4b in
# eval_queue_service.py all query `games g`; the entry-ply probe and claim in
# eval_remote.py / eval_entry.py both query `games` with no alias at all, hence
# the "games" alias those two callers pass explicitly).
# `bs.armed` is what closes the select/snapshot publish-before-protect window
# (see app/models/benchmark_selection.py's `armed` docstring). `select` inserts
# unarmed rows that no lane can see; `arm_tranche` flips them only once every
# lichess-arm game in the tranche has snapshot rows, so a worker can never
# overwrite an eval whose original value is not yet preserved. Forgetting to arm
# stops the drain, which is loud; the pre-armed behaviour corrupted the recovery
# table silently instead.
BENCHMARK_SELECTION_GATE_SQL_TEMPLATE = (
    "AND EXISTS (SELECT 1 FROM benchmark_selection bs WHERE bs.game_id = {alias}.id AND bs.armed)"
)


def selection_gate_clause(alias: str = "g") -> str:
    """Return the benchmark-selection gate fragment for the given table alias, or "" when off.

    Must be called (never memoized at module load) so the flag is read per call
    -- tests can monkeypatch settings.BENCHMARK_SELECTION_GATE_ENABLED and see
    the change take effect on the next call. When the flag is off this returns
    exactly "" -- no whitespace, no "AND TRUE" -- so every call site's
    interpolated SQL string stays byte-identical to the pre-gate baseline
    (D-10 point 1).

    Args:
        alias: the table alias/name the fragment's EXISTS correlates against
            (default "g", matching the four pre-existing tier-3/tier-4/tier-4b
            call sites in eval_queue_service.py -- changing this default would
            break their byte-identity pins in tests/services/test_eval_queue.py).
            The entry-ply probe and claim (eval_remote.py / eval_entry.py) pass
            "games" explicitly, since both reference the table unaliased.
    """
    if settings.BENCHMARK_SELECTION_GATE_ENABLED:
        return BENCHMARK_SELECTION_GATE_SQL_TEMPLATE.format(alias=alias)
    return ""
