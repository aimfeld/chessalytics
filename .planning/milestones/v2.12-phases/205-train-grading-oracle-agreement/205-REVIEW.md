---
phase: 205-train-grading-oracle-agreement
reviewed: 2026-08-04T17:35:57Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - app/repositories/query_utils.py
  - app/services/train_pool.py
  - app/repositories/train_repository.py
  - tests/repositories/test_query_utils.py
  - tests/services/test_train_pool.py
  - tests/repositories/test_train_repository.py
  - tests/routers/test_train.py
  - frontend/src/hooks/uciParser.ts
  - frontend/src/hooks/useTrainGradingEngine.ts
  - frontend/src/hooks/useTrainFreePlay.ts
  - frontend/src/components/train/TrainSolveScreen.tsx
findings:
  critical: 0
  warning: 0
  info: 0
  total: 0
status: clean
---

# Phase 205: Train Grading Oracle Agreement Code Review Report

**Reviewed:** 2026-08-04T17:35:57Z
**Depth:** standard
**Files Reviewed:** 11 source files (+ 4 associated test files read for coverage cross-checks)
**Status:** clean

## Summary

Phase 205 ships two independent, sequenced changes: a frontend fix (root free-play
grading reads from the settled mount search's own rank line instead of a fresh
post-move search) and a backend fix (a shared `dead_band_admissible` predicate excludes
Train drill items whose node-0 best-vs-second drop sits in the noisy `[0.05, 0.15)`
band, applied identically at all three SR selection sites).

I traced the specific hazards called out in the review brief and did not find a
defect clearing the report bar (file:line + concrete wrong-outcome scenario):

- **`dead_band_admissible` / `mover_color_expr` SQL correctness** — every clause in
  `dead_band_admissible` (`app/services/train_pool.py:384-401`) is a total operator
  (`jsonb_typeof`, `isnot(None)`, `!=`, numeric compare); JSONB `->`/`->>` on a
  non-object, out-of-bounds, or JSON-null node returns SQL NULL rather than raising, so
  the predicate is safe regardless of Postgres's unspecified AND-clause evaluation
  order — matching the same discipline `answer_key_present`'s docstring already
  establishes and that this module's own tests exercise directly
  (`test_non_dict_node_is_absent`, `test_json_null_node_is_absent_and_raises_nothing`
  in `tests/services/test_train_pool.py`). Mover color is derived identically via
  `mover_color_expr` (`app/repositories/query_utils.py:74-101`), matching the Python
  twin `mover_color_for_ply` (even ply → white), and is verified against it directly
  in `TestMoverColorExpr` (`tests/repositories/test_query_utils.py:175-198`).
  The predicate composes identically (same two-call pairing with `answer_key_present`)
  at all three call sites I located: `pool_entry_stmt`
  (`app/services/train_pool.py:528`), `due_stmt` inside
  `compose_and_materialize_session` (`app/repositories/train_repository.py:1513-1523`),
  and `get_waiting_puzzle_count`'s due-count statement
  (`app/repositories/train_repository.py:989-990`) — no drift between sites.
- **Band boundary semantics** — `or_(gap >= BLUNDER_DROP, gap < INACCURACY_DROP)`
  correctly implements "outside `[INACCURACY_DROP, BLUNDER_DROP)`": exactly
  `INACCURACY_DROP` is excluded (not `<`), exactly `BLUNDER_DROP` is kept (`>=`).
  Confirmed both algebraically and against the 12 `TestDeadBandAdmissible` tests,
  which construct the boundary via the exact sigmoid inverse and pin both edges plus
  one-cp-either-side. The float-vs-integer cast split (`b`/`s` → `Float`, `bm`/`sm` →
  `Integer`) is deliberate and documented, and `test_integer_valued_in_band_blob_is_absent`
  confirms the float cast doesn't regress the ordinary integer-valued case.
- **`currentQuality`'s root-only branch** (`frontend/src/hooks/useTrainFreePlay.ts:289-326`)
  — `currentNode.parentId === null` is the correct discriminator (per
  `useAnalysisBoard.ts`'s own contract: "`parentId: null` means the parent is
  rootFen", i.e. that node IS the first free-play move). The branch is gated ahead of
  the `terminal` check in the right order, and when `rankLineForSquares` returns null
  (unranked move, or non-root ply), `childCp`/`childMate` fall through to `liveCp`/
  `liveMate` — the pre-existing free-play-engine path — never throwing and never
  silently misgrading. `ORACLE-02`
  (`frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx:1667-1709`)
  exercises exactly the boundary (a mount-rank move replayed at ply 3) and the D-10
  test (`:1315-1354`) exercises the lines-absent fallback end-to-end with a real
  scripted worker, not just a symbol-presence check.
- **`rankLineForMove` / `rankLineForSquares`** — the from+to squares-only match
  (`slice(0, 4)` on the candidate's `moves[0]`) correctly tolerates a promotion suffix
  `MoveNode` doesn't store, ties resolve to the first (lowest-multipv) array match by
  construction (`Array.prototype.find`), and `noUncheckedIndexedAccess` is respected
  throughout (`l.moves[0]?.slice(0, 4)`, `.find(...) ?? null`). `rankLineForMove` was
  relocated with its body unchanged and is pinned by a dedicated test
  (`frontend/src/hooks/__tests__/uciParser.test.ts:205-212`) to never match on squares
  alone, keeping the two contracts from silently converging as the code comment warns.
- **Magic numbers** — no new unnamed threshold/limit literals found in the reviewed
  diff; the band bounds reuse the existing `INACCURACY_DROP`/`BLUNDER_DROP` constants,
  and the frontend changes introduce no new numeric constants at all.

I also spot-checked the retuned test fixtures (`_MISSED_PV_LINES` in
`test_train_repository.py`/`test_train.py`, gap ≈ 0.0092 via the LICHESS_K sigmoid,
correctly now outside the band) and the new `_BANDED_PV_LINES` fixture (gap ≈ 0.0643,
correctly inside `[0.05, 0.15)`) — both retunes are numerically correct, not just
plausible-looking.

All reviewed files meet quality standards. No issues found.
