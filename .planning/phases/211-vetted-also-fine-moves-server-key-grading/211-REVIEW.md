---
phase: 211-vetted-also-fine-moves-server-key-grading
reviewed: 2026-08-16T00:00:00Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - app/repositories/train_repository.py
  - app/routers/train.py
  - app/schemas/train.py
  - app/services/flaws_service.py
  - app/services/train_pool.py
  - frontend/src/components/train/TrainSolveScreen.tsx
  - frontend/src/components/train/__tests__/TrainReveal.test.tsx
  - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
  - frontend/src/hooks/uciParser.ts
  - frontend/src/hooks/useTrainFreePlay.ts
  - frontend/src/hooks/useTrainGradingEngine.ts
  - frontend/src/hooks/__tests__/uciParser.test.ts
  - frontend/src/hooks/__tests__/useTrainFreePlay.test.ts
  - frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts
  - frontend/src/lib/trainArrows.ts
  - frontend/src/lib/__tests__/trainArrows.test.ts
  - frontend/src/lib/__tests__/trainRevealCache.test.ts
  - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
  - frontend/src/types/train.ts
  - tests/repositories/test_train_repository.py
  - tests/routers/test_train.py
  - tests/services/test_flaws_service.py
  - tests/services/test_train_pool.py
findings:
  critical: 0
  warning: 1
  info: 2
  total: 3
  fixed: 2
  open: 1
status: issues_found
---

# Phase 211: Code Review Report

**Reviewed:** 2026-08-16T00:00:00Z
**Depth:** standard
**Files Reviewed:** 21 (backend: 5 source + 4 test; frontend: 6 source + 8 test)
**Status:** issues_found

## Summary

This phase adds server-side certification of "also fine" alternative moves
(`VettedMove`) and a server-side key-move grading override for Train puzzles,
spanning `train_pool.py` (certification predicates), `train_repository.py`
(`_classify_and_certify_solve`/`record_solve` override wiring), the
`train.py` schema/router additions, and the frontend consumers
(`TrainSolveScreen`, `useTrainFreePlay`, `useTrainGradingEngine`,
`trainArrows.ts`). The rename of `flaws_service._classify_severity` to
`classify_severity` is a clean, mechanical widening (verified both call
sites updated).

I traced the full certification chain (`_vetted_move` → `vetted_moves_from_pv_node`
/ `vetted_moves_from_ladder` → `_classify_and_certify_solve` →
`record_solve`'s key-move override → the wire schema → the frontend badge/
overlay derivation in `TrainSolveScreen`/`trainArrows.ts`/`useTrainFreePlay`)
end-to-end, cross-checking sign/POV conventions against
`eval_apply.py` (confirmed `game_positions.best_move` is genuinely
decision-ply-keyed/un-shifted, as the new code assumes) and against the
existing severity-ladder constants. The mechanism is well tested (dedicated
unit tests for the boundary cases, plus integration tests asserting the
exact wire shape for both the soft/pv-node and herring/ladder paths).

One real gap survived this trace: `vetted_moves_from_pv_node` can return an
empty "also fine" list for a puzzle the server itself still classifies
`"soft"`, contradicting the phase's own stated invariant. Two minor
code-quality items are also noted below.

## Warnings

### WR-01: `vetted_moves_from_pv_node` can serve zero "also fine" moves for a puzzle still classified "soft"

**File:** `app/services/train_pool.py:415-440`
**Issue:**

The Phase 211 "D-01 amendment" was written specifically to guarantee that a
`"soft"` puzzle's `vetted_moves` list is never empty (the whole point of
serving the deep `best_uci` alongside the certified `su`): see the docstring
at `vetted_moves_from_pv_node` ("the best entry is only ever served ALONGSIDE
a certified `su`, so a sharp node never serves a lone best entry either") and
`SolveResponse`'s docstring ("the reveal's legend row + green arrows render
... always empty for sharp/sharp-filler").

However, the fallback that prepends `best_uci` only runs *after* `su` has
already cleared `_vetted_move`'s strict good band:

```python
vetted = _vetted_move(su, best_es, second_es)
if vetted is None:
    return []                      # <-- best_uci is never consulted here
...
if best_uci is not None and best_uci != "" and best_uci != su:
    best_entry = VettedMove(uci=best_uci, quality="best", ...)
    return [best_entry, vetted]
return [vetted]
```

`classify_puzzle_type`'s sharp/soft split uses `SHARP_GAP_ES` (=
`MISTAKE_DROP`, 0.10), while `_vetted_move`'s certification band is the
*strict* `< INACCURACY_DROP` (0.05). Any node whose live `su` gap falls in
`[INACCURACY_DROP, SHARP_GAP_ES)` = `[0.05, 0.10)` is still classified
`"soft"` by `classify_puzzle_type` (0.05 ≤ 0.08 < 0.10, say) but is rejected
by `_vetted_move` (0.08 ≥ INACCURACY_DROP), so `vetted_moves_from_pv_node`
returns `[]` regardless of whether `best_uci` is known — the exact "empty
Also fine row under the several-fine-moves copy" bug this phase set out to
fix, just reached from a different node shape than the one the fix
addresses (su coinciding with the client's own best/played arrow).

Session composition normally prevents a node from reaching this state at
*serve* time (`dead_band_admissible` requires the live gap to be `< 0.05` or
`>= BLUNDER_DROP (0.15)` before an item is composed into a session, and
`_select_candidates`'s due-item rescan re-applies the same predicate), so
this is not reachable on a freshly composed puzzle. But
`_classify_and_certify_solve` reads the *live* blob at solve time, not a
composition-time snapshot (by design — see its own docstring: "a
reclassified-away flaw naturally falls through ... rather than failing the
solve"). If a background reclassification rewrites `missed_pv_lines` between
session composition and the user's actual solve submission (a session can
stay open/resumable for its whole `expires_on` window) such that the live
gap lands in `[0.05, 0.10)`, the puzzle is served to the user as `"soft"`
("Several fine moves") with a completely empty vetted set at solve/reveal
time — no green arrow, no "Also fine" row, and no key-move override is even
possible for that attempt.

This exact case (soft classification + non-empty `su` that fails
certification + a known `best_uci`) has no unit test; the existing
`test_sharp_node_stays_empty_even_with_best_uci` only covers the (correctly
empty) sharp case, and `test_gap_exactly_at_band_is_excluded` only exercises
the boundary without a `best_uci` argument.

**Fix:** When `su` fails to certify but `best_uci` is known and non-empty,
serve `[best_entry]` alone (the deep best, quality `"best"`) instead of `[]`
— consistent with the guarantee already stated for the codebase's other
"soft, but nothing else to show" case:

```python
vetted = _vetted_move(su, best_es, second_es)
if vetted is None:
    if best_uci is not None and best_uci != "":
        return [VettedMove(uci=best_uci, quality="best", es_before=best_es, es_after=best_es)]
    return []
```

**Resolution:** Fixed in `6c57bfa83`. The fallback is additionally gated on
`best_es - second_es < SHARP_GAP_ES` (the exact mirror of
`classify_puzzle_type`'s split) — the suggested unconditional fallback would
have served a lone best entry for SHARP nodes too, breaking
`test_sharp_node_stays_empty_even_with_best_uci` and the documented sharp
contract. Red-first regression tests added
(`test_soft_node_uncertified_su_serves_lone_best_entry`,
`test_soft_node_uncertified_su_without_best_uci_stays_empty`).

## Info

### IN-01: Dead code path — `_vetted_move`'s `"inaccuracy"` quality branch is currently unreachable

**File:** `app/services/train_pool.py:360-367`
**Issue:** `_vetted_move` returns `None` immediately whenever
`best_es - move_es >= INACCURACY_DROP`, so the subsequent
`classify_severity(best_es - move_es)` call can only ever be invoked with a
drop strictly below `INACCURACY_DROP` — under the current constants (
`INACCURACY_DROP <= MISTAKE_DROP <= BLUNDER_DROP`), `classify_severity` is
therefore guaranteed to return `None` every time it's called here, so the
`if severity == "inaccuracy": return VettedMove(..., quality="inaccuracy", ...)`
branch can never execute. The docstring for this function explicitly
acknowledges this ("Under today's strict band only `"good"` is reachable")
and frames it as deliberate forward-compatibility (retunable band without a
wire change), so this is not a functional bug — just worth flagging since a
future reader tracing why `VettedMove.quality` never observes `"inaccuracy"`
in production data would otherwise have to re-derive this reasoning from
scratch.
**Fix:** None required; consider a short comment at the call site itself (not
just the docstring) noting the branch is presently unreachable, or a
regression test asserting `_vetted_move` never returns an `"inaccuracy"`
quality under the current thresholds, so a future threshold change that
silently makes it reachable is a deliberate, reviewed decision rather than a
side effect.

**Resolution:** Not fixed — documented intentional forward-compatibility
(per the finding's own "None required"); left as-is.

### IN-02: Redundant re-narrowing ternary

**File:** `app/repositories/train_repository.py:2161`
**Issue:** `mover: Literal["white", "black"] = "white" if pool_row.mover_color == "white" else "black"`
re-derives a value that `pool_row.mover_color` (per the surrounding comment,
"the STORED `HerringPool.mover_color` column") should already hold as one of
exactly those two strings. The ternary adds no behavior beyond a type
narrowing and slightly obscures that `pool_row.mover_color` is trusted
verbatim everywhere else in this module (e.g. `vetted_moves_from_ladder`'s
own docstring calls it "the STORED ... column ... NEVER ply parity").
**Fix:** If the column's Python type is a bare `str`, prefer
`cast(Literal["white", "black"], pool_row.mover_color)` (matching the
`cast(Literal["white", "black"], pool_row.mover_color)` pattern already used
for `_ReconstructedPuzzle.side_to_move` a few hundred lines earlier in this
same file) over a ternary that silently maps any non-`"white"` value
(including a corrupt one) to `"black"`.

**Resolution:** Fixed in `320163606` — ternary replaced with
`cast(Literal["white", "black"], pool_row.mover_color)` plus a short
comment referencing the `_ReconstructedPuzzle.side_to_move` pattern.

---

_Reviewed: 2026-08-16T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
